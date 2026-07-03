// Simplified geo mapping - only for supported languages: EN, ZH, KO, JA, AR
const TLD_TO_COUNTRY: Record<string, string> = {
  tw: 'TW',  // Chinese
  jp: 'JP',  // Japanese
  kr: 'KR',  // Korean
  us: 'US',  // English
  sa: 'SA',  // Arabic
};

const HOST_HINTS: Array<[string, string]> = [
  // Taiwan (Chinese)
  ['.gov.tw', 'TW'],
  ['.edu.tw', 'TW'],
  // Japan (Japanese)
  ['.co.jp', 'JP'],
  ['.go.jp', 'JP'],
  ['.ac.jp', 'JP'],
  // Korea (Korean)
  ['.co.kr', 'KR'],
  ['.go.kr', 'KR'],
  ['.ac.kr', 'KR'],
  // Saudi Arabia (Arabic)
  ['.gov.sa', 'SA'],
  // US (English)
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

  // 1. HOST_HINTS check (e.g., .gov, .edu)
  for (const [hint, country] of HOST_HINTS) {
    if (hostname.endsWith(hint)) {
      return country;
    }
  }

  // 2. TLD fallback
  const parts = hostname.split('.').filter(Boolean);
  const tld = parts[parts.length - 1];
  return TLD_TO_COUNTRY[tld];
}
