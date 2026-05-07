import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

const NEWS_DATA_DIR = path.resolve('src/data/news');
const CONTENT_DIR = path.resolve('src/content/news');
const OLLAMA_BASE_URL = requireEnv('OLLAMA_BASE_URL').replace(/\/$/, '');
const OLLAMA_API_KEY = requireEnv('OLLAMA_API_KEY');
const OLLAMA_MODEL = requireEnv('OLLAMA_MODEL');
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const OLLAMA_MAX_TOKENS = Math.max(1, Math.min(20000, Number(process.env.OLLAMA_MAX_TOKENS ?? 20000)));
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);

const BRIGHTDATA_API_KEY = requireEnv('BRIGHTDATA_API_KEY');
const BRIGHTDATA_FACEBOOK_DATASET_ID = String(process.env.BRIGHTDATA_FACEBOOK_DATASET_ID ?? 'gd_lkaxegm826bjpoo9m5').trim();
const BRIGHTDATA_FACEBOOK_PAGE_URL = String(process.env.BRIGHTDATA_FACEBOOK_PAGE_URL ?? 'https://www.facebook.com/silence.deaf/').trim();
const BRIGHTDATA_FACEBOOK_WINDOW_HOURS = Number(process.env.BRIGHTDATA_FACEBOOK_WINDOW_HOURS ?? 24);
const BRIGHTDATA_FACEBOOK_MAX_POSTS = Math.max(1, Number(process.env.BRIGHTDATA_FACEBOOK_MAX_POSTS ?? 3));
const BRIGHTDATA_TIMEOUT_MS = Number(process.env.BRIGHTDATA_TIMEOUT_MS ?? 180000);
const BRIGHTDATA_MAX_RETRIES = Number(process.env.BRIGHTDATA_MAX_RETRIES ?? 3);
const BRIGHTDATA_POLL_INTERVAL_MS = Number(process.env.BRIGHTDATA_POLL_INTERVAL_MS ?? 5000);
const BRIGHTDATA_MAX_POLL_ATTEMPTS = Number(process.env.BRIGHTDATA_MAX_POLL_ATTEMPTS ?? 36);

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const blocked = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content'];
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

function safeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 10);
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

async function readExistingSourceUrls() {
  const urls = new Set();

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
        if (sourceUrl) urls.add(sourceUrl);
      }
    }
  } catch {
    await fs.mkdir(NEWS_DATA_DIR, { recursive: true });
  }

  try {
    const files = await fs.readdir(CONTENT_DIR);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(CONTENT_DIR, file);
      const text = await fs.readFile(filePath, 'utf8');
      const sourceUrlMatch = text.match(/^sourceUrl:\s*"(.+)"$/m);
      if (sourceUrlMatch) {
        urls.add(normalizeUrl(sourceUrlMatch[1]));
      }
    }
  } catch {
    await fs.mkdir(CONTENT_DIR, { recursive: true });
  }

  return urls;
}

