import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIGESTS_DIR = path.join(ROOT, 'src/data/digests');
const SRC_FILE = 'src/data/daily-digest.json';

const commits = execFileSync('git', ['log', '--format=%H', '--reverse', '--', SRC_FILE], { cwd: ROOT, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

const byDate = new Map();
for (const commit of commits) {
  let text;
  try {
    text = execFileSync('git', ['show', `${commit}:${SRC_FILE}`], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    continue;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    continue;
  }
  if (!data || typeof data !== 'object' || !data.date) continue;
  const entry = {
    generatedAt: data.generatedAt ?? '',
    en: data.en ?? { title: '', summary: '', highlights: [] },
    'zh-TW': data['zh-TW'] ?? { title: '', summary: '', highlights: [] },
  };
  byDate.set(data.date, { date: data.date, ...entry });
}

const dates = [...byDate.keys()].sort();
console.log(`Scanned ${commits.length} commits; recovered ${dates.length} daily digests from git history.`);
console.log(`Range: ${dates[0]} .. ${dates[dates.length - 1]}`);

const years = new Map();
for (const date of dates) {
  const year = date.slice(0, 4);
  if (!years.has(year)) years.set(year, new Map());
  years.get(year).set(date, byDate.get(date));
}

const missing = [];
for (const [year, entries] of years) {
  const filePath = path.join(DIGESTS_DIR, `daily-${year}.json`);
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    console.log(`SKIP year ${year}: existing file is not a JSON object`);
    continue;
  }
  let added = 0;
  let skipped = 0;
  for (const [date, entry] of entries) {
    if (date in existing) {
      skipped++;
    } else {
      existing[date] = entry;
      added++;
    }
  }
  const sorted = Object.fromEntries(Object.keys(existing).sort().map((k) => [k, existing[k]]));
  fs.writeFileSync(filePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${filePath}: added=${added} skipped(existing)=${skipped} total=${Object.keys(sorted).length}`);

  const existingDates = new Set(Object.keys(sorted));
  for (const [date] of entries) {
    if (!existingDates.has(date)) missing.push(date);
  }
}

if (missing.length) {
  console.log(`\nDates WITHOUT any digest (generation failed on all runs those days):`);
  console.log(JSON.stringify(missing.sort(), null, 2));
}