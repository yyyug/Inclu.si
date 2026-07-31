import fs from 'node:fs/promises';
import path from 'node:path';
import { hasZhChars, zhIsTranslated } from './news-ingest/zh-quality.mjs';

const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-super:cloud';
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || OLLAMA_MODEL;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 180000);
const OLLAMA_MAX_TOKENS = Number(process.env.OLLAMA_MAX_TOKENS ?? 8192);
const OLLAMA_MAX_RETRIES = Number(process.env.OLLAMA_MAX_RETRIES ?? 3);
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS ?? 300000);
const BATCH_SIZE = Math.min(10, Math.max(3, Number(process.env.BATCH_SIZE ?? 5)));
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? 24);

function stripCodeFenceJson(content) {
  let cleaned = String(content ?? '').trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned;
}

async function translateBatchOllama(items) {
  const userPrompt = [
    'Translate the following English titles and summaries to Traditional Chinese (zh-TW).',
    'Return a strict JSON array with keys: itemId, zhTitle, zhSummary.',
    'Keep translations concise and natural. No markdown, no extra text.',
    '',
    JSON.stringify(items),
  ].join('\n');

  const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL,
      temperature: 0.2,
      max_tokens: OLLAMA_MAX_TOKENS,
      messages: [
        { role: 'system', content: 'Always output valid minified JSON and nothing else.' },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama returned empty content.');
  }

  const parsed = JSON.parse(stripCodeFenceJson(content));
  if (!Array.isArray(parsed)) {
    throw new Error('Ollama response is not an array.');
  }

  return parsed.map((row) => ({
    itemId: Number(row?.itemId),
    zhTitle: String(row?.zhTitle || '').trim(),
    zhSummary: String(row?.zhSummary || '').trim(),
  }));
}

async function translateBatchGroq(items) {
  if (!GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY.');
  }

  console.log(`[groq] Falling back to Groq for translation model=${GROQ_MODEL}`);
  const userPrompt = [
    'Translate the following English titles and summaries to Traditional Chinese (zh-TW).',
    'Return a strict JSON array with keys: itemId, zhTitle, zhSummary.',
    'Keep translations concise and natural. No markdown, no extra text.',
    '',
    JSON.stringify(items),
  ].join('\n');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq fallback failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Groq returned empty content.');
  }

  const parsed = JSON.parse(stripCodeFenceJson(content));
  if (!Array.isArray(parsed)) {
    throw new Error('Groq response is not an array.');
  }

  return parsed.map((row) => ({
    itemId: Number(row?.itemId),
    zhTitle: String(row?.zhTitle || '').trim(),
    zhSummary: String(row?.zhSummary || '').trim(),
  }));
}

async function retryTranslate(items, batchIndex) {
  let lastError;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await translateBatchOllama(items);
    } catch (err) {
      lastError = err;
      if (attempt < OLLAMA_MAX_RETRIES) {
        const delay = attempt * 2000;
        console.warn(`[ollama] Batch ${batchIndex} attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.warn(`[ollama] Batch ${batchIndex} exhausted retries. Trying Groq fallback...`);
  try {
    return await translateBatchGroq(items);
  } catch (groqError) {
    console.error(`[groq] Batch ${batchIndex} fallback also failed: ${groqError.message}`);
    throw lastError;
  }
}

async function readMonthlyFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMonthlyFile(filePath, stories) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(stories, null, 2)}\n`, 'utf8');
}

function isWithinLookback(publishedAt) {
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return false;
  return (Date.now() - ts) < LOOKBACK_HOURS * 60 * 60 * 1000;
}

async function main() {
  if (!OLLAMA_API_KEY) {
    throw new Error('Missing OLLAMA_API_KEY.');
  }

  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  console.log(`[backfill-zh] Lookback: ${LOOKBACK_HOURS}h (since ${cutoff.toISOString()})`);

  const files = await fs.readdir(NEWS_DATA_DIR);
  const zhFiles = files.filter((f) => f.endsWith('.zh-TW.json')).sort();
  const enFiles = files.filter((f) => f.endsWith('.en.json')).sort();

  let fixedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const zhFile of zhFiles) {
    const enFile = zhFile.replace('.zh-TW.json', '.en.json');
    if (!enFiles.includes(enFile)) {
      console.log(`[backfill-zh] Skipping ${zhFile}: no matching ${enFile}`);
      continue;
    }

    const zhStories = await readMonthlyFile(path.join(NEWS_DATA_DIR, zhFile));
    if (zhStories.length === 0) {
      console.log(`[backfill-zh] ${zhFile}: empty, skipping`);
      continue;
    }

    const enStories = await readMonthlyFile(path.join(NEWS_DATA_DIR, enFile));
    const enBySlug = new Map(enStories.map((s) => [s.slug, s]));

    // Find zh-TW entries that need translation
    const toTranslate = [];

    for (let i = 0; i < zhStories.length; i++) {
      const zh = zhStories[i];
      if (!zh.translationOf) continue;

      const en = enBySlug.get(zh.translationOf);
      if (!en) continue;

      if (!isWithinLookback(zh.publishedAt)) continue;

      if (!zhIsTranslated(zh.title, zh.summary)) {
        toTranslate.push({
          itemId: i,
          englishTitle: en.title,
          englishSummary: en.summary,
        });
      }
    }

    if (toTranslate.length === 0) {
      console.log(`[backfill-zh] ${zhFile}: no untranslated entries found in lookback`);
      continue;
    }

    console.log(`[backfill-zh] ${zhFile}: ${toTranslate.length} entries need translation`);

    for (let b = 0; b < toTranslate.length; b += BATCH_SIZE) {
      const batch = toTranslate.slice(b, b + BATCH_SIZE);
      try {
        const translations = await retryTranslate(batch, `${zhFile}/${b}`);
        for (const t of translations) {
          const zhIdx = batch.find((item) => item.itemId === t.itemId)?.itemId;
          if (zhIdx === undefined) continue;
          const zh = zhStories[zhIdx];
          let changed = false;
          if (hasZhChars(t.zhTitle)) {
            zh.title = t.zhTitle;
            changed = true;
          }
          if (hasZhChars(t.zhSummary)) {
            zh.summary = t.zhSummary;
            zh.body = String(zh.body ?? '')
              .replace('此推文的中文摘要尚待翻譯。', zh.summary)
              .replace('此新聞的中文摘要尚待翻譯。', zh.summary);
            changed = true;
          }
          if (changed) {
            zh.status = zhIsTranslated(zh.title, zh.summary) ? 'published' : 'draft';
          }
          fixedCount += 1;
        }
      } catch (error) {
        console.error(`[backfill-zh] Batch ${b} completely failed: ${error.message}`);
        errorCount += batch.length;
      }
    }

    // Write updated file
    await writeMonthlyFile(path.join(NEWS_DATA_DIR, zhFile), zhStories);
    console.log(`[backfill-zh] ${zhFile}: saved ${zhStories.length} entries`);
  }

  console.log(`[backfill-zh] Done. Fixed: ${fixedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
