const TLD_TO_COUNTRY = {
  tw: 'TW',
  jp: 'JP',
  kr: 'KR',
  sa: 'SA',
  us: 'US',
};

const HOST_HINTS = [
  ['.gov.tw', 'TW'],
  ['.edu.tw', 'TW'],
  ['.co.jp', 'JP'],
  ['.go.jp', 'JP'],
  ['.ac.jp', 'JP'],
  ['.co.kr', 'KR'],
  ['.go.kr', 'KR'],
  ['.ac.kr', 'KR'],
  ['.gov.sa', 'SA'],
  ['.gov', 'US'],
  ['.edu', 'US'],
];

export function extractQueryRegionFromFeedUrl(feedUrl) {
  try {
    const code = new URL(feedUrl).searchParams.get('gl');
    return code ? code.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

export function inferCountryFromUrl(rawUrl) {
  if (!rawUrl) {
    return undefined;
  }

  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  for (const [hint, country] of HOST_HINTS) {
    if (hostname.endsWith(hint)) {
      return country;
    }
  }

  const parts = hostname.split('.').filter(Boolean);
  const tld = parts[parts.length - 1];
  return TLD_TO_COUNTRY[tld];
}

export function pickSourceCountry({ sourceUrl, queryRegion }) {
  return inferCountryFromUrl(sourceUrl) ?? queryRegion;
}
