import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import { GoogleDecoder } from 'google-news-url-decoder';

const FEED_URL = process.env.GOOGLE_NEWS_RSS_URL
  ?? 'https://news.google.com/rss/search?q=accessibility&hl=en-US&gl=US&ceid=US:en';
const CONTENT_DIR = path.resolve('src/content/news');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'https://ollama.cloud/v1').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b-instruct';
const MAX_ITEMS_PER_RUN = Number(process.env.MAX_ITEMS_PER_RUN ?? 10);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60000);
const BATCH_SIZE = Math.min(5, Math.max(3, Number(process.env.BATCH_SIZE ?? 3)));

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

async function readExistingKeys() {
  const keys = new Set();

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

async function askOllamaForBatch(batchItems) {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  const payload = batchItems.map((entry, index) => ({
    itemId: index,
    title: entry.item.title ?? '',
    snippet: entry.item.contentSnippet ?? entry.item.content ?? '',
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
  }));

  const userPrompt = [
    'You are an accessibility news editor.',
    'For each input item, first decide if it is accessibility-related.',
    'If related, classify and summarize in English and Traditional Chinese.',
    'Return a strict JSON array and nothing else.',
    'Allowed category values: digital-a11y, assistive-tech, laws-rights, physical-design, lifestyle-culture, case-studies, general.',
    'Each array item must include keys: itemId, isRelevant, englishTitle, englishSummary, zhTitle, zhSummary, category, tags.',
    'If not relevant, return: {"itemId": <id>, "isRelevant": false}',
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
    throw new Error(`Ollama request failed (${code}). ${error?.message ?? ''}`.trim());
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
    category: normalizeCategory(String(row?.category || 'general').trim()),
    tags: safeStringArray(row?.tags),
  }));
}

function buildFrontmatter({
  title,
  slug,
  lang,
  summary,
  category,
  tags,
  sourceName,
  sourceUrl,
  clusterId,
  translationOf,
  publishedAt,
  fetchedAt,
}) {
  const encodedTags = tags.map((tag) => `  - "${tag.replace(/"/g, '\\"')}"`).join('\n');

  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `slug: "${slug}"`,
    `lang: "${lang}"`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    `category: "${category}"`,
    'tags:',
    encodedTags || '  - "accessibility"',
    `sourceName: "${sourceName.replace(/"/g, '\\"')}"`,
    `sourceUrl: "${sourceUrl}"`,
    'relatedSources:',
    `  - name: "${sourceName.replace(/"/g, '\\"')}"`,
    `    url: "${sourceUrl}"`,
    `clusterId: "${clusterId}"`,
    'status: "published"',
    `translationOf: "${translationOf}"`,
    `publishedAt: "${publishedAt}"`,
    `fetchedAt: "${fetchedAt}"`,
    '---',
    '',
  ].join('\n');
}

async function writeStoryPair(item, ai, sourceName, sourceUrl) {
  const canonicalUrl = normalizeUrl(sourceUrl);
  const publishedAt = toIsoDate(item.isoDate ?? item.pubDate);
  const fetchedAt = new Date().toISOString();
  const hash = crypto.createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 8);

  const baseSlug = slugify(ai.englishTitle) || `story-${hash}`;
  const enSlug = `${baseSlug}-${hash}`;
  const zhSlug = `${baseSlug}-zh-${hash}`;
  const clusterId = `cluster-${hash}`;

  const enBody = [
    buildFrontmatter({
      title: ai.englishTitle,
      slug: enSlug,
      lang: 'en',
      summary: ai.englishSummary,
      category: ai.category,
      tags: ai.tags,
      sourceName,
      sourceUrl: canonicalUrl,
      clusterId,
      translationOf: zhSlug,
      publishedAt,
      fetchedAt,
    }),
    ai.englishSummary,
    '',
    `Read more from the original source: [${sourceName}](${canonicalUrl})`,
    '',
  ].join('\n');

  const zhBody = [
    buildFrontmatter({
      title: ai.zhTitle,
      slug: zhSlug,
      lang: 'zh-TW',
      summary: ai.zhSummary,
      category: ai.category,
      tags: ai.tags,
      sourceName,
      sourceUrl: canonicalUrl,
      clusterId,
      translationOf: enSlug,
      publishedAt,
      fetchedAt,
    }),
    ai.zhSummary,
    '',
    `原文來源： [${sourceName}](${canonicalUrl})`,
    '',
  ].join('\n');

  const datePrefix = publishedAt.slice(0, 10);
  const enFilename = `${datePrefix}-${enSlug}.md`;
  const zhFilename = `${datePrefix}-${zhSlug}.md`;

  await fs.writeFile(path.join(CONTENT_DIR, enFilename), enBody, 'utf8');
  await fs.writeFile(path.join(CONTENT_DIR, zhFilename), zhBody, 'utf8');

  return { canonicalUrl, enFilename, zhFilename };
}

