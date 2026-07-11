import fs from 'node:fs/promises';
import path from 'node:path';

const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-ultra:cloud';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
const BATCH_SIZE = 3;

function hasZhChars(s) { return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s); }

async function translateBatch(items) {
  const payload = items.map((item, i) => ({ id: i, enTitle: item.title, enSummary: item.summary || '' }));
  const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLLAMA_API_KEY}` },
    body: JSON.stringify({
      model: OLLAMA_MODEL, temperature: 0.2, max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a professional English-to-Traditional-Chinese translator. Output only valid JSON. All text values MUST be in Traditional Chinese (zh-TW), never in English.' },
        { role: 'user', content: [
          'Translate the following English titles and summaries to Traditional Chinese (zh-TW).',
          'Return a strict JSON array with keys: itemId, zhTitle, zhSummary.',
          'IMPORTANT: zhTitle and zhSummary MUST be written in Traditional Chinese characters. Do NOT return English text.',
          '',
          JSON.stringify(payload),
        ].join('\n') },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama API failed: ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty content');
  const cleaned = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function main() {
  const files = (await fs.readdir(NEWS_DATA_DIR)).filter(f => f.endsWith('.zh-TW.json'));
  let totalFixed = 0;

  for (const file of files) {
    const filePath = path.join(NEWS_DATA_DIR, file);
    const items = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const needTranslation = items.filter(i => i.title.startsWith('無障礙社群訊號'));

    if (needTranslation.length === 0) continue;
    console.log(`${file}: ${needTranslation.length} entries need retranslation`);

    for (let i = 0; i < needTranslation.length; i += BATCH_SIZE) {
      const batch = needTranslation.slice(i, i + BATCH_SIZE);
      try {
        const results = await translateBatch(batch);
        for (const result of results) {
          const entry = batch[result.id];
          if (!entry) continue;
          if (result.zhTitle && hasZhChars(result.zhTitle) && !result.zhTitle.startsWith('無障礙社群訊號')) {
            entry.title = result.zhTitle;
            totalFixed++;
          }
          if (result.zhSummary && hasZhChars(result.zhSummary)) entry.summary = result.zhSummary;
        }
        console.log(`  Batch ${Math.floor(i/BATCH_SIZE)+1}: processed ${batch.length}`);
      } catch (error) {
        console.error(`  Batch ${Math.floor(i/BATCH_SIZE)+1} failed: ${error.message}`);
      }
      if (i + BATCH_SIZE < needTranslation.length) await new Promise(r => setTimeout(r, 1000));
    }
    await fs.writeFile(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
  }
  console.log(`\nDone. Fixed: ${totalFixed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
