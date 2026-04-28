import fs from 'node:fs/promises';
import path from 'node:path';
import { inferCountryFromUrl } from './news-ingest/geo.mjs';

const DIR = path.resolve('src/content/news');
const files = await fs.readdir(DIR);
let updated = 0;

const langToRegion = {
  en: 'US',
  'zh-TW': 'TW',
};

for (const file of files) {
  if (!file.endsWith('.md')) continue;
  const fullPath = path.join(DIR, file);
  const text = await fs.readFile(fullPath, 'utf8');
  if (!text.startsWith('---\n')) continue;

  const end = text.indexOf('\n---\n', 4);
  if (end === -1) continue;

  const fm = text.slice(4, end);
  const body = text.slice(end + 5);

  const sourceUrlMatch = fm.match(/^sourceUrl:\s+"(.+)"$/m);
  const langMatch = fm.match(/^lang:\s+"(.+)"$/m);

  if (!sourceUrlMatch || !langMatch) continue;

  const hasSourceCountry = /^sourceCountry:\s+".+"$/m.test(fm);
  const hasQueryRegion = /^queryRegion:\s+".+"$/m.test(fm);
  const hasRegion = /^region:\s+".+"$/m.test(fm);

  const sourceUrl = sourceUrlMatch[1];
  const lang = langMatch[1];
  const inferredCountry = inferCountryFromUrl(sourceUrl);

  let newFm = fm;
  let changed = false;

  if (!hasSourceCountry && inferredCountry) {
    newFm += `\nsourceCountry: "${inferredCountry}"`;
    changed = true;
  }

  const effectiveRegion = inferredCountry ?? langToRegion[lang];
  if (!hasQueryRegion && effectiveRegion) {
    newFm += `\nqueryRegion: "${effectiveRegion}"`;
    changed = true;
  }

  if (!hasRegion && effectiveRegion) {
    newFm += `\nregion: "${effectiveRegion}"`;
    changed = true;
  }

  if (!changed) continue;

  const next = `---\n${newFm}\n---\n${body}`;
  await fs.writeFile(fullPath, next, 'utf8');
  updated += 1;
}

console.log(`Updated ${updated} files.`);