async function fetchFacebookPagePosts() {
  const endpoint = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(BRIGHTDATA_FACEBOOK_DATASET_ID)}&format=json`;
  const progressEndpoint = 'https://api.brightdata.com/datasets/v3/progress';
  const snapshotEndpoint = 'https://api.brightdata.com/datasets/v3/snapshot';

  const downloadSnapshotRows = async (snapshotId) => {
    for (let poll = 1; poll <= BRIGHTDATA_MAX_POLL_ATTEMPTS; poll += 1) {
      const progressResp = await fetch(`${progressEndpoint}/${encodeURIComponent(snapshotId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${BRIGHTDATA_API_KEY}`,
        },
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUT_MS),
      });

      if (!progressResp.ok) {
        const text = await progressResp.text();
        throw new Error(`Bright Data progress check failed: ${progressResp.status} ${text}`);
      }

      const progress = await progressResp.json();
      const status = String(progress?.status ?? '').toLowerCase();

      if (status === 'failed') {
        throw new Error(`Bright Data snapshot failed: ${JSON.stringify(progress)}`);
      }

      const snapshotResp = await fetch(`${snapshotEndpoint}/${encodeURIComponent(snapshotId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${BRIGHTDATA_API_KEY}`,
        },
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUT_MS),
      });

      if (snapshotResp.status === 202) {
        if (poll < BRIGHTDATA_MAX_POLL_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, BRIGHTDATA_POLL_INTERVAL_MS));
          continue;
        }
        const text = await snapshotResp.text();
        throw new Error(`Bright Data snapshot still not ready after polling: ${text}`);
      }

      if (!snapshotResp.ok) {
        const text = await snapshotResp.text();
        throw new Error(`Bright Data snapshot download failed: ${snapshotResp.status} ${text}`);
      }

      const data = await snapshotResp.json();
      if (!Array.isArray(data)) {
        throw new Error('Bright Data snapshot download returned non-array payload.');
      }

      return data;
    }

    throw new Error('Bright Data snapshot polling exhausted.');
  };

  let lastError;

  for (let attempt = 1; attempt <= BRIGHTDATA_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BRIGHTDATA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ url: BRIGHTDATA_FACEBOOK_PAGE_URL, num_of_posts: BRIGHTDATA_FACEBOOK_MAX_POSTS }]),
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Bright Data Facebook scrape failed: ${response.status} ${text}`);
      }

      const data = await response.json();
      if (Array.isArray(data)) {
        return data;
      }

      const snapshotId = String(data?.snapshot_id ?? '').trim();
      if (snapshotId) {
        console.log(`[facebook] BrightData snapshot_id=${snapshotId}`);
        return await downloadSnapshotRows(snapshotId);
      }

      throw new Error(`Bright Data Facebook scrape returned unsupported payload: ${JSON.stringify(data).slice(0, 400)}`);
    } catch (error) {
      lastError = error;
      if (attempt < BRIGHTDATA_MAX_RETRIES) {
        const delay = attempt * 3000;
        console.warn(`[facebook] BrightData attempt ${attempt} failed (${error?.message ?? 'unknown'}). Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

function inferCandidate(row) {
  const postUrl = normalizeUrl(String(row?.url ?? '').trim());
  const postText = String(row?.content ?? row?.post_text ?? '').trim();
  const datePosted = toIsoDate(String(row?.date_posted ?? '').trim());
  const pageName = String(row?.page_name ?? '').trim() || 'Facebook Page';
  const pageUrl = normalizeUrl(String(row?.page_url ?? BRIGHTDATA_FACEBOOK_PAGE_URL).trim());
  const handle = String(row?.profile_handle ?? row?.user_username_raw ?? '').trim();
  const postId = String(row?.post_id ?? row?.shortcode ?? '').trim()
    || crypto.createHash('sha1').update(`${postUrl}|${datePosted}`).digest('hex').slice(0, 12);

  return {
    postId,
    postUrl,
    postText,
    datePosted,
    pageName,
    pageUrl,
    handle,
  };
}

function filterCandidates(rawRows, existingSourceUrls) {
  const unique = new Map();

  for (const rawRow of rawRows) {
    const row = inferCandidate(rawRow);
    if (!row.postUrl || !row.postText) continue;
    if (existingSourceUrls.has(row.postUrl)) continue;

    const prev = unique.get(row.postId);
    if (!prev || Date.parse(row.datePosted) >= Date.parse(prev.datePosted)) {
      unique.set(row.postId, row);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => Date.parse(b.datePosted) - Date.parse(a.datePosted))
    .slice(0, BRIGHTDATA_FACEBOOK_MAX_POSTS);
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
        console.warn(`[ollama] Batch ${batchIndex} attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.error(`[ollama] Batch ${batchIndex} exhausted retries=${OLLAMA_MAX_RETRIES} timeout_ms=${OLLAMA_TIMEOUT_MS} model=${OLLAMA_MODEL}`);
  throw lastError;
}

async function askOllamaForBatch(batchItems) {
  const payload = batchItems.map((entry, index) => ({
    itemId: index,
    postId: entry.postId,
    text: entry.postText,
    pageName: entry.pageName,
    pageUrl: entry.pageUrl,
    postUrl: entry.postUrl,
    datePosted: entry.datePosted,
  }));

  const userPrompt = [
    'You are an accessibility social editor.',
    'Each input is a Facebook page post. Summarize it in English and Traditional Chinese.',
    'Return a strict JSON array and nothing else.',
    'Each output item must include: itemId, englishTitle, englishSummary, zhTitle, zhSummary, tags.',
    'Category is fixed and NOT returned: social-signals.',
    'Tags must be relevant to accessibility, disability, or inclusion.',
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
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: userPrompt },
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
    englishTitle: String(row?.englishTitle || '').trim(),
    englishSummary: String(row?.englishSummary || '').trim(),
    zhTitle: String(row?.zhTitle || '').trim(),
    zhSummary: String(row?.zhSummary || '').trim(),
    tags: safeStringArray(row?.tags),
  }));
}

