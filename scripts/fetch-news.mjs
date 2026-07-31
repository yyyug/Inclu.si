import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import { GoogleDecoder } from 'google-news-url-decoder';
import { extractQueryRegionFromFeedUrl, pickSourceCountry } from './news-ingest/geo.mjs';
import { hasZhChars, zhIsTranslated } from './news-ingest/zh-quality.mjs';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function requireRssFeedUrls() {
  const value = process.env.RSS_FEED_URLS ?? process.env.GOOGLE_NEWS_RSS_URLS;
  if (!value || !String(value).trim()) {
    throw new Error('Missing required environment variable: RSS_FEED_URLS (or legacy GOOGLE_NEWS_RSS_URLS)');
  }
  return parseCommaList(value);
}

const RSS_FEED_URLS = requireRssFeedUrls();

const NEWS_API_KEY = requireEnv('NEWS_API_KEY');
const NEWS_API_BASE_URL = requireEnv('NEWS_API_BASE_URL').replace(/\/$/, '');
const NEWS_API_QUERIES = parseCommaList(requireEnv('NEWS_API_QUERIES'));
const NEWS_API_PAGE_SIZE = Math.min(100, Math.max(10, Number(process.env.NEWS_API_PAGE_SIZE ?? 50)));
const NEWS_API_QUERY_REGION_MAP = {
  accessibility: 'US',
  無障礙: 'TW',
  접근성: 'KR',
  アクセシビリティ: 'JP',
  الإعاقة: 'SA',
};

const CONTENT_DIR = path.resolve('src/content/news');
const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = requireEnv('OLLAMA_BASE_URL').replace(/\/$/, '');
const OLLAMA_API_KEY = requireEnv('OLLAMA_API_KEY');
const OLLAMA_MODEL = requireEnv('OLLAMA_MODEL');
const MAX_ITEMS_PER_RUN = Math.max(1, Number(process.env.MAX_ITEMS_PER_RUN ?? 10));
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const OLLAMA_MAX_TOKENS = Math.max(1, Math.min(20000, Number(process.env.OLLAMA_MAX_TOKENS ?? 20000)));
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);
const BATCH_SIZE = Math.min(5, Math.max(3, Number(process.env.BATCH_SIZE ?? 3)));
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS ?? OLLAMA_TIMEOUT_MS);

const CATEGORY_KEYS = [
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

function parseCommaList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUrl(rawUrl) {
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

function slugify(value) {
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

function toIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function safeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeCategory(value) {
  if (CATEGORY_KEYS.includes(value)) {
    return value;
  }

  return 'general';
}

function extractSourceName(item) {
  const title = String(item.title ?? '').trim();
  const parts = title.split(' - ');
  if (parts.length > 1) {
    return parts[parts.length - 1].trim();
  }

  return 'Unknown source';
}

function sourceNameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return 'Unknown source';
  }
}

function sourceHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function normalizeTitleKey(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function isGoogleNewsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === 'news.google.com';
  } catch {
    return false;
  }
}

function isHomepageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.pathname === '/' || url.pathname === '';
  } catch {
    return false;
  }
}

async function resolveArticleUrl(item, decoder) {
  const itemLink = String(item?.link ?? '').trim();
  if (!itemLink) {
    throw new Error('RSS item is missing <link>.');
  }

  let resolvedUrl = itemLink;
  if (isGoogleNewsUrl(itemLink)) {
    const decoded = await decoder.decode(itemLink);
    if (!decoded?.status || !decoded?.decoded_url) {
      throw new Error(`Unable to decode Google News article URL. ${decoded?.message ?? ''}`.trim());
    }

    resolvedUrl = decoded.decoded_url;
  }

  const normalized = normalizeUrl(resolvedUrl);
  if (isGoogleNewsUrl(normalized)) {
    throw new Error('Decoded URL still points to Google News.');
  }
  if (isHomepageUrl(normalized)) {
    throw new Error(`Decoded URL points to source homepage instead of article: ${normalized}`);
  }

  return normalized;
}

function isAccessibilityRelated(title, snippet) {
  const text = `${title ?? ''} ${snippet ?? ''}`.toLowerCase();
  return ACCESSIBILITY_KEYWORDS.some((kw) => text.includes(kw));
}

