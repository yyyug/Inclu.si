import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.NEWS_DATA_DIR ?? 'src/data/news');
const MAX_AGE_DAYS = Number(process.env.YT_MAX_AGE_DAYS ?? 200);
const CUTOFF_MS = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const DRY_RUN = process.env.DRY_RUN === '1';

let removedTotal = 0;
let prunedFiles = 0;

for (const file of fs.readdirSync(DATA_DIR)) {
  if (!file.endsWith('.json')) {
    continue;
  }
  const filePath = path.join(DATA_DIR, file);
  const stories = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const kept = stories.filter((story) => {
    if (story.ingestType !== 'youtube') {
      return true;
    }
    const publishedAt = story.publishedAt ?? story.isoDate ?? '';
    const time = new Date(publishedAt).getTime();
    if (Number.isNaN(time)) {
      return true;
    }
    return time >= CUTOFF_MS;
  });

  if (kept.length !== stories.length) {
    removedTotal += stories.length - kept.length;
    prunedFiles += 1;
    if (!DRY_RUN) {
      fs.writeFileSync(filePath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
    }
  }
}

console.log(`[cleanup-youtube-old] dry_run=${DRY_RUN} files_pruned=${prunedFiles} removed=${removedTotal} (cutoff=${MAX_AGE_DAYS} days)`);