#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'tidbits-domain-analysis.txt'), 'utf8');
const rows = [];
for (const l of src.split(/\r?\n/)) {
  if (!/^\s+\d+\./.test(l)) continue;
  const parts = l.split('|').map((s) => s.trim());
  const head = parts[0].match(/(\d+)\.?\s+(\d+) articles/);
  if (head) rows.push({ count: +head[2], domain: parts[1] || '', feed: parts[2] || '' });
}

const SOCIAL = /^(youtube\.com|youtu\.be|twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|tiktok\.com|threads\.net|pinterest\.com|reddit\.com|groups\.io|techhub\.social|mas\.to|kipp\.social|mastodon\.)/;
const INFRA = /^(bit\.ly|tinyurl\.com|goo\.gl|t\.co|forms\.gle|mailchi\.mp|docs\.google\.com|drive\.google\.com|sheets\.google\.com|apps\.apple\.com|itunes\.apple\.com|podcasts\.apple\.com|play\.google\.com|testflight\.apple\.com|.*zoom\.us)$/;
const SHOP = /^(elegantinsightsjewelry\.com|awarewolfgear\.com|theapexprogram\.com|venngage\.com|buy\.stripe\.com|stripe\.com|.*\.myshopify\.com|pmi\.org|accesspark\.shop|getrim\.app|onecourt\.io|.*\.campaign-archive\.com|.*\.list-manage\.com)$/;

function typeOf(r) {
  const d = r.domain;
  if (SOCIAL.test(d)) return '社群';
  if (INFRA.test(d)) return '基礎設施/短網址';
  if (SHOP.test(d)) return '贊助商/商店';
  if (/^RSS/.test(r.feed)) return 'RSS';
  if (/^Atom/.test(r.feed)) return 'Atom';
  if (r.feed.startsWith('NO FEED')) return '網站(無RSS)';
  return '網站(未驗證)';
}
const TIER = { '社群': 0, '基礎設施/短網址': 1, '贊助商/商店': 2 };

function report(list, label, baseTotal, baseLabel) {
  const target = baseTotal * 0.8;
  let acc = 0;
  const out = [];
  for (const r of list) {
    acc += r.count;
    out.push(r);
    if (acc >= target) break;
  }
  const lines = [];
  lines.push(label);
  lines.push(`80% 目標 (占${baseLabel}) = ${Math.round(target).toLocaleString()} links | 達標來源數 = ${out.length} 個 / ${list.length} 個 (累計 ${acc.toLocaleString()} = ${((acc / baseTotal) * 100).toFixed(1)}% of ${baseLabel})`);
  lines.push('');
  lines.push(`  RANK  LINKS  DOMAIN${' '.repeat(34)}TYPE        RSS?`);
  for (const [i, r] of out.entries()) lines.push(`  ${String(i + 1).padStart(4)}  ${String(r.count).padStart(6)}  ${r.domain.padEnd(40)} ${typeOf(r)}  ${/^RSS|^Atom/.test(r.feed) ? 'YES' : 'no'}`);
  const by = {};
  for (const r of out) { const t = typeOf(r); by[t] = by[t] || { n: 0, links: 0 }; by[t].n += 1; by[t].links += r.count; }
  lines.push('');
  lines.push('依類型統計（占達標 link 數比例）:');
  for (const [t, v] of Object.entries(by).sort((a, b) => b[1].links - a[1].links)) lines.push(`  ${t.padEnd(16)} ${String(v.n).padStart(4)} 個 | ${String(v.links).padStart(7)} links | ${((v.links / acc) * 100).toFixed(0)}%`);
  lines.push('');
  return lines.join('\n');
}

const total = rows.reduce((s, r) => s + r.count, 0);
const contentOnly = rows.filter((r) => !SOCIAL.test(r.domain) && !INFRA.test(r.domain) && !SHOP.test(r.domain));
const contentTotal = contentOnly.reduce((s, r) => s + r.count, 0);

const out = [];
out.push('TOP TECH TIDBITS - 80% COVERAGE SOURCES');
out.push('=======================================');
out.push(`來源: 141 期 (2024-01-04 ~ 2026-09-10) | 總連結 ${total.toLocaleString()} | 全部網域 ${rows.length}`);
out.push('');
out.push(report(rows, '[A] 全部來源 (含社群/贊助/短網址)', total, '全部連結'));
out.push('');
out.push(`純內容 (排除社群/基礎設施/贊助商商店): ${contentTotal.toLocaleString()} links / ${contentOnly.length} 網域`);
out.push('');
out.push(report(contentOnly, '[B] 純內容來源 (排除社群/基礎設施/贊助商商店)', contentTotal, '純內容連結'));
fs.writeFileSync(path.join(__dirname, 'coverage-80.txt'), out.join('\n\n') + '\n');
console.log('written coverage-80.txt');