function stripCodeFenceJson(content) {
  let cleaned = String(content ?? '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

async function readSourceMapFromRssXml(feedUrl) {
  const response = await fetch(feedUrl, {
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch RSS XML (${response.status}).`);
  }

  const xml = await response.text();
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  const map = new Map();

  for (const match of itemMatches) {
    const block = match[1];
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const sourceMatch = block.match(/<source\s+url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);

    if (!titleMatch || !sourceMatch) {
      continue;
    }

    const title = decodeXmlEntities(titleMatch[1] || titleMatch[2] || '');
    const sourceUrl = normalizeUrl(sourceMatch[1]);
    const sourceName = decodeXmlEntities(sourceMatch[2]);

    if (!title || !sourceUrl) {
      continue;
    }

    map.set(normalizeTitleKey(title), {
      sourceUrl,
      sourceName,
    });
  }

  return map;
}

async function collectCandidatesFromRss({ parser, decoder, existing }) {
  const candidates = [];
  let skipped = 0;
  let failed = 0;

  for (const feedUrl of RSS_FEED_URLS) {
    let sourceMap = new Map();
    let feed;
    let items = [];

    try {
      sourceMap = await readSourceMapFromRssXml(feedUrl);
      console.log(`Fetching RSS: ${feedUrl}`);
      feed = await parser.parseURL(feedUrl);
      items = (feed.items ?? []).slice(0, MAX_ITEMS_PER_RUN);
    } catch (error) {
      failed += 1;
      console.error(`Failed to fetch RSS feed: ${feedUrl}`);
      console.error(error);
      continue;
    }

    for (const item of items) {
      const title = String(item.title ?? '').trim().toLowerCase();

      try {
        const keyByTitle = normalizeTitleKey(item.title);
        const mapped = sourceMap.get(keyByTitle);

        const sourceUrl = await resolveArticleUrl(item, decoder);
        const sourceName = mapped?.sourceName || extractSourceName(item) || sourceNameFromUrl(sourceUrl);
        const key = `url:${normalizeUrl(sourceUrl)}`;

        if (!sourceUrl || existing.has(key) || existing.has(`title:${title}`)) {
          skipped += 1;
          continue;
        }

        if (!isAccessibilityRelated(item.title, item.contentSnippet ?? item.content ?? '')) {
          skipped += 1;
          continue;
        }

        const queryRegion = extractQueryRegionFromFeedUrl(feedUrl);

        candidates.push({
          item,
          sourceName,
          sourceUrl,
          title,
          queryRegion,
          sourceCountry: pickSourceCountry({
            sourceUrl,
            queryRegion,
          }),
          ingestType: 'rss',
          ingestSource: normalizeUrl(feedUrl),
          ingestProvider: sourceHostname(feedUrl),
        });
      } catch (error) {
        failed += 1;
        console.error(`Failed on RSS item: ${item.title ?? 'unknown'}`);
        console.error(error);
      }
    }
  }

  return { candidates, skipped, failed };
}

async function collectCandidatesFromNewsApi({ existing }) {
  const candidates = [];
  let skipped = 0;
  let failed = 0;

  if (NEWS_API_QUERIES.length === 0) {
    return { candidates, skipped, failed };
  }

  if (!NEWS_API_KEY) {
    throw new Error('Missing NEWS_API_KEY while NEWS_API_QUERIES is configured.');
  }

  for (const query of NEWS_API_QUERIES) {
    const queryRegion = NEWS_API_QUERY_REGION_MAP[query];
    const endpoint = `${NEWS_API_BASE_URL}?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=${NEWS_API_PAGE_SIZE}`;
    console.log(`Fetching NewsAPI: ${query}`);

    let response;
    try {
      response = await fetch(endpoint, {
        headers: {
          'X-Api-Key': NEWS_API_KEY,
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new Error(`NewsAPI request failed for query "${query}": ${error?.message ?? 'unknown error'}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`NewsAPI returned ${response.status} for query "${query}": ${text}`);
    }

    const data = await response.json();
    if (data?.status !== 'ok' || !Array.isArray(data?.articles)) {
      throw new Error(`NewsAPI response shape invalid for query "${query}".`);
    }

    const articles = data.articles.slice(0, MAX_ITEMS_PER_RUN);
    for (const article of articles) {
      const title = String(article.title ?? '').trim();
      const normalizedTitle = title.toLowerCase();
      const sourceUrl = normalizeUrl(String(article.url ?? '').trim());
      const sourceName = String(article?.source?.name ?? '').trim() || sourceNameFromUrl(sourceUrl);
      const key = `url:${sourceUrl}`;

      try {
        if (!sourceUrl || !title || existing.has(key) || existing.has(`title:${normalizedTitle}`)) {
          skipped += 1;
          continue;
        }

        const snippet = String(article.description ?? article.content ?? '');
        if (!isAccessibilityRelated(title, snippet)) {
          skipped += 1;
          continue;
        }

        candidates.push({
          item: {
            title,
            contentSnippet: snippet,
            content: String(article.content ?? ''),
            isoDate: String(article.publishedAt ?? ''),
            pubDate: String(article.publishedAt ?? ''),
          },
          sourceName,
          sourceUrl,
          title: normalizedTitle,
          queryRegion,
          sourceCountry: pickSourceCountry({ sourceUrl, queryRegion }),
          ingestType: 'newsapi',
          ingestSource: 'newsapi.org',
          ingestProvider: sourceHostname(NEWS_API_BASE_URL),
        });
      } catch (error) {
        failed += 1;
        console.error(`Failed on NewsAPI item: ${title || 'unknown'}`);
        console.error(error);
      }
    }
  }

  return { candidates, skipped, failed };
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

async function upsertMonthlyNewsStory(story) {
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

async function readExistingKeys() {
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

async function retryOllama(fn, groqFn, batchIndex) {
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

function buildBatchPrompt(batchItems) {
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

function parseBatchResponse(content) {
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

async function askOllamaForBatch(batchItems) {
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

async function askGroqForBatch(batchItems) {
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

async function writeStoryPair(item, ai, sourceName, sourceUrl, sourceCountry, queryRegion, ingestMeta = {}) {
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

  return { canonicalUrl, enFile, zhFile };
}

async function main() {
  const parser = new Parser();
  const decoder = new GoogleDecoder();

  const existing = await readExistingKeys();

  let created = 0;
  let failed = 0;
  let skipped = 0;

  const rssResult = await collectCandidatesFromRss({ parser, decoder, existing });
  const newsApiResult = await collectCandidatesFromNewsApi({ existing });

  console.log(`[news] rss_candidates=${rssResult.candidates.length}`);
  console.log(`[news] newsapi_candidates=${newsApiResult.candidates.length}`);

  let candidates = [...rssResult.candidates, ...newsApiResult.candidates];
  skipped += rssResult.skipped + newsApiResult.skipped;
  failed += rssResult.failed + newsApiResult.failed;

  const seen = new Set();
  candidates = candidates.filter((entry) => {
    const key = `url:${normalizeUrl(entry.sourceUrl)}`;
    if (seen.has(key) || existing.has(key)) {
      skipped += 1;
      return false;
    }
    seen.add(key);
    return true;
  });

  console.log(`Candidates queued: ${candidates.length}`);

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const outputMap = new Map();

    try {
      const outputs = await retryOllama(() => askOllamaForBatch(batch), () => askGroqForBatch(batch), i);
      for (const item of outputs) {
        outputMap.set(item.itemId, item);
      }
    } catch (error) {
      console.error(`Failed on batch starting index ${i}; attempting per-item fallback`);
      console.error(error);
    }

    for (let j = 0; j < batch.length; j += 1) {
      const entry = batch[j];
      const titleKey = `title:${entry.title}`;
      if (existing.has(titleKey)) {
        skipped += 1;
        continue;
      }
      let output = outputMap.get(j);

      if (!output) {
        try {
          const single = await retryOllama(() => askOllamaForBatch([entry]), () => askGroqForBatch([entry]), `${i + j}/single`);
          output = single.find((row) => row.itemId === 0);
        } catch (singleError) {
          failed += 1;
          console.error(`Single-item fallback failed at global index ${i + j}`);
          console.error(singleError);
          continue;
        }
      }

      const forceRelevant = entry.ingestType === 'rss' && entry.ingestProvider !== 'news.google.com';
      if (!output) {
        failed += 1;
        console.error(`Missing LLM output item for batch index ${j} (global ${i + j})`);
        continue;
      }

      if (!output.isRelevant && !forceRelevant) {
        skipped += 1;
        continue;
      }

      const zhTitleRaw = output.zhTitle || entry.item.title || '無障礙新聞';
      const zhSummaryRaw = output.zhSummary || entry.item.contentSnippet || '';

      const ai = {
        englishTitle: output.englishTitle || entry.item.title || 'Accessibility update',
        englishSummary: output.englishSummary || entry.item.contentSnippet || '',
        zhTitle: hasZhChars(zhTitleRaw) ? zhTitleRaw : '無障礙新聞',
        zhSummary: hasZhChars(zhSummaryRaw) ? zhSummaryRaw : '此新聞的中文摘要尚待翻譯。',
        category: output.category,
        tags: output.tags,
      };

      try {
        const result = await writeStoryPair(
          entry.item,
          ai,
          entry.sourceName,
          entry.sourceUrl,
          entry.sourceCountry,
          entry.queryRegion,
          {
            ingestType: entry.ingestType,
            ingestSource: entry.ingestSource,
            ingestProvider: entry.ingestProvider,
          },
        );
        existing.add(`url:${result.canonicalUrl}`);
        existing.add(`title:${entry.title}`);
        created += 1;
        console.log(`Created: ${result.enFile} + ${result.zhFile}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed on item write: ${entry.item.title ?? 'unknown'}`);
        console.error(error);
      }
    }
  }

  console.log(`Done. New stories: ${created}, Skipped: ${skipped}, Failed: ${failed}`);
  if (failed > 0 && created === 0) {
    throw new Error(`Failed processing ${failed} item(s) with no new stories created.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