async function writeStoryPair(entry, ai) {
  const canonicalPostUrl = normalizeUrl(entry.postUrl);
  const publishedAt = toIsoDate(entry.datePosted);
  const fetchedAt = new Date().toISOString();
  const hash = crypto.createHash('sha1').update(entry.postId).digest('hex').slice(0, 8);

  const baseSlug = slugify(ai.englishTitle) || `facebook-social-${hash}`;
  const enSlug = `${baseSlug}-${hash}`;
  const zhSlug = `${baseSlug}-zh-${hash}`;
  const clusterId = `cluster-fb-${entry.postId}`;

  const sourceName = entry.handle
    ? `${entry.pageName} (@${entry.handle})`
    : `${entry.pageName} (Facebook)`;

  const tags = Array.from(new Set([
    'a11y',
    'social-signals',
    'facebook',
    ...ai.tags,
  ].filter(Boolean)));

  const relatedSources = [
    {
      name: 'Facebook page',
      url: normalizeUrl(entry.pageUrl),
    },
  ];

  const enStory = {
    title: ai.englishTitle,
    slug: enSlug,
    lang: 'en',
    summary: ai.englishSummary,
    category: 'social-signals',
    tags,
    sourceName,
    sourceUrl: canonicalPostUrl,
    relatedSources,
    ingestType: 'facebook',
    ingestSource: normalizeUrl(BRIGHTDATA_FACEBOOK_PAGE_URL),
    ingestProvider: 'facebook.com',
    clusterId,
    status: 'published',
    translationOf: zhSlug,
    publishedAt,
    fetchedAt,
    body: [
      ai.englishSummary,
      '',
      `Facebook post source: [${sourceName}](${canonicalPostUrl})`,
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
    sourceUrl: canonicalPostUrl,
    relatedSources,
    ingestType: 'facebook',
    ingestSource: normalizeUrl(BRIGHTDATA_FACEBOOK_PAGE_URL),
    ingestProvider: 'facebook.com',
    clusterId,
    status: 'published',
    translationOf: enSlug,
    publishedAt,
    fetchedAt,
    body: [
      ai.zhSummary,
      '',
      `Facebook 貼文來源： [${sourceName}](${canonicalPostUrl})`,
    ].filter(Boolean).join('\n'),
  };

  const enFile = await upsertMonthlyNewsStory(enStory);
  const zhFile = await upsertMonthlyNewsStory(zhStory);

  return { enFile, zhFile };
}

async function main() {
  const existingSourceUrls = await readExistingSourceUrls();
  const rawRows = await fetchFacebookPagePosts();
  const candidates = filterCandidates(rawRows, existingSourceUrls);

  console.log(`[facebook] dataset_id=${BRIGHTDATA_FACEBOOK_DATASET_ID}`);
  console.log(`[facebook] page_url=${normalizeUrl(BRIGHTDATA_FACEBOOK_PAGE_URL)}`);
  console.log(`[facebook] raw_posts=${rawRows.length}`);
  console.log(`[facebook] filtered_posts=${candidates.length}`);

  if (candidates.length === 0) {
    console.log('[facebook] No eligible posts found in lookback window.');
    return;
  }

  let created = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const outputMap = new Map();

    try {
      const outputs = await retryOllama(() => askOllamaForBatch(batch), i);
      for (const item of outputs) {
        outputMap.set(item.itemId, item);
      }
    } catch (error) {
      console.error(`[facebook] Failed on batch starting index ${i}; attempting per-item fallback`);
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
          console.error(`[facebook] Single-item fallback failed at global index ${i + j}`);
          console.error(singleError);
          continue;
        }
      }

      if (!output) {
        failed += 1;
        console.error(`[facebook] Missing LLM output item for batch index ${j} (global ${i + j})`);
        continue;
      }

      const ai = {
        englishTitle: output.englishTitle || `Facebook accessibility update ${entry.postId}`,
        englishSummary: output.englishSummary || entry.postText,
        zhTitle: output.zhTitle || `Facebook 無障礙更新 ${entry.postId}`,
        zhSummary: output.zhSummary || entry.postText,
        tags: output.tags,
      };

      try {
        const result = await writeStoryPair(entry, ai);
        created += 1;
        console.log(`[facebook] Created: ${result.enFile} + ${result.zhFile}`);
      } catch (error) {
        failed += 1;
        console.error(`[facebook] Failed on item write: ${entry.postId}`);
        console.error(error);
      }
    }
  }

  console.log(`[facebook] Done. New stories: ${created}, Failed: ${failed}`);
  if (failed > 0) {
    throw new Error(`Failed processing ${failed} facebook item(s). See logs above for details.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
