import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApifyClient } from 'apify-client';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

const CONTENT_DIR = path.resolve('src/content/news');
const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = requireEnv('OLLAMA_BASE_URL').replace(/\/$/, '');
const OLLAMA_API_KEY = requireEnv('OLLAMA_API_KEY');
const OLLAMA_MODEL = requireEnv('OLLAMA_MODEL');
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const OLLAMA_MAX_TOKENS = Math.max(1, Math.min(20000, Number(process.env.OLLAMA_MAX_TOKENS ?? 20000)));
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);
const BATCH_SIZE = Math.min(5, Math.max(3, Number(process.env.BATCH_SIZE ?? 3)));

const APIFY_TOKEN = requireEnv('APIFY_TOKEN');
const APIFY_ACTOR_ID = requireEnv('APIFY_ACTOR_ID');
const A11Y_QUERY = String(process.env.A11Y_TWEET_QUERY ?? '').trim();
const A11Y_KEYWORDS = String(process.env.A11Y_TWEET_KEYWORDS ?? 'a11y,accessibility,inclusion')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const A11Y_TARGET_ACCOUNTS = String(process.env.A11Y_TWEET_ACCOUNTS ?? 'BlindNewWorld,UCBInfo,makoto_ueki,bakera,magi1125,momdo_,A11yTYO,waic_jp,porta11y,NPOJD,DPIJAPAN,AccessibleJapan,rouarenmei,seinenkyou')
  .split(',')
  .map((value) => value.trim().replace(/^@+/, ''))
  .filter(Boolean);
const A11Y_WINDOW_HOURS = Number(process.env.A11Y_TWEET_WINDOW_HOURS ?? 24);
const A11Y_MAX_ITEMS = Number(process.env.A11Y_TWEET_MAX_ITEMS ?? 100);
const A11Y_LANGUAGES = String(process.env.A11Y_TWEET_LANGUAGES ?? 'en,zh,ja,ko')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const A11Y_DEBUG = process.env.A11Y_TWEET_DEBUG === '1';

function safeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 10);
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
    return String(rawUrl ?? '').trim();
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

function toLangCode(rawLang) {
  const lang = String(rawLang ?? '').toLowerCase();
  if (!lang) return '';
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  return lang;
}

function parseTweetId(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) {
    return text;
  }

  const match = text.match(/\/status\/(\d+)/);
  if (match) {
    return match[1];
  }

  return '';
}

function parseTweetUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  if (/^https?:\/\//i.test(text)) {
    return normalizeUrl(text);
  }

  return '';
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function inferTweet(record) {
  const raw = record ?? {};
  const rawType = String(raw.type ?? '').trim().toLowerCase();
  const tweetUrl = parseTweetUrl(firstNonEmpty([
    raw.url,
    raw.twitterUrl,
    raw.tweetUrl,
    raw.permanentUrl,
    raw.permalink,
    raw.link,
  ]));

  const tweetId = parseTweetId(firstNonEmpty([
    raw.id,
    raw.tweetId,
    raw.id_str,
    raw.rest_id,
    tweetUrl,
  ]));

  const text = firstNonEmpty([
    raw.fullText,
    raw.text,
    raw.tweetText,
    raw.content,
    raw.legacy?.full_text,
  ]);

  const createdAt = toIsoDate(firstNonEmpty([
    raw.createdAt,
    raw.created_at,
    raw.timeParsed,
    raw.timestamp,
    raw.date,
    raw.legacy?.created_at,
  ]));

  const rawLang = firstNonEmpty([
    raw.lang,
    raw.language,
    raw.isoLanguageCode,
    raw.legacy?.lang,
  ]);

  const isReply = Boolean(raw.isReply || raw.inReplyToStatusId || raw.in_reply_to_status_id || raw.inReplyToUserId || raw.inReplyToId);
  const isRetweet = Boolean(raw.isRetweet || raw.retweeted || raw.retweetedTweet || raw.retweeted_status || raw.retweeted_tweet);
  const isQuote = Boolean(raw.isQuote || raw.quotedStatusId || raw.quoted_status_id || raw.isQuoted || raw.quoted_tweet || raw.quoted_tweet_results);

  const authorName = firstNonEmpty([
    raw.authorName,
    raw.name,
    raw.author?.name,
    raw.author?.userName,
    raw.author?.user?.name,
    raw.user?.name,
    raw.author?.name,
    raw.username,
    raw.user?.username,
    raw.author?.username,
    raw.core?.user_results?.result?.legacy?.name,
    'X user',
  ]);

  const authorHandle = firstNonEmpty([
    raw.authorUsername,
    raw.author?.userName,
    raw.author?.username,
    raw.username,
    raw.user?.username,
    raw.author?.username,
    raw.core?.user_results?.result?.legacy?.screen_name,
  ]).replace(/^@/, '');

  const externalCandidates = [];
  const entitiesUrls = raw.entities?.urls;
  if (Array.isArray(entitiesUrls)) {
    for (const item of entitiesUrls) {
      externalCandidates.push(item?.expanded_url, item?.expandedUrl, item?.url);
    }
  }

  const legacyEntitiesUrls = raw.legacy?.entities?.urls;
  if (Array.isArray(legacyEntitiesUrls)) {
    for (const item of legacyEntitiesUrls) {
      externalCandidates.push(item?.expanded_url, item?.expandedUrl, item?.url);
    }
  }

  const links = raw.links;
  if (Array.isArray(links)) {
    for (const item of links) {
      externalCandidates.push(item?.expanded_url, item?.expandedUrl, item?.url, item);
    }
  }

  externalCandidates.push(raw.externalUrl, raw.expandedUrl);
  const externalUrl = normalizeUrl(firstNonEmpty(externalCandidates));

  return {
    tweetId,
    tweetUrl,
    text,
    createdAt,
    lang: toLangCode(rawLang),
    type: rawType,
    isReply,
    isRetweet,
    isQuote,
    authorName,
    authorHandle,
    externalUrl: externalUrl && externalUrl !== tweetUrl ? externalUrl : '',
  };
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

function formatActorUtc(value) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  const seconds = String(value.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}:${minutes}:${seconds}_UTC`;
}

function buildSearchExpressions() {
  if (A11Y_QUERY) {
    return [A11Y_QUERY];
  }

  const keywordParts = A11Y_KEYWORDS.map((keyword) => keyword.includes(' ') ? `"${keyword}"` : keyword);
  const accountParts = A11Y_TARGET_ACCOUNTS.map((handle) => `from:${handle}`);
  const allParts = [...keywordParts, ...accountParts];

  if (allParts.length === 0) {
    return ['a11y'];
  }

  // Split into batches of max 5 OR terms to avoid X anti-scraping
  const MAX_TERMS_PER_QUERY = 5;
  const expressions = [];
  for (let i = 0; i < allParts.length; i += MAX_TERMS_PER_QUERY) {
    const batch = allParts.slice(i, i + MAX_TERMS_PER_QUERY);
    expressions.push(batch.length === 1 ? batch[0] : `(${batch.join(' OR ')})`);
  }
  return expressions;
}

function buildActorInputs() {
  const now = new Date();
  const since = new Date(now.getTime() - (A11Y_WINDOW_HOURS * 60 * 60 * 1000));
  const timeClause = `since:${formatActorUtc(since)} until:${formatActorUtc(now)}`;

  const baseInput = {
    tweetIDs: [],
    twitterContent: '',
    maxItems: A11Y_MAX_ITEMS,
    queryType: 'Latest',
    'filter:blue_verified': false,
    'filter:nativeretweets': true,
    'include:nativeretweets': false,
    'filter:replies': true,
    'filter:has_engagement': false,
    min_retweets: 0,
    min_faves: 0,
    min_replies: 0,
    '-min_retweets': 0,
    '-min_faves': 0,
    '-min_replies': 0,
    'filter:media': false,
    'filter:twimg': false,
    'filter:images': false,
    'filter:videos': false,
    'filter:native_video': false,
    'filter:vine': false,
    'filter:consumer_video': false,
    'filter:pro_video': false,
    'filter:spaces': false,
    'filter:links': false,
    'filter:mentions': false,
    'filter:news': false,
    'filter:safe': false,
    'filter:hashtags': false,
  };

  return buildSearchExpressions().map((expr) => ({
    ...baseInput,
    searchTerms: [`${expr} ${timeClause}`],
  }));
}

async function readExistingTweetKeys() {
  const tweetUrlKeys = new Set();

  try {
    const files = await fs.readdir(NEWS_DATA_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(NEWS_DATA_DIR, file);
      const raw = await fs.readFile(filePath, 'utf8');
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        const sourceUrl = normalizeUrl(row?.sourceUrl ?? '');
        if (sourceUrl) {
          tweetUrlKeys.add(sourceUrl);
        }
      }
    }
  } catch {
    await fs.mkdir(NEWS_DATA_DIR, { recursive: true });
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
      if (sourceUrlMatch) {
        tweetUrlKeys.add(normalizeUrl(sourceUrlMatch[1]));
      }
    }
  } catch {
    await fs.mkdir(CONTENT_DIR, { recursive: true });
  }

  return tweetUrlKeys;
}

function dedupeCandidates(rows) {
  const byTweetId = new Map();

  for (const row of rows) {
    const prev = byTweetId.get(row.tweetId);
    if (!prev) {
      byTweetId.set(row.tweetId, row);
      continue;
    }

    if (Date.parse(row.createdAt) >= Date.parse(prev.createdAt)) {
      byTweetId.set(row.tweetId, row);
    }
  }

  const dedupedByTweet = Array.from(byTweetId.values());
  const byExternal = new Map();
  const withoutExternal = [];

  for (const row of dedupedByTweet) {
    if (!row.externalUrl) {
      withoutExternal.push(row);
      continue;
    }

    const prev = byExternal.get(row.externalUrl);
    if (!prev || Date.parse(row.createdAt) >= Date.parse(prev.createdAt)) {
      byExternal.set(row.externalUrl, row);
    }
  }

  return [...withoutExternal, ...Array.from(byExternal.values())]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function retryOllama(fn, batchIndex) {
  let lastError;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < OLLAMA_MAX_RETRIES) {
        const delay = attempt * 2000;
        console.warn(`[ollama] Batch ${batchIndex} attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.error(`[ollama] Batch ${batchIndex} exhausted retries=${OLLAMA_MAX_RETRIES} timeout_ms=${OLLAMA_TIMEOUT_MS} model=${OLLAMA_MODEL}`);
  throw lastError;
}

