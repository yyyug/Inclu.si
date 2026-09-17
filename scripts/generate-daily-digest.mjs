import fs from 'node:fs/promises';
import path from 'node:path';
import { zhIsTranslated } from './news-ingest/zh-quality.mjs';
import { askLLM, stripCodeFence } from './digest-llm.mjs';

const NEWS_DATA_DIR = path.resolve('src/data/news');
const DIGESTS_DIR = path.resolve('src/data/digests');
const LEGACY_OUTPUT_FILE = path.resolve('src/data/daily-digest.json');
const DIGEST_DATE = (process.env.DIGEST_DATE && String(process.env.DIGEST_DATE).trim()) || new Date().toISOString().slice(0, 10);
const DIGEST_LOOKBACK_HOURS = Number(
  process.env.DIGEST_LOOKBACK_HOURS
  ?? (Number(process.env.DIGEST_LOOKBACK_DAYS ?? 0) > 0 ? Number(process.env.DIGEST_LOOKBACK_DAYS) * 24 : 25),
);
const DIGEST_MIN_HIGHLIGHTS = 8;
const DIGEST_MAX_HIGHLIGHTS = 20;
const DIGEST_MAX_CANDIDATES_PER_LOCALE = 50;
const GROQ_MAX_CANDIDATES_PER_LOCALE = 15;

async function loadRecentPublishedArticles() {
  const rows = [];
  const hasExplicitDigestDate = Boolean(String(process.env.DIGEST_DATE ?? '').trim());
  const digestBaseTime = hasExplicitDigestDate
    ? new Date(`${DIGEST_DATE}T23:59:59.999Z`).getTime()
    : Date.now();
  const lookbackMs = Math.max(1, DIGEST_LOOKBACK_HOURS) * 60 * 60 * 1000;
  const cutoffTime = digestBaseTime - lookbackMs;

  let files = [];
  try {
    files = await fs.readdir(NEWS_DATA_DIR);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const fullPath = path.join(NEWS_DATA_DIR, file);
    const text = await fs.readFile(fullPath, 'utf8');
    const items = JSON.parse(text);
    if (!Array.isArray(items)) continue;

    for (const row of items) {
      if (row?.status !== 'published') continue;

      const publishedTs = Date.parse(String(row?.publishedAt ?? ''));
      if (Number.isNaN(publishedTs)) continue;
      if (publishedTs < cutoffTime || publishedTs > digestBaseTime) continue;

      if (row?.lang === 'zh-TW' && !zhIsTranslated(String(row?.title ?? ''), String(row?.summary ?? ''))) {
        continue;
      }

      rows.push({
        title: String(row?.title ?? ''),
        slug: String(row?.slug ?? ''),
        lang: String(row?.lang ?? ''),
        summary: String(row?.summary ?? ''),
        category: String(row?.category ?? 'general'),
        status: String(row?.status ?? ''),
        publishedAt: String(row?.publishedAt ?? ''),
      });
    }
  }

  const sorted = rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  console.log(`[digest] lookback_hours=${Math.max(1, DIGEST_LOOKBACK_HOURS)}`);
  console.log(`[digest] base_time=${new Date(digestBaseTime).toISOString()}`);
  console.log(`[digest] cutoff_time=${new Date(cutoffTime).toISOString()}`);
  console.log(`[digest] candidate_total=${sorted.length}`);

  return sorted;
}

function normalizeHighlightSlugs(candidates, requestedSlugs) {
  const allowed = new Set(candidates.map((item) => item.slug));
  const selected = [];

  for (const slug of requestedSlugs) {
    if (!allowed.has(slug)) continue;
    if (selected.includes(slug)) continue;
    selected.push(slug);
    if (selected.length >= DIGEST_MAX_HIGHLIGHTS) break;
  }

  if (selected.length < DIGEST_MIN_HIGHLIGHTS) {
    for (const item of candidates) {
      if (!selected.includes(item.slug)) {
        selected.push(item.slug);
      }
      if (selected.length >= DIGEST_MIN_HIGHLIGHTS) break;
    }
  }

  return selected.slice(0, DIGEST_MAX_HIGHLIGHTS);
}

