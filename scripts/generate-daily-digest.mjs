import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_DIR = path.resolve('src/content/news');
const OUTPUT_FILE = path.resolve('src/data/daily-digest.json');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'https://ollama.cloud/v1').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'nemotron-3-super:cloud';
const DIGEST_DATE = process.env.DIGEST_DATE ?? new Date().toISOString().slice(0, 10);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const DIGEST_LOOKBACK_DAYS = Number(process.env.DIGEST_LOOKBACK_DAYS ?? 2);
const DIGEST_MIN_HIGHLIGHTS = 3;
const DIGEST_MAX_HIGHLIGHTS = 5;

function extract(text, field) {
  const pattern = new RegExp(`^${field}:\\s*"(.+)"$`, 'm');
  const match = text.match(pattern);
  return match ? match[1] : '';
}

function parseArticle(text) {
  return {
    title: extract(text, 'title'),
    slug: extract(text, 'slug'),
    lang: extract(text, 'lang'),
    summary: extract(text, 'summary'),
    category: extract(text, 'category'),
    status: extract(text, 'status'),
    publishedAt: extract(text, 'publishedAt'),
  };
}

async function loadRecentPublishedArticles() {
  const files = await fs.readdir(CONTENT_DIR);
  const rows = [];
  const digestBaseTime = new Date(`${DIGEST_DATE}T23:59:59.999Z`).getTime();
  const lookbackMs = DIGEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTime = digestBaseTime - lookbackMs;

  for (const file of files) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const fullPath = path.join(CONTENT_DIR, file);
    const text = await fs.readFile(fullPath, 'utf8');
    const row = parseArticle(text);

    if (row.status !== 'published') {
      continue;
    }

    const publishedTs = Date.parse(row.publishedAt);
    if (Number.isNaN(publishedTs)) {
      continue;
    }
    if (publishedTs < cutoffTime || publishedTs > digestBaseTime) {
      continue;
    }

    rows.push(row);
  }

  return rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function pickHighlights(rows, lang) {
  const byLang = rows.filter((item) => item.lang === lang);
  const today = byLang.filter((item) => item.publishedAt.startsWith(DIGEST_DATE));

  const picked = [...today.slice(0, DIGEST_MAX_HIGHLIGHTS)];
  if (picked.length >= DIGEST_MIN_HIGHLIGHTS) {
    return picked.slice(0, DIGEST_MAX_HIGHLIGHTS);
  }

  for (const item of byLang) {
    if (picked.length >= DIGEST_MIN_HIGHLIGHTS) {
      break;
    }
    if (!picked.some((existing) => existing.slug === item.slug)) {
      picked.push(item);
    }
  }

  return picked.slice(0, DIGEST_MAX_HIGHLIGHTS);
}

async function askOllama(enRows, zhRows) {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  const topEn = enRows.slice(0, 8);
  const topZh = zhRows.slice(0, 8);

  const prompt = [
    'You are an accessibility news editor.',
    'Create one daily digest in English and Traditional Chinese from the provided stories.',
    'Return strict JSON only with keys: enTitle, enSummary, zhTitle, zhSummary.',
    `Digest date: ${DIGEST_DATE}`,
    '',
    'English stories:',
    ...topEn.map((item, index) => `${index + 1}. ${item.title} | ${item.category} | ${item.summary}`),
    '',
    'Traditional Chinese stories:',
    ...topZh.map((item, index) => `${index + 1}. ${item.title} | ${item.category} | ${item.summary}`),
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
      highlights: enRows.slice(0, DIGEST_MAX_HIGHLIGHTS).map((item) => ({ title: item.title, slug: item.slug })),
    },
    'zh-TW': {
      title: String(parsed.zhTitle || '每日無障礙摘要'),
      summary: String(parsed.zhSummary || ''),
      highlights: zhRows.slice(0, DIGEST_MAX_HIGHLIGHTS).map((item) => ({ title: item.title, slug: item.slug })),
    },
  };
}

async function main() {
  const rows = await loadRecentPublishedArticles();
  const enRows = pickHighlights(rows, 'en');
  const zhRows = pickHighlights(rows, 'zh-TW');

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
