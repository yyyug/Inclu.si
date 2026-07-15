import fs from 'node:fs/promises';
import path from 'node:path';

const NEWS_DATA_DIR = path.resolve('src/data/news');
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nemotron-3-ultra:cloud';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);

function hasZhChars(s) { return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s); }

async function translateOne(enTitle) {
  const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLLAMA_API_KEY}` },
    body: JSON.stringify({
      model: OLLAMA_MODEL, temperature: 0.2, max_tokens: 512,
      messages: [
        { role: 'system', content: '你是專業翻譯。將英文翻譯成繁體中文。只輸出中文翻譯，不要英文。' },
        { role: 'user', content: `翻譯成繁體中文（只輸出中文翻譯，不要其他文字）：\n${enTitle}` },
      ],
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`API failed: ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty');
  return content;
}

async function main() {
  const files = (await fs.readdir(NEWS_DATA_DIR)).filter(f => f.endsWith('.zh-TW.json'));
  let totalFixed = 0;

  for (const file of files) {
    const filePath = path.join(NEWS_DATA_DIR, file);
    const items = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const enFile = path.join(NEWS_DATA_DIR, file.replace('.zh-TW.json', '.en.json'));
    const enItems = JSON.parse(await fs.readFile(enFile, 'utf8'));
    const enBySlug = new Map(enItems.map(e => [e.slug, e]));

    const needTranslation = items.filter(i => i.title.startsWith('無障礙社群訊號'));
    if (needTranslation.length === 0) continue;
    console.log(`${file}: ${needTranslation.length} entries to retranslate`);

    for (let i = 0; i < needTranslation.length; i++) {
      const entry = needTranslation[i];
      const enEntry = enBySlug.get(entry.translationOf);
      if (!enEntry) continue;

      try {
        const zhTitle = await translateOne(enEntry.title);
        if (hasZhChars(zhTitle) && !zhTitle.startsWith('無障礙社群訊號')) {
          entry.title = zhTitle;
          totalFixed++;
          console.log(`  [${i+1}/${needTranslation.length}] Fixed: ${zhTitle.slice(0,40)}`);
        }
      } catch (error) {
        console.error(`  [${i+1}] Failed: ${error.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    await fs.writeFile(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
  }
  console.log(`\nDone. Fixed: ${totalFixed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
