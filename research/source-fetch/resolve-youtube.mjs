import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveHandle(handle) {
  const urls = [`https://www.youtube.com/@${handle}`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, redirect: 'follow' });
      if (!res.ok) continue;
      const t = await res.text();
      let m = t.match(/"channelId":"(UC[\w-]{10,})"/);
      if (!m) m = t.match(/"externalId":"(UC[\w-]{10,})"/);
      if (!m) m = t.match(/<link itemprop="identifier"[^>]*content="(UC[\w-]{10,})"/);
      const verified = t.includes('"isVerified":true');
      if (m) return { id: m[1] };
    } catch { /* retry */ }
    await delay(350);
  }
  return null;
}

const candidates = ['theaccessibilityguy','theblindlife','thedoubletap','doubletap','humanware','aira','airaio','hadleyhelps','freedomscientific','selvasblv','visiontechacademy','carrollcenter','bemyeyes','ampere','visionaustralia'];
const rows = [];
let ok = 0;
for (const h of candidates) {
  const r = await resolveHandle(h);
  if (r) ok += 1;
  rows.push({ handle: h, id: r?.id || null });
  console.error(`${h} -> ${r?.id || 'FAIL'}`);
  await delay(300);
}
const body = rows.filter((r) => r.id).map((r) => ['youtube', r.handle, `https://www.youtube.com/feeds/videos.xml?channel_id=${r.id}`, r.id].join('\t')).join('\n');
fs.writeFileSync(path.join(__dirname, 'sources-youtube.tsv'), 'kind\thandle\tfeed\tchannel_id\n' + body + '\n');
console.error(`resolved ${ok}/${candidates.length}`);