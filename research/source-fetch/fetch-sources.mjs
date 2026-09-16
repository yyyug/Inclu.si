#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'output');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const RSS_MAX = Number(process.env.FETCH_MAX_RSS || 50);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT || 15000);
const CONC = Number(process.env.FETCH_CONC || 8);
const ITEMS_MAX = Number(process.env.FETCH_ITEMS_MAX || 50);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function readTsv(filename) {
  const txt = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  const lines = txt.trim().split(/\r?\n/);
  const keys = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const vals = l.split('\t');
    return Object.fromEntries(keys.map((k, i) => [k, (vals[i] || '').trim()]));
  });
}

function parseItems(raw, kind) {
  const isRss = /<rss[\s>]/i.test(raw);
  const isAtom = !isRss && /<feed[\s>]/i.test(raw);
  const items = [];
  const re = isAtom ? /<entry>([\s\S]*?)<\/entry>/gi : /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(raw)) !== null && items.length < ITEMS_MAX) {
    const block = m[1];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const link = (block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const pubDate = (block.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || '';
    const desc = (block.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2] || '';
    items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), link: link.trim(), pubDate: pubDate.trim(), description: desc.replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 1000) });
  }
  return { count: items.length, items };
}

async function fetchOne(source, idx, total) {
  const kind = source.kind || 'rss';
  const dir = path.join(ROOT, kind);
  const slug = (source.name || source.domain || url).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  const fileBase = path.join(dir, slug);
  const url = source.url;
  if (!url || /UNRESOLVED|TODO|SKIP/i.test(url)) return { ok: false, reason: 'skipped' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    const raw = Buffer.from(buf).toString('utf8');
    fs.writeFileSync(fileBase + '.xml', raw);
    const parsed = parseItems(raw, kind);
    fs.writeFileSync(fileBase + '.items.json', JSON.stringify({ kind, name: source.name, domain: source.domain || '', url, count: parsed.count, items: parsed.items }, null, 2));
    process.stderr.write(`\r[${idx + 1}/${total}] ${kind}/${slug}.xml (${parsed.count} items)`);
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
  await delay(150);
  return { ok: true };
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'rss'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'podcast'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'youtube'), { recursive: true });
  const rssAll = readTsv('sources-rss.tsv');
  const rss = rssAll.slice(0, RSS_MAX);
  console.error(`RSS sources: ${rss.length} / ${rssAll.length}`);
  const podcast = readTsv('sources-podcast.tsv');
  const youtube = readTsv('sources-youtube.tsv').filter((s) => s.feed && !/UNRESOLVED/i.test(s.feed)).map((s) => ({ kind: 'youtube', name: s.handle, url: s.feed }));
  console.error(`podcast: ${podcast.length} | youtube: ${youtube.length}`);
  const all = [...rss, ...podcast, ...youtube];
  let ok = 0, fail = 0;
  let idx = 0;
  async function worker() {
    while (idx < all.length) {
      const i = idx++;
      const r = await fetchOne(all[i], i, all.length);
      if (r.ok) ok += 1; else fail += 1;
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.error(`\n\nDONE: ok=${ok} fail=${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });