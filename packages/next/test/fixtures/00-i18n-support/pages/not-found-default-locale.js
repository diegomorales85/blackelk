import Link from 'next/link';
import { useRouter } from 'next/router';

export default function Page(props) {
  const router = useRouter();

  return (
    <>
      <p id="not-found-default-locale">notfound default locale</p>
      <p id="props">{JSON.stringify(props)}</p>
      <p id="router-locale">{router.locale}</p>
      <p id="router-locales">{JSON.stringify(router.locales)}</p>
      <p id="router-query">{JSON.stringify(router.query)}</p>
      <p id="router-pathname">{router.pathname}</p>
      <p id="router-as-path">{router.asPath}</p>
      <Link href="/">
        <a id="to-index">to /</a>
      </Link>
      <br />
    </>
  );
}

export const getStaticProps = ({ defaultLocale, locale, locales }) => {
  if (locale === defaultLocale || locale === 'nl') {
    return {
      notFound: true,
    };
  }

  return {
    props: {
      locale,
      locales,
    },
  };
};
