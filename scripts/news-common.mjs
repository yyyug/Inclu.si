import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasZhChars, zhIsTranslated } from './news-ingest/zh-quality.mjs';

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

export function parseCommaList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const CONTENT_DIR = path.resolve('src/content/news');
export const NEWS_DATA_DIR = path.resolve('src/data/news');
export const OLLAMA_BASE_URL = requireEnv('OLLAMA_BASE_URL').replace(/\/$/, '');
export const OLLAMA_API_KEY = requireEnv('OLLAMA_API_KEY');
export const OLLAMA_MODEL = requireEnv('OLLAMA_MODEL');
export const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
export const OLLAMA_MAX_TOKENS = Math.max(1, Math.min(20000, Number(process.env.OLLAMA_MAX_TOKENS ?? 20000)));
export const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);
export const BATCH_SIZE = Math.min(5, Math.max(3, Number(process.env.BATCH_SIZE ?? 3)));
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
export const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
export const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS ?? OLLAMA_TIMEOUT_MS);

export const CATEGORY_KEYS = [
  'digital-a11y',
  'assistive-tech',
  'laws-rights',
  'physical-design',
  'lifestyle-culture',
  'case-studies',
  'general',
];

const ACCESSIBILITY_KEYWORDS = [
  'accessibility', 'a11y', 'accessible', 'assistive', 'disability',
  'disabled', 'deaf', 'blind', 'wheelchair', 'wcag', 'ada',
  '無障礙', '可及性', '輔助', '身心障礙', '視障', '聽障', '聽力',
  '動作', '認知', '殘障', '包容設計', '通用設計',
];

export function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const blocked = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content', 'ocid'];
    for (const key of blocked) {
      url.searchParams.delete(key);
    }

    url.hash = '';
    const normalizedPath = url.pathname.replace(/\/$/, '');
    url.pathname = normalizedPath || '/';

    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export function toIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

export function safeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeCategory(value) {
  if (CATEGORY_KEYS.includes(value)) {
    return value;
  }

  return 'general';
}

export function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function isAccessibilityRelated(title, snippet) {
  const text = `${title ?? ''} ${snippet ?? ''}`.toLowerCase();
  return ACCESSIBILITY_KEYWORDS.some((kw) => text.includes(kw));
}

