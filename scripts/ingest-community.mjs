import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';
import {
  normalizeUrl,
  BATCH_SIZE,
  askOllamaForBatch,
  askGroqForBatch,
  retryOllama,
  writeStoryPair,
  readExistingKeys,
  hasZhChars,
  sourceHostname,
} from './news-common.mjs';

const SOURCES_DIR = path.resolve(process.env.SOURCES_DIR ?? 'research/source-fetch');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DRY_RUN = String(process.env.COMMUNITY_DRY_RUN ?? '') === '1';
const BACKFILL = String(process.env.COMMUNITY_BACKFILL ?? '') === '1';
const MIN_RSS_COUNT = Math.max(0, Number(process.env.COMMUNITY_MIN_RSS_COUNT ?? 130));
const MAX_ITEMS_PER_FEED = BACKFILL
  ? Number(process.env.COMMUNITY_ITEMS ?? 50)
  : Math.max(1, Number(process.env.COMMUNITY_ITEMS ?? process.env.MAX_ITEMS_PER_FEED ?? 15));
const MAX_TOTAL = BACKFILL
  ? Number(process.env.COMMUNITY_MAX_TOTAL ?? 200)
  : Math.max(1, Number(process.env.COMMUNITY_MAX_TOTAL ?? 60));

function readLine(data) {
  return String(data ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function parseTsv(data) {
  const lines = readLine(data);
  if (lines.length === 0) {
    return [];
  }

  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = String(cells[index] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
}

async function readTsv(fileName) {
  const filePath = path.join(SOURCES_DIR, fileName);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return parseTsv(data);
  } catch (error) {
    console.error(`[community] Failed to read ${fileName}: ${error.message}`);
    return [];
  }
}

function isAudioUrl(rawUrl) {
  return /\.(mp3|m4a|mp4|wav|ogg|aac|opus)(\?.*)?$/i.test(rawUrl);
}

function podcastCanonicalUrl(item) {
  const link = String(item?.link ?? '').trim();
  const guid = String(item?.guid ?? '').trim();

  if (guid && !isAudioUrl(guid)) {
    return guid;
  }
  if (link) {
    return link;
  }

  return guid || link;
}

function episodeTitleKey(title) {
  let value = String(title ?? '').trim().toLowerCase();
  value = value.replace(/^[\d\s]+/, '');
  value = value.replace(/\(([\w\u4e00-\u9fff.,\s]+)?\d{4}\)\s*$/, '').trim();
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

function isShortVideo(title, link) {
  const titleKey = String(title ?? '').toLowerCase();
  if (titleKey.startsWith('#shorts')) {
    return true;
  }
  return String(link ?? '').includes('/shorts/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parsePodcastFeed(feedUrl, maxItems) {
  const parser = new Parser({ headers: { 'User-Agent': USER_AGENT } });
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? []).slice(0, maxItems);
}

async function parseYoutubeFeed(feedUrl, maxItems) {
  const response = await fetch(feedUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Unable to fetch YouTube feed (${response.status}): ${text.slice(0, 120)}`);
  }

  const xml = await response.text();
  const channelTitle = String((xml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, maxItems);
  const items = [];

  for (const match of entries) {
    const block = match[1];

    const decode = (value) => String(value)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    const title = decode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '');
    const linkMatch = block.match(/<link\s+rel="alternate"[^>]*href="([^"]+)"/) || [];
    const videoLink = linkMatch[1] ?? '';
    const publishedRaw = (block.match(/<published>([^<]+)<\/published>/) || [])[1] ?? '';

    if (!title || !videoLink) {
      continue;
    }

    const published = new Date(publishedRaw);
    items.push({
      title,
      link: videoLink,
      isoDate: Number.isNaN(published.getTime()) ? '' : published.toISOString(),
      contentSnippet: title,
      content: '',
    });
  }

  return { channelTitle, items };
}

async function parseYoutubeFeedWithRetry(feedUrl, maxItems, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await parseYoutubeFeed(feedUrl, maxItems);
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        console.warn(`[community] YouTube retry ${i}/${attempts - 1} for ${feedUrl}: ${error.message}`);
        await sleep(1500 * i);
      }
    }
  }
  throw lastError;
}

async function collectCandidates() {
  const candidates = [];
  const seen = new Set();
  let skipped = 0;
  let failed = 0;

  const rssRows = await readTsv('sources-rss.tsv');
  const podcastRows = await readTsv('sources-podcast.tsv');
  const youtubeRows = await readTsv('sources-youtube.tsv');

  const rssFeeds = rssRows.filter((row) => {
    if (!row.url) return false;
    if (row.status === 'drop') return false;
    if (String(row.count ?? '').trim() === '') return true;
    return Number(row.count) >= MIN_RSS_COUNT;
  });

  console.log(`[community] rss_sources=${rssFeeds.length}/${rssRows.length} (min_count=${MIN_RSS_COUNT})`);
  console.log(`[community] podcast_sources=${podcastRows.filter((r) => r.url).length}`);
  console.log(`[community] youtube_sources=${youtubeRows.filter((r) => r.feed).length}`);

  for (const row of rssFeeds) {
    const feedUrl = row.url;
    try {
      const parser = new Parser({ headers: { 'User-Agent': USER_AGENT } });
      const feed = await parser.parseURL(feedUrl);
      const items = (feed.items ?? []).slice(0, MAX_ITEMS_PER_FEED);

      for (const item of items) {
        const title = String(item.title ?? '').trim();
        const sourceUrl = normalizeUrl(String(item.link ?? '').trim());
        const titleKey = `title:${title.toLowerCase()}`;

        if (!sourceUrl || !title || seen.has(`url:${sourceUrl}`) || seen.has(titleKey)) {
          skipped += 1;
          continue;
        }

        seen.add(`url:${sourceUrl}`);
        seen.add(titleKey);

        candidates.push({
          item: {
            title,
            contentSnippet: String(item.contentSnippet ?? item.content ?? ''),
            content: String(item.content ?? ''),
            isoDate: String(item.isoDate ?? item.pubDate ?? ''),
            pubDate: String(item.pubDate ?? item.isoDate ?? ''),
          },
          sourceName: row.domain || sourceHostname(feedUrl),
          sourceUrl,
          title: title.toLowerCase(),
          sourceCountry: null,
          queryRegion: null,
          ingestType: 'rss',
          ingestSource: normalizeUrl(feedUrl),
          ingestProvider: sourceHostname(feedUrl),
          forceRelevant: true,
        });
      }
    } catch (error) {
      failed += 1;
      console.error(`[community] Failed to fetch RSS source ${row.domain}: ${feedUrl}`);
      console.error(error);
    }
  }

  for (const row of podcastRows) {
    const feedUrl = row.url;
    if (!feedUrl) continue;
    const sourceName = row.name || sourceHostname(feedUrl);
    try {
      const items = await parsePodcastFeed(feedUrl, MAX_ITEMS_PER_FEED);
      for (const item of items) {
        const title = String(item.title ?? '').trim();
        const sourceUrl = normalizeUrl(podcastCanonicalUrl(item));
        const titleKey = `title:${title.toLowerCase()}`;
        const episodeKey = `title:${episodeTitleKey(title)}`;

        if (!sourceUrl || !title || seen.has(`url:${sourceUrl}`) || seen.has(titleKey) || seen.has(episodeKey)) {
          skipped += 1;
          continue;
        }

        seen.add(`url:${sourceUrl}`);
        seen.add(titleKey);
        seen.add(episodeKey);

        candidates.push({
          item: {
            title,
            contentSnippet: String(item.contentSnippet ?? item.content ?? ''),
            content: String(item.content ?? ''),
            isoDate: String(item.isoDate ?? item.pubDate ?? ''),
            pubDate: String(item.pubDate ?? item.isoDate ?? ''),
          },
          sourceName,
          sourceUrl,
          title: title.toLowerCase(),
          sourceCountry: null,
          queryRegion: null,
          ingestType: 'podcast',
          ingestSource: normalizeUrl(feedUrl),
          ingestProvider: sourceHostname(feedUrl),
          forceRelevant: true,
        });
      }
    } catch (error) {
      failed += 1;
      console.error(`[community] Failed to fetch podcast source ${sourceName}: ${feedUrl}`);
      console.error(error);
    }
  }

  const ytFile = process.env.COMMUNITY_YT_FILE ? path.resolve(process.env.COMMUNITY_YT_FILE) : '';
  let fileYtEntries = null;
  if (ytFile) {
    try {
      const raw = await fs.readFile(ytFile, 'utf8');
      fileYtEntries = JSON.parse(raw);
      if (!Array.isArray(fileYtEntries)) {
        fileYtEntries = [];
      }
    } catch {
      fileYtEntries = [];
    }
  }

  if (fileYtEntries !== null) {
    if (fileYtEntries.length === 0) {
      console.log('[community] youtube_local=none (file missing or empty); skipping YouTube');
    } else {
      console.log(`[community] youtube_local=${fileYtEntries.length} (${ytFile})`);
    }

    for (const v of fileYtEntries) {
      const title = String(v?.title ?? '').trim();
      const sourceUrl = normalizeUrl(String(v?.link ?? '').trim());
      if (!sourceUrl || !title) {
        skipped += 1;
        continue;
      }
      const titleKey = `title:${title.toLowerCase()}`;
      if (seen.has(`url:${sourceUrl}`) || seen.has(titleKey)) {
        skipped += 1;
        continue;
      }

      seen.add(`url:${sourceUrl}`);
      seen.add(titleKey);

      candidates.push({
        item: {
          title,
          contentSnippet: title,
          content: '',
          isoDate: String(v?.publishedAt ?? ''),
          pubDate: String(v?.publishedAt ?? ''),
        },
        sourceName: String(v?.channel ?? 'YouTube'),
        sourceUrl,
        title: title.toLowerCase(),
        sourceCountry: null,
        queryRegion: null,
        ingestType: 'youtube',
        ingestSource: `youtube-local:${String(v?.channel ?? 'yt')}`,
        ingestProvider: 'youtube.com',
        forceRelevant: true,
      });
    }
  } else {
    for (const row of youtubeRows) {
      const feedUrl = row.feed;
      if (!feedUrl) continue;
      const sourceName = row.name || row.handle || '';
      try {
        await sleep(700);
        const { channelTitle, items } = await parseYoutubeFeedWithRetry(feedUrl, MAX_ITEMS_PER_FEED);
        const displayName = sourceName || channelTitle || 'YouTube';

        for (const item of items) {
          const title = String(item.title ?? '').trim();
          const sourceUrl = normalizeUrl(item.link);
          const titleKey = `title:${title.toLowerCase()}`;

          if (isShortVideo(title, item.link)) {
            skipped += 1;
            continue;
          }
          if (!sourceUrl || !title || seen.has(`url:${sourceUrl}`) || seen.has(titleKey)) {
            skipped += 1;
            continue;
          }

          seen.add(`url:${sourceUrl}`);
          seen.add(titleKey);

          candidates.push({
            item,
            sourceName: displayName,
            sourceUrl,
            title: title.toLowerCase(),
            sourceCountry: null,
            queryRegion: null,
            ingestType: 'youtube',
            ingestSource: normalizeUrl(feedUrl),
            ingestProvider: 'youtube.com',
            forceRelevant: true,
          });
        }
      } catch (error) {
        failed += 1;
        console.error(`[community] Failed to fetch YouTube source ${row.handle}: ${feedUrl}`);
        console.error(error);
      }
    }
  }

  return { candidates, skipped, failed };
}

function interleaveBySource(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.ingestSource || entry.ingestProvider || entry.sourceName;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }

  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const group of groups.values()) {
      if (group.length > 0) {
        out.push(group.shift());
        added = true;
      }
    }
  }

  return out;
}

async function main() {
  const existing = await readExistingKeys();

  const { candidates: rawCandidates, skipped: fetchSkipped, failed: fetchFailed } = await collectCandidates();

  let candidates = rawCandidates;
  let skipped = fetchSkipped;
  let failed = fetchFailed;

  const seen = new Set();
  candidates = interleaveBySource(
    rawCandidates.filter((entry) => {
      const key = `url:${normalizeUrl(entry.sourceUrl)}`;
      if (key === 'url:' || seen.has(key) || existing.has(key)) {
        skipped += 1;
        return false;
      }
      seen.add(key);
      return true;
    }),
  ).slice(0, MAX_TOTAL);

  console.log(`[community] candidates_queued=${candidates.length} (cap=${MAX_TOTAL})`);
  console.log(`[community] by_type=${JSON.stringify(candidates.reduce((acc, c) => {
    acc[c.ingestType] = (acc[c.ingestType] ?? 0) + 1;
    return acc;
  }, {}))}`);

  if (candidates.length === 0) {
    console.log(`Done. New stories: 0, Skipped: ${skipped}, Failed: ${failed}`);
    return;
  }

  if (DRY_RUN) {
    console.log('[community] DRY_RUN preview (would-be candidates):');
    for (const entry of candidates) {
      console.log(`  - [${entry.ingestType}/${entry.ingestProvider}] ${entry.item.title} | ${entry.sourceUrl}`);
    }
    console.log(`[community] Dry run complete. ${candidates.length} candidates would be processed.`);
    return;
  }

  let created = 0;

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

      if (!output) {
        failed += 1;
        console.error(`Missing LLM output item for batch index ${j} (global ${i + j})`);
        continue;
      }

      if (!output.isRelevant && !entry.forceRelevant) {
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

function finish(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}

main()
  .then(() => finish(0))
  .catch((error) => {
    console.error(error);
    finish(1);
  });