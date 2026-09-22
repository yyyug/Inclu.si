import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

function git(args) {
  return execSync(`git ${args}`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pickTimestamp(entry) {
  for (const key of ['editedAt', 'fetchedAt', 'updatedAt']) {
    if (entry?.[key]) return String(entry[key]);
  }
  return null;
}

function isNewer(candidate, reference) {
  const c = pickTimestamp(candidate);
  const r = pickTimestamp(reference);
  if (c && r) return c > r;
  if (c) return true;
  return false;
}

function mergeArrays(origin, snapshot) {
  const bySlug = new Map();
  for (const entry of origin) {
    bySlug.set(entry.slug, entry);
  }
  for (const entry of snapshot) {
    const existing = bySlug.get(entry.slug);
    if (!existing) {
      bySlug.set(entry.slug, entry);
    } else if (entry.slug !== undefined && isNewer(entry, existing)) {
      bySlug.set(entry.slug, entry);
    }
  }
  return [...bySlug.values()];
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const snapshot = process.argv[2];
  const dataDir = process.argv[3] || 'src/data/news';

  if (!snapshot) {
    console.error('usage: node scripts/merge-news-json.mjs <snapshotCommit> [dataDir]');
    process.exit(1);
  }

  const files = git(`ls-tree -r --name-only ${snapshot} -- ${dataDir}`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const file of files) {
    let snapshotJson = [];
    try {
      snapshotJson = JSON.parse(git(`show ${snapshot}:${file}`));
      if (!Array.isArray(snapshotJson)) snapshotJson = [];
    } catch {
      snapshotJson = [];
    }

    const originJson = await readJson(file);
    const merged = mergeArrays(originJson, snapshotJson);

    if (merged.length !== originJson.length || JSON.stringify(merged) !== JSON.stringify(originJson)) {
      await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      console.log(`[merge-news-json] ${file}: ${originJson.length} -> ${merged.length}`);
    } else {
      console.log(`[merge-news-json] ${file}: unchanged (${originJson.length})`);
    }
  }
}

main().catch((err) => {
  console.error('[merge-news-json] failed:', err.message);
  process.exit(1);
});