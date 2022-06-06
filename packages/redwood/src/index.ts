import {
  join,
  delimiter,
  dirname,
  relative,
  parse as parsePath,
  sep,
  basename as pathBasename,
} from 'path';
import { readFileSync, lstatSync, existsSync } from 'fs';
import { intersects, validRange } from 'semver';
import {
  Lambda,
  Files,
  download,
  glob,
  debug,
  getNodeVersion,
  getSpawnOptions,
  runNpmInstall,
  runPackageJsonScript,
  execCommand,
  File,
  FileBlob,
  FileFsRef,
  PackageJson,
  getLambdaOptionsFromFunction,
  readConfigFile,
  isSymbolicLink,
  scanParentDirs,
  NodejsLambda,
  BuildV2,
  PrepareCache,
} from '@vercel/build-utils';
import { nodeFileTrace } from '@vercel/nft';
import { getTransformedRoutes, Route } from '@vercel/routing-utils';

interface RedwoodToml {
  web: { port?: number; apiProxyPath?: string };
  api: { port?: number };
  browser: { open?: boolean };
}

// Do not change this version for RW specific config,
// it refers to Vercels builder version
export const version = 2;

export const build: BuildV2 = async ({
  workPath,
  files,
  entrypoint,
  meta = {},
  config = {},
}) => {
  await download(files, workPath, meta);

  Object.keys(process.env)
    .filter(key => key.startsWith('VERCEL_'))
    .forEach(key => {
      const newKey = `REDWOOD_ENV_${key}`;
      if (!(newKey in process.env)) {
        process.env[newKey] = process.env[key];
      }
    });

  const { installCommand, buildCommand } = config;
  const mountpoint = dirname(entrypoint);
  const entrypointFsDirname = join(workPath, mountpoint);
  const nodeVersion = await getNodeVersion(
    entrypointFsDirname,
    undefined,
    config,
    meta
  );

  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  if (!spawnOpts.env) {
    spawnOpts.env = {};
  }
  const { cliType, lockfileVersion } = await scanParentDirs(
    entrypointFsDirname
  );
  if (cliType === 'npm') {
    if (
      typeof lockfileVersion === 'number' &&
      lockfileVersion >= 2 &&
      (nodeVersion?.major || 0) < 16
    ) {
      // Ensure that npm 7 is at the beginning of the `$PATH`
      spawnOpts.env.PATH = `/node16/bin-npm7${delimiter}${spawnOpts.env.PATH}`;
      console.log('Detected `package-lock.json` generated by npm 7...');
    }
  } else if (cliType === 'pnpm') {
    if (typeof lockfileVersion === 'number' && lockfileVersion === 5.4) {
      // Ensure that pnpm 7 is at the beginning of the `$PATH`
      spawnOpts.env.PATH = `/pnpm7/node_modules/.bin${delimiter}${spawnOpts.env.PATH}`;
      console.log('Detected `pnpm-lock.yaml` generated by pnpm 7...');
    }
  }

  if (typeof installCommand === 'string') {
    if (installCommand.trim()) {
      console.log(`Running "install" command: \`${installCommand}\`...`);

      const env: Record<string, string> = {
        YARN_NODE_LINKER: 'node-modules',
        ...spawnOpts.env,
      };

      await execCommand(installCommand, {
        ...spawnOpts,
        env,
        cwd: entrypointFsDirname,
      });
    } else {
      console.log(`Skipping "install" command...`);
    }
  } else {
    await runNpmInstall(entrypointFsDirname, [], spawnOpts, meta, nodeVersion);
  }

  if (meta.isDev) {
    throw new Error('Detected `@vercel/redwood` dev but this is not supported');
  }

  const pkg = await readConfigFile<PackageJson>(join(workPath, 'package.json'));

  const toml = await readConfigFile<RedwoodToml>(
    join(workPath, 'redwood.toml')
  );

  if (buildCommand) {
    debug(`Executing build command "${buildCommand}"`);
    await execCommand(buildCommand, {
      ...spawnOpts,
      cwd: workPath,
    });
  } else if (hasScript('vercel-build', pkg)) {
    debug(`Executing "yarn vercel-build"`);
    await runPackageJsonScript(workPath, 'vercel-build', spawnOpts);
  } else if (hasScript('build', pkg)) {
    debug(`Executing "yarn build"`);
    await runPackageJsonScript(workPath, 'build', spawnOpts);
  } else {
    const { devDependencies = {} } = pkg || {};
    const versionRange = devDependencies['@redwoodjs/core'];
    let cmd: string;
    if (!versionRange || !validRange(versionRange)) {
      console.log(
        'WARNING: Unable to detect RedwoodJS version in package.json devDependencies'
      );
      cmd = 'yarn rw deploy vercel'; // Assume 0.25.0 and newer
    } else if (intersects(versionRange, '<0.25.0')) {
      // older than 0.25.0
      cmd =
        'yarn rw build && yarn rw db up --no-db-client --auto-approve && yarn rw dataMigrate up';
    } else {
      // 0.25.0 and newer
      cmd = 'yarn rw deploy vercel';
    }
    await execCommand(cmd, {
      ...spawnOpts,
      cwd: workPath,
    });
  }

  const apiDir = toml?.web?.apiProxyPath?.replace(/^\//, '') ?? 'api';
  const apiDistPath = join(workPath, 'api', 'dist', 'functions');
  const webDistPath = join(workPath, 'web', 'dist');
  const lambdaOutputs: { [filePath: string]: Lambda } = {};

  // Strip out the .html extensions
  // And populate staticOutputs map with updated paths and contentType
  const webDistFiles = await glob('**', webDistPath);
  const staticOutputs: Record<string, FileFsRef> = {};

  for (const [fileName, fileFsRef] of Object.entries(webDistFiles)) {
    const parsedPath = parsePath(fileFsRef.fsPath);

    if (parsedPath.ext !== '.html') {
      // No need to transform non-html files
      staticOutputs[fileName] = fileFsRef;
    } else {
      const fileNameWithoutExtension = pathBasename(fileName, '.html');

      const pathWithoutHtmlExtension = join(
        parsedPath.dir,
        fileNameWithoutExtension
      );

      fileFsRef.contentType = 'text/html; charset=utf-8';

      // @NOTE: Filename is relative to webDistPath
      // e.g. {'./200': fsRef}
      staticOutputs[relative(webDistPath, pathWithoutHtmlExtension)] =
        fileFsRef;
    }
  }

  // Each file in the `functions` dir will become a lambda
  // Also supports nested functions like:
  // ├── functions
  // │   ├── bazinga
  // │   │   ├── bazinga.js
  // │   ├── graphql.js

  const functionFiles = {
    ...(await glob('*.js', apiDistPath)), // top-level
    ...(await glob('*/*.js', apiDistPath)), // one-level deep
  };

  const sourceCache = new Map<string, string | Buffer | null>();
  const fsCache = new Map<string, File>();

  for (const [funcName, fileFsRef] of Object.entries(functionFiles)) {
    const outputName = join(apiDir, parsePath(funcName).name); // remove `.js` extension
    const absEntrypoint = fileFsRef.fsPath;
    const relativeEntrypoint = relative(workPath, absEntrypoint);
    const awsLambdaHandler = getAWSLambdaHandler(relativeEntrypoint, 'handler');
    const sourceFile = relativeEntrypoint.replace('/dist/', '/src/');

    const { fileList, esmFileList, warnings } = await nodeFileTrace(
      [absEntrypoint],
      {
        base: workPath,
        processCwd: workPath,
        ts: true,
        mixedModules: true,
        ignore: config.excludeFiles,
        async readFile(fsPath: string): Promise<Buffer | string | null> {
          const relPath = relative(workPath, fsPath);
          const cached = sourceCache.get(relPath);
          if (cached) return cached.toString();
          // null represents a not found
          if (cached === null) return null;
          try {
            const source = readFileSync(fsPath);
            const { mode } = lstatSync(fsPath);
            let entry: File;
            if (isSymbolicLink(mode)) {
              entry = new FileFsRef({ fsPath, mode });
            } else {
              entry = new FileBlob({ data: source, mode });
            }
            fsCache.set(relPath, entry);
            sourceCache.set(relPath, source);
            return source.toString();
          } catch (e: any) {
            if (e.code === 'ENOENT' || e.code === 'EISDIR') {
              sourceCache.set(relPath, null);
              return null;
            }
            throw e;
          }
        },
      }
    );

    for (const warning of warnings) {
      if (warning?.stack) {
        debug(warning.stack.replace('Error: ', 'Warning: '));
      }
    }

    const lambdaFiles: Files = {};

    const allFiles = [...fileList, ...esmFileList];
    for (const filePath of allFiles) {
      lambdaFiles[filePath] = await FileFsRef.fromFsPath({
        fsPath: join(workPath, filePath),
      });
    }

    lambdaFiles[relative(workPath, fileFsRef.fsPath)] = fileFsRef;

    const { memory, maxDuration } = await getLambdaOptionsFromFunction({
      sourceFile,
      config,
    });

    const lambda = new NodejsLambda({
      files: lambdaFiles,
      handler: relativeEntrypoint,
      runtime: nodeVersion.runtime,
      memory,
      maxDuration,
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: false,
      awsLambdaHandler,
    });
    lambdaOutputs[outputName] = lambda;
  }

  // Older versions of redwood did not create 200.html automatically
  // From v0.50.0+ 200.html is always generated as part of web build
  // Note that in builder post-processing, we remove the .html extension
  const fallbackHtmlPage = existsSync(join(webDistPath, '200.html'))
    ? '/200'
    : '/index';

  const defaultRoutesConfig = getTransformedRoutes({
    nowConfig: {
      // this makes sure we send back 200.html for unprerendered pages
      rewrites: [{ source: '/(.*)', destination: fallbackHtmlPage }],
      cleanUrls: true,
      trailingSlash: false,
    },
  });

  if (defaultRoutesConfig.error) {
    throw new Error(defaultRoutesConfig.error.message);
  }

  return {
    output: { ...staticOutputs, ...lambdaOutputs },
    routes: defaultRoutesConfig.routes as Route[],
  };
};

function getAWSLambdaHandler(filePath: string, handlerName: string) {
  const { dir, name } = parsePath(filePath);
  return `${dir}${dir ? sep : ''}${name}.${handlerName}`;
}

function hasScript(scriptName: string, pkg: PackageJson | null) {
  const scripts = (pkg && pkg.scripts) || {};
  return typeof scripts[scriptName] === 'string';
}

export const prepareCache: PrepareCache = ({ repoRootPath, workPath }) => {
  return glob('**/node_modules/**', repoRootPath || workPath);
};