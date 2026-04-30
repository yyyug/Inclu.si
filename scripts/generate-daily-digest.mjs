import fs from 'node:fs/promises';
import path from 'node:path';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

const NEWS_DATA_DIR = path.resolve('src/data/news');
const OUTPUT_FILE = path.resolve('src/data/daily-digest.json');
const OLLAMA_BASE_URL = requireEnv('OLLAMA_BASE_URL').replace(/\/$/, '');
const OLLAMA_API_KEY = requireEnv('OLLAMA_API_KEY');
const OLLAMA_MODEL = requireEnv('OLLAMA_MODEL');
const DIGEST_DATE = process.env.DIGEST_DATE ?? new Date().toISOString().slice(0, 10);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const OLLAMA_MAX_TOKENS = Math.max(1, Math.min(100000, Number(process.env.OLLAMA_MAX_TOKENS ?? 100000)));
const DIGEST_LOOKBACK_HOURS = Number(
  process.env.DIGEST_LOOKBACK_HOURS
  ?? (Number(process.env.DIGEST_LOOKBACK_DAYS ?? 0) > 0 ? Number(process.env.DIGEST_LOOKBACK_DAYS) * 24 : 25),
);
const DIGEST_MIN_HIGHLIGHTS = 3;
const DIGEST_MAX_HIGHLIGHTS = 5;

async function loadRecentPublishedArticles() {
  const rows = [];
  const hasExplicitDigestDate = Boolean(process.env.DIGEST_DATE);
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

async function askOllama(enCandidates, zhCandidates) {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

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

  const prompt = [
    'You are an accessibility news editor.',
    'Create one daily digest in English and Traditional Chinese from the provided stories from the lookback window.',
    `For each language, choose ${DIGEST_MIN_HIGHLIGHTS} to ${DIGEST_MAX_HIGHLIGHTS} most important stories.`,
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

  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        temperature: 0.2,
        max_tokens: OLLAMA_MAX_TOKENS,
        messages: [
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    throw new Error(`Daily digest LLM request failed (${code}). ${error?.message ?? ''}`.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Daily digest LLM failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Daily digest LLM returned empty content.');
  }

  let cleanedContent = content.trim();
  if (cleanedContent.startsWith('```json')) {
    cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleanedContent.startsWith('```')) {
    cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanedContent);
  } catch {
    throw new Error(`Daily digest LLM returned invalid JSON: ${cleanedContent.slice(0, 200)}`);
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

async function main() {
  const rows = await loadRecentPublishedArticles();
  const enRows = rows.filter((item) => item.lang === 'en');
  const zhRows = rows.filter((item) => item.lang === 'zh-TW');

  console.log(`[digest] candidate_en=${enRows.length}`);
  console.log(`[digest] candidate_zh_tw=${zhRows.length}`);

  if (rows.length === 0) {
    throw new Error('No published stories found in the digest lookback window.');
  }
  if (enRows.length === 0 || zhRows.length === 0) {
    console.warn('[digest] Warning: one locale has zero candidates; highlights may be sparse for that locale.');
  }

  const digest = await askOllama(enRows, zhRows);
  const output = {
    date: DIGEST_DATE,
    generatedAt: new Date().toISOString(),
    ...digest,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Generated digest for ${DIGEST_DATE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
