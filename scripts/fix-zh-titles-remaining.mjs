import fs from 'node:fs/promises';
import path from 'node:path';

const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-super:cloud';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
const BATCH_SIZE = 5;

function isPureEnglish(text) {
  return !/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(text);
}

async function translateBatch(items) {
  const payload = items.map((item, i) => ({
    id: i,
    enTitle: item.title,
    enSummary: item.summary || '',
  }));

  const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: 'You are a professional translator. Translate the given English news titles and summaries to Traditional Chinese (zh-TW). Return a JSON array. Each item must have: id, zhTitle, zhSummary. Output valid JSON only.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
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
  if (!content) throw new Error('Ollama returned empty content.');

  let parsed;
  try {
    const cleaned = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Invalid JSON from Ollama: ${content.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) throw new Error('Response is not an array.');
  return parsed;
}

async function main() {
  const files = (await fs.readdir(NEWS_DATA_DIR)).filter(f => f.endsWith('.zh-TW.json'));
  let totalFixed = 0;

  for (const file of files) {
    const filePath = path.join(NEWS_DATA_DIR, file);
    const items = JSON.parse(await fs.readFile(filePath, 'utf8'));
    // Only translate tweets (ingestType=x), skip package names
    const needTranslation = items.filter(i => isPureEnglish(i.title) && i.ingestType === 'x');

    if (needTranslation.length === 0) {
      console.log(`${file}: no untranslated tweet entries`);
      continue;
    }

    console.log(`${file}: ${needTranslation.length} tweet entries need translation`);

    for (let i = 0; i < needTranslation.length; i += BATCH_SIZE) {
      const batch = needTranslation.slice(i, i + BATCH_SIZE);
      try {
        const results = await translateBatch(batch);
        for (const result of results) {
          const entry = batch[result.id];
          if (!entry) continue;
          if (result.zhTitle) {
            entry.title = result.zhTitle;
            totalFixed++;
          }
          if (result.zhSummary) {
            entry.summary = result.zhSummary;
          }
        }
        console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: translated ${batch.length} entries`);
      } catch (error) {
        console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`);
      }

      if (i + BATCH_SIZE < needTranslation.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    await fs.writeFile(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
  }

  console.log(`\nDone. Total fixed: ${totalFixed}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
