import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';
import { GoogleDecoder } from 'google-news-url-decoder';
import {
  normalizeUrl,
  BATCH_SIZE,
  buildBatchPrompt,
  parseBatchResponse,
  askOllamaForBatch,
  askGroqForBatch,
  writeStoryPair,
  readExistingKeys,
  hasZhChars,
  sourceHostname,
} from './news-common.mjs';
import { extractQueryRegionFromFeedUrl, pickSourceCountry } from './news-ingest/geo.mjs';

const SOURCES_DIR = path.resolve(process.env.SOURCES_DIR ?? 'research/source-fetch');
const SOURCES_TSV = String(process.env.SOURCES_TSV ?? 'sources-fr-sp-ar.tsv');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DRY_RUN = String(process.env.FR_SP_AR_DRY_RUN ?? '') === '1';
const MAX_ITEMS_PER_FEED = Math.max(1, Number(process.env.FR_SP_AR_ITEMS ?? process.env.MAX_ITEMS_PER_FEED ?? 8));
const GOOGLE_ITEMS = Math.max(1, Number(process.env.FR_SP_AR_GOOGLE_ITEMS ?? 25));
const MAX_TOTAL = Math.max(1, Number(process.env.FR_SP_AR_MAX_TOTAL ?? 80));
const AGNES_MAX_RETRIES = Math.max(1, Number(process.env.AGNES_MAX_RETRIES ?? 3));

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
    console.error(`[fr-sp-ar] Failed to read ${fileName}: ${error.message}`);
    return [];
  }
}

function sourceNameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return 'Unknown source';
  }
}

function isGoogleNewsUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname === 'news.google.com';
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

function getAgnesConfig() {
  return {
    baseUrl: String(process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, ''),
    apiKey: String(process.env.AGNES_API_KEY ?? '').trim(),
    model: String(process.env.AGNES_MODEL || 'agnes-3.0-flash'),
    timeoutMs: Number(process.env.AGNES_TIMEOUT_MS ?? 600000),
    maxTokens: Math.max(1, Math.min(65536, Number(process.env.AGNES_MAX_TOKENS ?? 32768))),
  };
}

async function askAgnesForBatch(batchItems) {
  const config = getAgnesConfig();
  if (!config.apiKey) {
    throw new Error('Missing AGNES_API_KEY.');
  }

  const userPrompt = buildBatchPrompt(batchItems);

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';
    throw new Error(`Agnes request failed (${code}). ${error?.message ?? ''}`.trim());
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agnes API failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Agnes returned empty content.');
  }

  return parseBatchResponse(content);
}

