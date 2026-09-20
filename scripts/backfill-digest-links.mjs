import fs from 'node:fs/promises';
import nodefs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DIGESTS_DIR = path.resolve('src/data/digests');
const NEWS_DATA_DIR = path.resolve('src/data/news');
const NEWS_GLOB = 'src/data/news';

function isHttp(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function recordUrl(record) {
  return String(record?.sourceUrl ?? record?.url ?? record?.link ?? '').trim();
}

function execSyncWithBuffer(cmd) {
  return execSync(cmd, { maxBuffer: 256 * 1024 * 1024 });
}

function posixPath(p) {
  return p.split(path.sep).join('/');
}

async function collectCurrentMap() {
  const map = new Map();
  let files = [];
  try {
    files = await fs.readdir(NEWS_DATA_DIR);
  } catch {
    return map;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let items;
    try {
      items = JSON.parse(await fs.readFile(path.join(NEWS_DATA_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const url = recordUrl(item);
      if (item?.slug && isHttp(url)) map.set(item.slug, url);
    }
  }

  const LEGACY_MD_DIR = 'src/content/news';
  let mdFiles = [];
  try {
    mdFiles = await fs.readdir(LEGACY_MD_DIR);
  } catch {
    return map;
  }
  for (const file of mdFiles) {
    if (!file.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(LEGACY_MD_DIR, file), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const slugMatch = frontmatter.match(/^slug:\s*"([^"]*)"\s*$/m);
    const urlMatch = frontmatter.match(/^sourceUrl:\s*"([^"]*)"\s*$/m);
    if (slugMatch && urlMatch && isHttp(urlMatch[1])) {
      if (!map.has(slugMatch[1])) map.set(slugMatch[1], urlMatch[1]);
    }
  }
  return map;
}

function collectDigestEntries() {
  const entries = [];
  for (const file of nodefs.readdirSync(DIGESTS_DIR)) {
    if (!/^(daily|weekly)-\d{4}\.json$/.test(file)) continue;
    const fullPath = path.join(DIGESTS_DIR, file);
    entries.push({ file: fullPath, data: JSON.parse(nodefs.readFileSync(fullPath, 'utf8')) });
  }
  return entries;
}

function collectHighlights(entries) {
  const list = [];
  for (const { file, data } of entries) {
    for (const record of Object.values(data)) {
      if (!record || typeof record !== 'object') continue;
      for (const locale of ['en', 'zh-TW']) {
        const highlights = record[locale]?.highlights;
        if (!Array.isArray(highlights)) continue;
        for (const h of highlights) {
          if (h && typeof h.slug === 'string') list.push({ file, highlight: h });
        }
      }
    }
  }
  return list;
}

function historyUrlMap() {
  const map = new Map();
  const files = execSyncWithBuffer(`git log --all --name-only --format= -- ${NEWS_GLOB}`)
    .toString()
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.endsWith('.json'));
  for (const file of [...new Set(files)]) {
    const commits = execSyncWithBuffer(`git log --all --format=%H -- ${posixPath(file)}`)
      .toString()
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const commit of commits) {
      let text;
      try {
        text = execSyncWithBuffer(`git show ${commit}:${posixPath(file)}`).toString();
      } catch {
        continue;
      }
      let items;
      try {
        items = JSON.parse(text);
      } catch {
        continue;
      }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item?.slug || map.has(item.slug)) continue;
        const url = recordUrl(item);
        if (isHttp(url)) map.set(item.slug, url);
      }
    }
  }
  return map;
}

async function main() {
  const currentMap = await collectCurrentMap();
  const entries = collectDigestEntries();
  const highlights = collectHighlights(entries);

  const unresolved = highlights.filter(({ highlight }) => !isHttp(highlight.url));
  console.log(`[backfill] highlights=${highlights.length} alreadyResolved=${highlights.length - unresolved.length} unresolved=${unresolved.length}`);

  const needSlugs = new Set(unresolved.map(({ highlight }) => highlight.slug));
  const currentHits = new Set();
  for (const slug of needSlugs) {
    if (currentMap.has(slug)) currentHits.add(slug);
  }
  console.log(`[backfill] uniqueUnresolvedSlugs=${needSlugs.size} currentDataHits=${currentHits.size}`);

  const historyMap = historyUrlMap();
  console.log(`[backfill] historyMapSize=${historyMap.size}`);

  let resolved = 0;
  for (const { highlight } of unresolved) {
    const url = currentMap.get(highlight.slug) || historyMap.get(highlight.slug) || '';
    if (isHttp(url)) {
      highlight.url = url;
      resolved += 1;
    }
  }

  let remaining = 0;
  for (const { highlight } of highlights) {
    if (!isHttp(highlight.url)) remaining += 1;
  }

  for (const { file, data } of entries) {
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  console.log(`[backfill] resolved=${resolved} remaining=${remaining}`);
  for (const { file, highlight } of highlights) {
    if (!isHttp(highlight.url)) console.log(`[backfill] unresolved: ${path.basename(file)} ${highlight.slug}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});