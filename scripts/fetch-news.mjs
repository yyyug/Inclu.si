import Parser from 'rss-parser';
import { GoogleDecoder } from 'google-news-url-decoder';
import { extractQueryRegionFromFeedUrl, pickSourceCountry } from './news-ingest/geo.mjs';
import {
  requireEnv,
  parseCommaList,
  normalizeUrl,
  isAccessibilityRelated,
  decodeXmlEntities,
  sourceHostname,
  BATCH_SIZE,
  askOllamaForBatch,
  askGroqForBatch,
  retryOllama,
  writeStoryPair,
  readExistingKeys,
  hasZhChars,
} from './news-common.mjs';

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

const MAX_ITEMS_PER_RUN = Math.max(1, Number(process.env.MAX_ITEMS_PER_RUN ?? 10));

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

function normalizeTitleKey(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
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