import chalk from 'chalk';

import { Cert } from '../../types';
import * as ERRORS from '../errors-ts';
import Client from '../client';
import mapCertError from './map-cert-error';

export default async function startCertOrder(
  client: Client,
  cns: string[],
  context: string // eslint-disable-line
) {
  client.output.spinner(
    `Issuing a certificate for ${chalk.bold(cns.join(', '))}`
  );
  try {
    const cert = await client.fetch<Cert>('/v3/now/certs', {
      method: 'PATCH',
      body: {
        op: 'finalizeOrder',
        domains: cns,
      },
    });
    return cert;
  } catch (error) {
    if (error.code === 'cert_order_not_found') {
      return new ERRORS.CertOrderNotFound(cns);
    }

    const mappedError = mapCertError(error, cns);
    if (mappedError) {
      return mappedError;
    }

    throw error;
  }
}