async function main() {
  const parser = new Parser();
  const decoder = new GoogleDecoder();

  const existing = await readExistingKeys();
  const sourceMap = await readSourceMapFromRssXml(FEED_URL);

  console.log(`Fetching: ${FEED_URL}`);
  const feed = await parser.parseURL(FEED_URL);
  const items = (feed.items ?? []).slice(0, MAX_ITEMS_PER_RUN);

  const candidates = [];
  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    const title = String(item.title ?? '').trim().toLowerCase();

    try {
      const keyByTitle = normalizeTitleKey(item.title);
      const mapped = sourceMap.get(keyByTitle);
      if (!mapped) {
        throw new Error('RSS item is missing <source url="..."> in raw XML mapping.');
      }

      const sourceUrl = await resolveArticleUrl(item, decoder);
      const sourceName = mapped.sourceName || extractSourceName(item);
      const key = `url:${normalizeUrl(sourceUrl)}`;

      if (!sourceUrl || existing.has(key) || existing.has(`title:${title}`)) {
        skipped += 1;
        continue;
      }

      if (!isAccessibilityRelated(item.title, item.contentSnippet ?? item.content ?? '')) {
        skipped += 1;
        continue;
      }

      candidates.push({ item, sourceName, sourceUrl, title });
    } catch (error) {
      failed += 1;
      console.error(`Failed on item: ${item.title ?? 'unknown'}`);
      console.error(error);
    }
  }

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    let outputs;

    try {
      outputs = await askOllamaForBatch(batch);
    } catch (error) {
      failed += batch.length;
      console.error(`Failed on batch starting index ${i}`);
      console.error(error);
      continue;
    }

    const outputMap = new Map(outputs.map((item) => [item.itemId, item]));

    for (let j = 0; j < batch.length; j += 1) {
      const entry = batch[j];
      const output = outputMap.get(j);

      if (!output || !output.isRelevant) {
        skipped += 1;
        continue;
      }

      const ai = {
        englishTitle: output.englishTitle || entry.item.title || 'Accessibility update',
        englishSummary: output.englishSummary || entry.item.contentSnippet || '',
        zhTitle: output.zhTitle || entry.item.title || '無障礙新聞',
        zhSummary: output.zhSummary || entry.item.contentSnippet || '',
        category: output.category,
        tags: output.tags,
      };

      try {
        const result = await writeStoryPair(entry.item, ai, entry.sourceName, entry.sourceUrl);
        existing.add(`url:${result.canonicalUrl}`);
        existing.add(`title:${entry.title}`);
        created += 1;
        console.log(`Created: ${result.enFilename} + ${result.zhFilename}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed on item write: ${entry.item.title ?? 'unknown'}`);
        console.error(error);
      }
    }
  }

  console.log(`Done. New stories: ${created}, Skipped: ${skipped}, Failed: ${failed}`);
  if (failed > 0) {
    throw new Error(`Failed processing ${failed} item(s). See logs above for details.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