async function askOllamaForBatch(batchItems) {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  const payload = batchItems.map((entry, index) => ({
    itemId: index,
    tweetId: entry.tweetId,
    lang: entry.lang,
    isQuote: entry.isQuote,
    text: entry.text,
    authorName: entry.authorName,
    authorHandle: entry.authorHandle,
    tweetUrl: entry.tweetUrl,
    externalUrl: entry.externalUrl,
  }));

  const userPrompt = [
    'You are an accessibility social media editor.',
    'For each tweet item, first decide if it is related to accessibility, disability, assistive technology, inclusive design, or related advocacy.',
    'If not related, return: {"itemId": <id>, "isRelevant": false}',
    'If related, produce bilingual metadata for an accessibility news website.',
    'Return strict JSON array only. No markdown, no extra text.',
    'Each relevant output item must include keys:',
    'itemId, isRelevant, englishTitle, englishSummary, zhTitle, zhSummary, tags.',
    'Keep title concise. Keep summary to 1-2 sentences with factual wording only.',
    'The category is fixed and NOT returned: social-signals.',
    '',
    JSON.stringify(payload),
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

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFenceJson(content));
  } catch {
    throw new Error(`Ollama returned invalid JSON: ${content.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Ollama batch response is not an array.');
  }

  return parsed.map((row) => ({
    itemId: Number(row?.itemId),
    isRelevant: row?.isRelevant !== false,
    englishTitle: String(row?.englishTitle || '').trim(),
    englishSummary: String(row?.englishSummary || '').trim(),
    zhTitle: String(row?.zhTitle || '').trim(),
    zhSummary: String(row?.zhSummary || '').trim(),
    tags: safeStringArray(row?.tags),
  }));
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

async function writeStoryPair(entry, ai) {
  const canonicalTweetUrl = normalizeUrl(entry.tweetUrl);
  const publishedAt = toIsoDate(entry.createdAt);
  const fetchedAt = new Date().toISOString();
  const hash = crypto.createHash('sha1').update(entry.tweetId).digest('hex').slice(0, 8);

  const baseSlug = slugify(ai.englishTitle) || `social-signal-${hash}`;
  const enSlug = `${baseSlug}-${hash}`;
  const zhSlug = `${baseSlug}-zh-${hash}`;
  const clusterId = `cluster-tw-${entry.tweetId}`;

  const sourceName = entry.authorHandle
    ? `${entry.authorName} (@${entry.authorHandle})`
    : entry.authorName;

  const langToCountry = { ja: 'JP', zh: 'TW', en: 'US', ko: 'KR' };
  const sourceCountry = langToCountry[entry.lang] || '';

  const tags = Array.from(new Set([
    'a11y',
    'social-signals',
    entry.lang || '',
    ...ai.tags,
  ].filter(Boolean)));

  const relatedSources = [];
  if (entry.externalUrl) {
    relatedSources.push({
      name: 'External link from tweet',
      url: normalizeUrl(entry.externalUrl),
    });
  }

  const enStory = {
    title: ai.englishTitle,
    slug: enSlug,
    lang: 'en',
    summary: ai.englishSummary,
    category: 'social-signals',
    tags,
    sourceName,
    sourceUrl: canonicalTweetUrl,
    sourceCountry,
    queryRegion: sourceCountry,
    region: sourceCountry,
    relatedSources,
    ingestType: 'x',
    ingestSource: 'x.com',
    ingestProvider: 'x.com',
    clusterId,
    status: 'published',
    translationOf: zhSlug,
    publishedAt,
    fetchedAt,
    body: [
      ai.englishSummary,
      '',
      `Tweet source: [${sourceName}](${canonicalTweetUrl})`,
      entry.externalUrl ? `External link: [${entry.externalUrl}](${entry.externalUrl})` : '',
    ].filter(Boolean).join('\n'),
  };

  const zhStory = {
    title: ai.zhTitle,
    slug: zhSlug,
    lang: 'zh-TW',
    summary: ai.zhSummary,
    category: 'social-signals',
    tags,
    sourceName,
    sourceUrl: canonicalTweetUrl,
    sourceCountry,
    queryRegion: sourceCountry,
    region: sourceCountry,
    relatedSources,
    ingestType: 'x',
    ingestSource: 'x.com',
    ingestProvider: 'x.com',
    clusterId,
    status: 'published',
    translationOf: enSlug,
    publishedAt,
    fetchedAt,
    body: [
      ai.zhSummary,
      '',
      `推文來源： [${sourceName}](${canonicalTweetUrl})`,
      entry.externalUrl ? `外部連結： [${entry.externalUrl}](${entry.externalUrl})` : '',
    ].filter(Boolean).join('\n'),
  };

  const enFile = await upsertMonthlyNewsStory(enStory);
  const zhFile = await upsertMonthlyNewsStory(zhStory);

  return { canonicalTweetUrl, enFile, zhFile };
}

async function fetchTweetItemsForInput(client, input) {
  const run = await client.actor(APIFY_ACTOR_ID).call(input);

  if (run.status !== 'SUCCEEDED') {
    console.warn(`[tweets] Apify run status=${run.status} for query: ${input.searchTerms[0]?.slice(0, 80)}...`);
    return [];
  }

  if (!run.defaultDatasetId) {
    console.warn('[tweets] Apify run missing defaultDatasetId');
    return [];
  }

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true, limit: A11Y_MAX_ITEMS });
  return Array.isArray(items) ? items : [];
}

async function fetchTweetItems() {
  if (!APIFY_TOKEN) {
    throw new Error('Missing APIFY_TOKEN.');
  }

  const client = new ApifyClient({ token: APIFY_TOKEN });
  const inputs = buildActorInputs();

  console.log(`[tweets] Splitting into ${inputs.length} queries (max 5 OR terms each)`);

  const allItems = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const queryPreview = input.searchTerms[0]?.slice(0, 100);

    if (A11Y_DEBUG) {
      console.log(`[tweets] Query ${i + 1}/${inputs.length}: ${queryPreview}...`);
    }

    try {
      const items = await fetchTweetItemsForInput(client, input);
      console.log(`[tweets] Query ${i + 1}/${inputs.length}: ${items.length} items — ${queryPreview}...`);
      allItems.push(...items);
    } catch (error) {
      console.warn(`[tweets] Query ${i + 1}/${inputs.length} failed: ${error.message}`);
    }

    // Small delay between Apify calls to avoid rate limits
    if (i < inputs.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`[tweets] Total raw items across ${inputs.length} queries: ${allItems.length}`);

  if (allItems.length === 0) {
    throw new Error('All Apify queries returned empty. Apify may be blocking these searches.');
  }

  return allItems;
}

function filterCandidates(rawItems, existingTweetUrls) {
  const now = Date.now();
  const lowerBound = now - (A11Y_WINDOW_HOURS * 60 * 60 * 1000);

  const inferred = rawItems
    .map(inferTweet)
    .filter((row) => {
      if (row.type === 'mock_tweet') {
        return false;
      }

      if (!row.tweetId || !row.tweetUrl || !row.text) {
        return false;
      }

      const ts = Date.parse(row.createdAt);
      if (Number.isNaN(ts) || ts < lowerBound || ts > now) {
        return false;
      }

      if (!A11Y_LANGUAGES.includes(row.lang)) {
        return false;
      }

      if (row.isReply || row.isRetweet) {
        return false;
      }

      if (existingTweetUrls.has(normalizeUrl(row.tweetUrl))) {
        return false;
      }

      return true;
    });

  return dedupeCandidates(inferred);
}

async function main() {
  const existingTweetUrls = await readExistingTweetKeys();
  const rawItems = await fetchTweetItems();
  const candidates = filterCandidates(rawItems, existingTweetUrls);

  console.log(`[tweets] raw_items=${rawItems.length}`);
  console.log(`[tweets] filtered_candidates=${candidates.length}`);

  if (candidates.length === 0) {
    const sampleKeys = Object.keys(rawItems[0] ?? {}).sort();
    throw new Error(`No eligible tweets found after filtering and dedupe. Raw items: ${rawItems.length}. Sample keys: ${sampleKeys.join(', ')}`);
  }

  let created = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const outputMap = new Map();

    try {
      const outputs = await retryOllama(() => askOllamaForBatch(batch), i);
      for (const item of outputs) {
        outputMap.set(item.itemId, item);
      }
    } catch (error) {
      console.error(`Failed on batch starting index ${i}; attempting per-item fallback`);
      console.error(error);
    }

    for (let j = 0; j < batch.length; j += 1) {
      const entry = batch[j];
      let output = outputMap.get(j);

      if (!output) {
        try {
          const single = await retryOllama(() => askOllamaForBatch([entry]), `${i + j}/single`);
          output = single.find((row) => row.itemId === 0);
        } catch (singleError) {
          failed += 1;
          console.error(`Single-item fallback failed at global index ${i + j}`);
          console.error(singleError);
          continue;
        }
      }

      if (!output) {
        failed += 1;
        console.error(`Missing LLM output item for batch index ${j} (global ${i + j})`);
        continue;
      }

      if (!output.isRelevant) {
        console.log(`Skipped (not accessibility-related): ${entry.tweetId}`);
        continue;
      }

      const ai = {
        englishTitle: output.englishTitle || `A11y social signal ${entry.tweetId}`,
        englishSummary: output.englishSummary || entry.text,
        zhTitle: output.zhTitle || `無障礙社群訊號 ${entry.tweetId}`,
        zhSummary: output.zhSummary || entry.text,
        tags: output.tags,
      };

      try {
        const result = await writeStoryPair(entry, ai);
        created += 1;
        console.log(`Created: ${result.enFile} + ${result.zhFile}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed on item write: ${entry.tweetId}`);
        console.error(error);
      }
    }
  }

  console.log(`Done. New tweet stories: ${created}, Failed: ${failed}`);
  if (failed > 0) {
    throw new Error(`Failed processing ${failed} tweet item(s). See logs above for details.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
