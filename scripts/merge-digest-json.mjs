import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';

function git(args) {
  return execSync(`git ${args}`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pickTimestamp(entry) {
  for (const key of ['generatedAt', 'date', 'week']) {
    if (entry?.[key]) return String(entry[key]);
  }
  return null;
}

function mergeObjects(origin, snapshot) {
  const out = { ...origin };
  for (const [key, value] of Object.entries(snapshot)) {
    const existing = out[key];
    if (!existing) {
      out[key] = value;
      continue;
    }
    const a = pickTimestamp(existing);
    const b = pickTimestamp(value);
    if (b && (!a || b > a)) {
      out[key] = value;
    }
  }
  return out;
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const snapshot = process.argv[2];
  const dataDir = process.argv[3] || 'src/data/digests';

  if (!snapshot) {
    console.error('usage: node scripts/merge-digest-json.mjs <snapshotCommit> [dataDir]');
    process.exit(1);
  }

  const files = git(`ls-tree -r --name-only ${snapshot} -- ${dataDir}`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const file of files) {
    let snapshotJson = {};
    try {
      snapshotJson = JSON.parse(git(`show ${snapshot}:${file}`));
      if (!snapshotJson || typeof snapshotJson !== 'object' || Array.isArray(snapshotJson)) snapshotJson = {};
    } catch {
      snapshotJson = {};
    }

    const originJson = await readJson(file);
    const merged = mergeObjects(originJson, snapshotJson);

    if (JSON.stringify(merged) !== JSON.stringify(originJson)) {
      await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      console.log(`[merge-digest-json] ${file}: ${Object.keys(originJson).length} -> ${Object.keys(merged).length} keys`);
    } else {
      console.log(`[merge-digest-json] ${file}: unchanged (${Object.keys(originJson).length})`);
    }
  }
}

main().catch((err) => {
  console.error('[merge-digest-json] failed:', err.message);
  process.exit(1);
});