export function sourceHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function stripCodeFenceJson(content) {
  let cleaned = String(content ?? '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

export function buildBatchPrompt(batchItems) {
  const payload = batchItems.map((entry, index) => ({
    itemId: index,
    title: entry.item.title ?? '',
    snippet: entry.item.contentSnippet ?? entry.item.content ?? '',
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
  }));

  return [
    'You are a disability accessibility news editor.',
    'For each input item, first decide if it is about DISABILITY accessibility.',
    'If related, classify and summarize in English and Traditional Chinese.',
    'Return a strict JSON array and nothing else.',
    'Allowed category values: digital-a11y, assistive-tech, laws-rights, physical-design, lifestyle-culture, case-studies, general.',
    'Each array item must include keys: itemId, isRelevant, englishTitle, englishSummary, zhTitle, zhSummary, category, tags.',
    'If not relevant, return: {"itemId": <id>, "isRelevant": false}',
    '',
    'IMPORTANT: "Accessible" has two meanings. Mark as NOT relevant if it means "easy to understand", "easy to read", or "available to the general public" rather than accommodations for people with disabilities.',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

export function parseBatchResponse(content) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFenceJson(content));
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('LLM batch response is not an array.');
  }

  return parsed.map((row) => ({
    itemId: Number(row?.itemId),
    isRelevant: row?.isRelevant !== false,
    englishTitle: String(row?.englishTitle || '').trim(),
    englishSummary: String(row?.englishSummary || '').trim(),
    zhTitle: String(row?.zhTitle || '').trim(),
    zhSummary: String(row?.zhSummary || '').trim(),
    category: normalizeCategory(String(row?.category || 'general').trim()),
    tags: safeStringArray(row?.tags),
  }));
}

export async function askOllamaForBatch(batchItems) {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  const userPrompt = buildBatchPrompt(batchItems);

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
          {
            role: 'system',
            content: 'Always output valid minified JSON and nothing else.',
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    const name = error?.name ?? error?.cause?.name ?? 'UnknownError';
    const details = [
      `Ollama request failed (${code}).`,
      `name=${name}`,
      `timeout_ms=${OLLAMA_TIMEOUT_MS}`,
      `model=${OLLAMA_MODEL}`,
      `base_url=${OLLAMA_BASE_URL}`,
      `${error?.message ?? ''}`,
    ].filter(Boolean).join(' ');
    throw new Error(details.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama API returned empty content.');
  }

  return parseBatchResponse(content);
}

export async function askGroqForBatch(batchItems) {
  if (!GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY.');
  }

  console.log(`[groq] Falling back to Groq model=${GROQ_MODEL}`);
  const userPrompt = buildBatchPrompt(batchItems);

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: OLLAMA_MAX_TOKENS,
        messages: [
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    throw new Error(`Groq fallback request failed (${code}). ${error?.message ?? ''}`.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq fallback failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Groq fallback returned empty content.');
  }

  return parseBatchResponse(content);
}

export async function retryOllama(fn, groqFn, batchIndex) {
  let lastError;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < OLLAMA_MAX_RETRIES) {
        const delay = attempt * 2000;
        console.warn(`[ollama] Batch ${batchIndex} attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.warn(`[ollama] Batch ${batchIndex} exhausted retries=${OLLAMA_MAX_RETRIES}. Trying Groq fallback…`);
  try {
    return await groqFn();
  } catch (groqError) {
    console.error(`[groq] Batch ${batchIndex} fallback also failed: ${groqError.message}`);
    throw lastError;
  }
}

export { hasZhChars, zhIsTranslated };

function normalizeTitleKey(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function monthlyNewsFilePath(lang, publishedAt) {
  const month = String(publishedAt).slice(0, 7);
  return path.join(NEWS_DATA_DIR, `${month}.${lang}.json`);
}

async function readMonthlyNewsFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMonthlyNewsFile(filePath, stories) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(stories, null, 2)}\n`, 'utf8');
}

export async function upsertMonthlyNewsStory(story) {
  const filePath = monthlyNewsFilePath(story.lang, story.publishedAt);
  const stories = await readMonthlyNewsFile(filePath);
  const index = stories.findIndex((item) => item.slug === story.slug);

  if (index >= 0) {
    stories[index] = story;
  } else {
    stories.push(story);
  }

  await writeMonthlyNewsFile(filePath, stories);
  return path.basename(filePath);
}

async function listMonthlyNewsRecords() {
  const rows = [];

  try {
    const files = await fs.readdir(NEWS_DATA_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(NEWS_DATA_DIR, file);
      const items = await readMonthlyNewsFile(filePath);
      for (const item of items) {
        if (item && typeof item === 'object') {
          rows.push(item);
        }
      }
    }
  } catch {
    await fs.mkdir(NEWS_DATA_DIR, { recursive: true });
  }

  return rows;
}

export async function readExistingKeys() {
  const keys = new Set();

  const monthlyStories = await listMonthlyNewsRecords();
  for (const story of monthlyStories) {
    const sourceUrl = String(story.sourceUrl ?? '').trim();
    const title = String(story.title ?? '').trim();
    if (sourceUrl) {
      keys.add(`url:${normalizeUrl(sourceUrl)}`);
    }
    if (title) {
      keys.add(`title:${title.toLowerCase()}`);
    }
  }

  try {
    const files = await fs.readdir(CONTENT_DIR);
    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue;
      }

      const fullPath = path.join(CONTENT_DIR, file);
      const text = await fs.readFile(fullPath, 'utf8');

      const sourceUrlMatch = text.match(/^sourceUrl:\s*"(.+)"$/m);
      const titleMatch = text.match(/^title:\s*"(.+)"$/m);
      if (sourceUrlMatch) {
        keys.add(`url:${normalizeUrl(sourceUrlMatch[1])}`);
      }
      if (titleMatch) {
        keys.add(`title:${titleMatch[1].trim().toLowerCase()}`);
      }
    }
  } catch {
    await fs.mkdir(CONTENT_DIR, { recursive: true });
  }

  return keys;
}

export async function writeStoryPair(item, ai, sourceName, sourceUrl, sourceCountry, queryRegion, ingestMeta = {}) {
  const canonicalUrl = normalizeUrl(sourceUrl);
  const publishedAt = toIsoDate(item.isoDate ?? item.pubDate);
  const fetchedAt = new Date().toISOString();
  const hash = crypto.createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 8);

  const baseSlug = slugify(ai.englishTitle) || `story-${hash}`;
  const enSlug = `${baseSlug}-${hash}`;
  const zhSlug = `${baseSlug}-zh-${hash}`;
  const clusterId = `cluster-${hash}`;

  const enStory = {
    title: ai.englishTitle,
    slug: enSlug,
    lang: 'en',
    summary: ai.englishSummary,
    category: ai.category,
    tags: ai.tags,
    sourceName,
    sourceUrl: canonicalUrl,
    relatedSources: [{ name: sourceName, url: canonicalUrl }],
    sourceCountry: sourceCountry ?? null,
    queryRegion: queryRegion ?? null,
    region: queryRegion ?? null,
    ingestType: String(ingestMeta.ingestType ?? ''),
    ingestSource: String(ingestMeta.ingestSource ?? ''),
    ingestProvider: String(ingestMeta.ingestProvider ?? ''),
    clusterId,
    status: 'published',
    translationOf: zhSlug,
    publishedAt,
    fetchedAt,
    body: `${ai.englishSummary}\n\nRead more from the original source: [${sourceName}](${canonicalUrl})`,
  };

  const zhStory = {
    title: ai.zhTitle,
    slug: zhSlug,
    lang: 'zh-TW',
    summary: ai.zhSummary,
    category: ai.category,
    tags: ai.tags,
    sourceName,
    sourceUrl: canonicalUrl,
    relatedSources: [{ name: sourceName, url: canonicalUrl }],
    sourceCountry: sourceCountry ?? null,
    queryRegion: queryRegion ?? null,
    region: queryRegion ?? null,
    ingestType: String(ingestMeta.ingestType ?? ''),
    ingestSource: String(ingestMeta.ingestSource ?? ''),
    ingestProvider: String(ingestMeta.ingestProvider ?? ''),
    clusterId,
    status: zhIsTranslated(ai.zhTitle, ai.zhSummary) ? 'published' : 'draft',
    translationOf: enSlug,
    publishedAt,
    fetchedAt,
    body: `${ai.zhSummary}\n\n原文來源： [${sourceName}](${canonicalUrl})`,
  };

  const enFile = await upsertMonthlyNewsStory(enStory);
  const zhFile = await upsertMonthlyNewsStory(zhStory);

  return { canonicalUrl, enFile, zhFile, titleKey: normalizeTitleKey(enStory.title) };
}