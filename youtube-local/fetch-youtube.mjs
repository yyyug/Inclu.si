import fs from 'node:fs/promises';
import path from 'node:path';

const TSV = path.resolve(process.env.SOURCES_TSV ?? 'research/source-fetch/sources-youtube.tsv');
const OUT = path.resolve(process.env.YT_OUT ?? 'youtube-local/youtube-candidates.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const ITEMS_PER_CHANNEL = Math.max(1, Number(process.env.YT_ITEMS_PER_CHANNEL ?? 15));
const MAX_ENTRIES = Math.max(10, Number(process.env.YT_MAX_ENTRIES ?? 5000));
const DELAY_MS = Math.max(0, Number(process.env.YT_DELAY_MS ?? 800));
const RETRIES = Math.max(1, Number(process.env.YT_RETRIES ?? 3));
const MAX_AGE_DAYS = Math.max(30, Number(process.env.YT_MAX_AGE_DAYS ?? 200));
const CUTOFF_MS = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

function isRecent(publishedAt) {
  if (!publishedAt) {
    return true;
  }
  const time = new Date(publishedAt).getTime();
  if (Number.isNaN(time)) {
    return true;
  }
  return time >= CUTOFF_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseTsv(data) {
  const lines = String(data ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

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

function extractVideoId(block, link) {
  const direct = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
  if (direct) {
    return direct;
  }
  const tag = (block.match(/<id>tag:youtube\.com,\d+:video:([^<]+)<\/id>/) || [])[1];
  if (tag) {
    return tag;
  }
  try {
    return new URL(link).searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

async function fetchChannelFeed(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }

  const xml = await response.text();
  const channelTitle = decodeXml((xml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '');
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, ITEMS_PER_CHANNEL);
  const items = [];

  for (const match of entries) {
    const block = match[1];
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '');
    const linkMatch = block.match(/<link\s+rel="alternate"[^>]*href="([^"]+)"/) || [];
    const link = linkMatch[1] ?? '';
    const videoId = extractVideoId(block, link);
    const publishedRaw = (block.match(/<published>([^<]+)<\/published>/) || [])[1] ?? '';

    if (!title || !videoId || !link) {
      continue;
    }

    const published = new Date(publishedRaw);
    items.push({
      videoId,
      title,
      link,
      publishedAt: Number.isNaN(published.getTime()) ? '' : published.toISOString(),
    });
  }

  return { channelTitle, items };
}

async function fetchChannelFeedWithRetry(feedUrl) {
  let lastError;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      return await fetchChannelFeed(feedUrl);
    } catch (error) {
      lastError = error;
      if (i < RETRIES) {
        await sleep(DELAY_MS * (i + 1));
      }
    }
  }
  throw lastError;
}

async function main() {
  const tsv = parseTsv(await fs.readFile(TSV, 'utf8'));
  const rows = tsv.filter((row) => row.feed && !/unresolved/i.test(row.feed));

  let existing = [];
  try {
    const raw = await fs.readFile(OUT, 'utf8');
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) {
      existing = [];
    }
  } catch {
    existing = [];
  }

  const byId = new Map(
    existing.filter((entry) => isRecent(entry?.publishedAt)).map((entry) => [entry.videoId, entry]),
  );
  let newCount = 0;
  const failedChannels = [];

  for (const row of rows) {
    const feedUrl = row.feed;
    try {
      await sleep(DELAY_MS);
      const { channelTitle, items } = await fetchChannelFeedWithRetry(feedUrl);
      const entryChannel = row.name || row.handle || channelTitle || row.handle;

      for (const item of items) {
        if (item.title.toLowerCase().startsWith('#shorts') || item.link.includes('/shorts/')) {
          continue;
        }
        if (!isRecent(item.publishedAt)) {
          continue;
        }
        if (byId.has(item.videoId)) {
          continue;
        }
        byId.set(item.videoId, {
          channel: entryChannel,
          videoId: item.videoId,
          title: item.title,
          link: item.link,
          publishedAt: item.publishedAt,
          fetchedAt: new Date().toISOString(),
        });
        newCount += 1;
      }
    } catch (error) {
      failedChannels.push(`${row.handle}: ${error.message}`);
    }
  }

  const all = [...byId.values()]
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, MAX_ENTRIES);

  await fs.writeFile(OUT, `${JSON.stringify(all, null, 2)}\n`, 'utf8');

  console.log(`[youtube-local] channels=${rows.length} new=${newCount} total=${all.length}`);
  if (failedChannels.length > 0) {
    console.log(`[youtube-local] failed_channels=${failedChannels.length}`);
    for (const line of failedChannels) {
      console.log(`  - ${line}`);
    }
  }

  if (newCount === 0 && failedChannels.length === rows.length) {
    throw new Error('All YouTube channels failed to fetch; nothing new captured.');
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});