async function runBatchWithLLM(batchItems, label) {
  let lastError;

  for (let attempt = 1; attempt <= AGNES_MAX_RETRIES; attempt += 1) {
    try {
      return await askAgnesForBatch(batchItems);
    } catch (error) {
      lastError = error;
      if (attempt < AGNES_MAX_RETRIES) {
        const delay = attempt * 2000;
        console.warn(`[agnes] Batch ${label} attempt ${attempt} failed (${error.message}). Retrying in ${delay}ms…`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.warn(`[agnes] Batch ${label} exhausted retries=${AGNES_MAX_RETRIES}. Trying fallbacks…`);
  try {
    return await askGroqForBatch(batchItems);
  } catch (groqError) {
    console.error(`[groq] Batch ${label} fallback failed: ${groqError.message}`);
  }
  try {
    return await askOllamaForBatch(batchItems);
  } catch (ollamaError) {
    console.error(`[ollama] Batch ${label} fallback failed: ${ollamaError.message}`);
  }

  throw lastError;
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

async function collectCandidates({ parser, decoder }) {
  const candidates = [];
  let skipped = 0;
  let failed = 0;

  const rows = await readTsv(SOURCES_TSV);

  for (const row of rows) {
    const lang = String(row.lang ?? '').trim();
    const kind = String(row.kind ?? 'rss').trim();
    const feedUrl = String(row.url ?? '').trim();
    const sourceName = String(row.domain ?? '').trim() || sourceHostname(feedUrl);

    if (!feedUrl || row.status === 'drop') {
      continue;
    }

    const rowCount = Number(String(row.count ?? '').trim());
    const limit = Math.max(1, Number.isFinite(rowCount) && rowCount > 0 ? rowCount : kind === 'googlenews' ? GOOGLE_ITEMS : MAX_ITEMS_PER_FEED);

    let feed;
    try {
      console.log(`[fr-sp-ar] Fetching ${lang}/${kind}: ${feedUrl}`);
      feed = await parser.parseURL(feedUrl);
    } catch (error) {
      failed += 1;
      console.error(`Failed to fetch feed: ${feedUrl}`);
      console.error(error);
      continue;
    }

    const items = (feed.items ?? []).slice(0, limit);
    const queryRegion = extractQueryRegionFromFeedUrl(feedUrl);

    for (const item of items) {
      const title = String(item.title ?? '').trim();
      if (!title) {
        skipped += 1;
        continue;
      }

      try {
        const sourceUrl = await resolveArticleUrl(item, decoder);
        candidates.push({
          item: {
            title,
            contentSnippet: String(item.contentSnippet ?? item.content ?? ''),
            content: String(item.content ?? ''),
            isoDate: String(item.isoDate ?? item.pubDate ?? ''),
            pubDate: String(item.pubDate ?? item.isoDate ?? ''),
          },
          sourceName: sourceName || sourceNameFromUrl(sourceUrl),
          sourceUrl,
          titleKey: `title:${title.toLowerCase()}`,
          queryRegion,
          sourceCountry: pickSourceCountry({ sourceUrl, queryRegion }),
          originalLang: lang,
          forceRelevant: kind !== 'googlenews',
          ingestType: 'rss',
          ingestSource: normalizeUrl(feedUrl),
          ingestProvider: sourceHostname(feedUrl) || sourceNameFromUrl(feedUrl),
        });
      } catch (error) {
        failed += 1;
        console.error(`Failed on feed item: ${title}`);
        console.error(error);
      }
    }
  }

  return { candidates, skipped, failed };
}

async function main() {
  const existing = await readExistingKeys();
  const parser = new Parser({ headers: { 'User-Agent': USER_AGENT } });
  const decoder = new GoogleDecoder();

  const { candidates: rawCandidates, skipped: fetchSkipped, failed: fetchFailed } = await collectCandidates({ parser, decoder });

  let skipped = fetchSkipped;
  let failed = fetchFailed;

  const seen = new Set();
  const candidates = interleaveBySource(
    rawCandidates.filter((entry) => {
      const key = `url:${normalizeUrl(entry.sourceUrl)}`;
      if (key === 'url:' || seen.has(key) || existing.has(key) || seen.has(entry.titleKey) || existing.has(entry.titleKey)) {
        skipped += 1;
        return false;
      }
      seen.add(key);
      return true;
    }),
  ).slice(0, MAX_TOTAL);

  const byLang = candidates.reduce((acc, entry) => {
    acc[entry.originalLang] = (acc[entry.originalLang] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`[fr-sp-ar] candidates_queued=${candidates.length} (cap=${MAX_TOTAL})`);
  console.log(`[fr-sp-ar] by_lang=${JSON.stringify(byLang)}`);

  if (candidates.length === 0) {
    console.log(`Done. New stories: 0, Skipped: ${skipped}, Failed: ${failed}`);
    return;
  }

  if (DRY_RUN) {
    console.log('[fr-sp-ar] DRY_RUN preview (would-be candidates):');
    for (const entry of candidates) {
      console.log(`  - [${entry.originalLang}] ${entry.item.title} | ${entry.sourceUrl}`);
    }
    console.log(`[fr-sp-ar] Dry run complete. ${candidates.length} candidates would be processed.`);
    return;
  }

  let created = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const outputMap = new Map();

    try {
      const outputs = await runBatchWithLLM(batch, i);
      for (const item of outputs) {
        outputMap.set(item.itemId, item);
      }
    } catch (error) {
      console.error(`[fr-sp-ar] Failed on batch starting index ${i}; attempting per-item fallback`);
      console.error(error);
    }

    for (let j = 0; j < batch.length; j += 1) {
      const entry = batch[j];
      if (existing.has(entry.titleKey)) {
        skipped += 1;
        continue;
      }

      let output = outputMap.get(j);
      if (!output) {
        try {
          const single = await runBatchWithLLM([entry], `${i + j}/single`);
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
          { originalLang: entry.originalLang },
        );
        existing.add(`url:${result.canonicalUrl}`);
        existing.add(entry.titleKey);
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