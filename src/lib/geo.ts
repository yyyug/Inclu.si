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

// Media domain to country mapping - covers 60+ popular news outlets
const MEDIA_DOMAIN_TO_COUNTRY: Record<string, string> = {
  // US Media & Organizations (English)
  'nps.gov': 'US',
  'phila.gov': 'US',
  'doa.nc.gov': 'US',
  'sf.gov': 'US',
  'mass.gov': 'US',
  'visitphilly.com': 'US',
  'carmichaeltimes.com': 'US',
  'kcra.com': 'US',
  'nbcsports.com': 'US',
  'dukechronicle.com': 'US',
  'umt.edu': 'US',
  'psu.edu': 'US',
  'ucdavis.edu': 'US',
  'gatech.edu': 'US',
  'ohio.edu': 'US',
  'clemson.edu': 'US',
  'uoregon.edu': 'US',
  'vt.edu': 'US',
  'und.edu': 'US',
  'brockport.edu': 'US',
  'umflint.edu': 'US',
  'attheu.utah.edu': 'US',
  'columbiamissourian.com': 'US',
  'dailyutahchronicle.com': 'US',
  'nlc.org': 'US',
  'naco.org': 'US',
  'lmc.org': 'US',
  'nysba.org': 'US',
  'jdsupra.com': 'US',
  'edsurge.com': 'US',
  'insidehighered.com': 'US',
  'govtech.com': 'US',
  'k12dive.com': 'US',
  'americanlibrariesmagazine.org': 'US',
  'ucnet.universityofcalifornia.edu': 'US',
  'ellucian.com': 'US',
  'rettsyndromenews.com': 'US',
  'blog.google': 'US',
  'microsoft.com': 'US',
  'apple.com': 'US',
  'callofduty.com': 'US',
  'travelportland.com': 'US',
  'news.northwestern.edu': 'US',
  'news.vt.edu': 'US',
  'news.clemson.edu': 'US',
  'blogs.und.edu': 'US',
  'angelcity.com': 'US',

  // Taiwan (Chinese)
  'president.gov.tw': 'TW',
  'tc-news.com.tw': 'TW',
  'ctee.com.tw': 'TW',
  'udn.com': 'TW',
  'businesstoday.com.tw': 'TW',
  '2026taiwanlanternfestival.org': 'TW',
};

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

  // 1. Exact media domain match (highest priority)
  if (MEDIA_DOMAIN_TO_COUNTRY[hostname]) {
    return MEDIA_DOMAIN_TO_COUNTRY[hostname];
  }

  // 2. Try without www prefix
  const hostnameWithoutWww = hostname.replace(/^www\./, '');
  if (hostnameWithoutWww !== hostname && MEDIA_DOMAIN_TO_COUNTRY[hostnameWithoutWww]) {
    return MEDIA_DOMAIN_TO_COUNTRY[hostnameWithoutWww];
  }

  // 3. HOST_HINTS check (e.g., .gov, .edu)
  for (const [hint, country] of HOST_HINTS) {
    if (hostname.endsWith(hint)) {
      return country;
    }
  }

  // 4. TLD fallback
  const parts = hostname.split('.').filter(Boolean);
  const tld = parts[parts.length - 1];
  return TLD_TO_COUNTRY[tld];
}