function buildDigestPrompt(enCandidates, zhCandidates) {
  const enPayload = enCandidates.map((item) => ({
    slug: item.slug,
    title: item.title,
    category: item.category,
    summary: item.summary,
    publishedAt: item.publishedAt,
  }));

  const zhPayload = zhCandidates.map((item) => ({
    slug: item.slug,
    title: item.title,
    category: item.category,
    summary: item.summary,
    publishedAt: item.publishedAt,
  }));

  return [
    'You are a disability accessibility news editor.',
    'Create one daily digest in English and Traditional Chinese from the provided stories.',
    `Select ${DIGEST_MIN_HIGHLIGHTS} to ${DIGEST_MAX_HIGHLIGHTS} stories per language.`,
    'Verify each story is genuinely about disability accessibility before selecting. Exclude stories where "accessible" means "easy to understand" or "available to the public" rather than accommodations for people with disabilities.',
    '',
    'Rank stories by importance (highest first):',
    '1. Breaking news, major policy/law changes, or significant rulings',
    '2. High-impact product launches or platform accessibility updates',
    '3. Notable advocacy milestones or community responses',
    '4. Original research, reports, or data-driven findings',
    '5. Practical guides, tutorials, or best practices',
    '6. Opinion pieces or personal stories',
    '',
    'Diversity rules:',
    '- Do NOT select more than 2 stories from the same category.',
    '- If possible, cover at least 3 different categories.',
    '- For the zh-TW digest, include at least 1 story from x.com (Twitter) if available, especially posts from Japanese accounts about disability topics.',
    '- Balance between traditional news articles and social media posts (x.com).',
    '',
    'Summary requirements:',
    "- Title: 8-15 words, captures the day's theme or lead story.",
    '- Summary: 2-3 sentences. Lead with the most significant story. Neutral, factual tone.',
    '',
    'Return strict JSON only with keys: enTitle, enSummary, zhTitle, zhSummary, enHighlightSlugs, zhHighlightSlugs.',
    'enHighlightSlugs and zhHighlightSlugs must be arrays of slug strings from the provided candidate lists only.',
    `Digest date: ${DIGEST_DATE}`,
    '',
    'English candidate stories:',
    JSON.stringify(enPayload),
    '',
    'Traditional Chinese candidate stories:',
    JSON.stringify(zhPayload),
  ].join('\n');
}

function parseDigestResponse(enCandidates, zhCandidates, content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw new Error(`Daily digest LLM returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    en: {
      title: String(parsed.enTitle || 'Daily Accessibility Digest'),
      summary: String(parsed.enSummary || ''),
      highlights: normalizeHighlightSlugs(enCandidates, Array.isArray(parsed.enHighlightSlugs) ? parsed.enHighlightSlugs.map((slug) => String(slug)) : [])
        .map((slug) => {
          const item = enCandidates.find((row) => row.slug === slug);
          return item ? { title: item.title, slug: item.slug } : null;
        })
        .filter(Boolean),
    },
    'zh-TW': {
      title: String(parsed.zhTitle || '每日無障礙摘要'),
      summary: String(parsed.zhSummary || ''),
      highlights: normalizeHighlightSlugs(zhCandidates, Array.isArray(parsed.zhHighlightSlugs) ? parsed.zhHighlightSlugs.map((slug) => String(slug)) : [])
        .map((slug) => {
          const item = zhCandidates.find((row) => row.slug === slug);
          return item ? { title: item.title, slug: item.slug } : null;
        })
        .filter(Boolean),
    },
  };
}

async function readJsonObject(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonObjectSorted(filePath, data) {
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

async function upsertDailyDigest(output) {
  await fs.mkdir(DIGESTS_DIR, { recursive: true });
  const year = output.date.slice(0, 4);
  const filePath = path.join(DIGESTS_DIR, `daily-${year}.json`);
  const data = await readJsonObject(filePath);
  data[output.date] = {
    generatedAt: output.generatedAt,
    en: output.en,
    'zh-TW': output['zh-TW'],
  };
  await writeJsonObjectSorted(filePath, data);
  console.log(`[digest] wrote ${filePath}`);
}

async function migrateLegacyDigestIfPresent() {
  let legacy;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_OUTPUT_FILE, 'utf8'));
  } catch {
    return;
  }

  const date = String(legacy?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (!legacy?.en || !legacy?.['zh-TW']) return;

  const year = date.slice(0, 4);
  const filePath = path.join(DIGESTS_DIR, `daily-${year}.json`);
  const data = await readJsonObject(filePath);
  if (data[date]) return;

  data[date] = {
    generatedAt: String(legacy.generatedAt ?? ''),
    en: legacy.en,
    'zh-TW': legacy['zh-TW'],
  };
  await writeJsonObjectSorted(filePath, data);
  console.log(`[digest] migrated legacy ${path.basename(LEGACY_OUTPUT_FILE)} (${date})`);
}

async function main() {
  await migrateLegacyDigestIfPresent();

  const rows = await loadRecentPublishedArticles();
  const enRows = rows.filter((item) => item.lang === 'en').slice(0, DIGEST_MAX_CANDIDATES_PER_LOCALE);
  const zhRows = rows.filter((item) => item.lang === 'zh-TW').slice(0, DIGEST_MAX_CANDIDATES_PER_LOCALE);

  console.log(`[digest] candidate_en=${enRows.length}`);
  console.log(`[digest] candidate_zh_tw=${zhRows.length}`);

  if (rows.length === 0) {
    throw new Error('No published stories found in the digest lookback window.');
  }
  if (enRows.length === 0 || zhRows.length === 0) {
    console.warn('[digest] Warning: one locale has zero candidates; highlights may be sparse for that locale.');
  }

  const prompt = buildDigestPrompt(enRows, zhRows);
  const fallbackPrompt = buildDigestPrompt(enRows.slice(0, GROQ_MAX_CANDIDATES_PER_LOCALE), zhRows.slice(0, GROQ_MAX_CANDIDATES_PER_LOCALE));
  const content = await askLLM(prompt, fallbackPrompt);
  const digest = parseDigestResponse(enRows, zhRows, content);
  const output = {
    date: DIGEST_DATE,
    generatedAt: new Date().toISOString(),
    ...digest,
  };

  await upsertDailyDigest(output);
  console.log(`Generated digest for ${DIGEST_DATE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
