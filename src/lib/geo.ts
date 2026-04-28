const TLD_TO_COUNTRY: Record<string, string> = {
  tw: 'TW',
  jp: 'JP',
  kr: 'KR',
  sa: 'SA',
  ae: 'AE',
  uk: 'GB',
  us: 'US',
};

const HOST_HINTS: Array<[string, string]> = [
  ['.gov.tw', 'TW'],
  ['.edu.tw', 'TW'],
  ['.co.jp', 'JP'],
  ['.go.jp', 'JP'],
  ['.ac.jp', 'JP'],
  ['.co.kr', 'KR'],
  ['.go.kr', 'KR'],
  ['.ac.kr', 'KR'],
  ['.gov.sa', 'SA'],
  ['.gov.ae', 'AE'],
  ['.gov', 'US'],
  ['.edu', 'US'],
];

export function inferCountryFromSourceUrl(rawUrl: string | undefined): string | undefined {
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
