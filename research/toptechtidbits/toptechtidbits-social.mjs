#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://toptechtidbits.com';
const API = `${SITE}/wp-json/wp/v2/posts`;
const UA = 'IncluSi-research/1.0 (social-account analysis)';
const AFTER = process.env.TIDBITS_AFTER || '2024-01-01T00:00:00';
const BEFORE = process.env.TIDBITS_BEFORE || '2026-09-11T00:00:00';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hrefRe = /href="([^"]+)"/g;
const YT_DIRECT_SEG = new Set(['embed', 'results', 'shorts', 'live', 'feed', 'subscription', 'playlist', 'playlists', 'channels', 'trending', 'watch']);
const X_SEG_IGNORE = new Set(['home','explore','i','search','share','hashtag','intent','status','notifications','settings','privacy','tos','about','login','signup','download','compose','messages','lists','topics','newsletters','moments','jobs','ads','developers','business','media','teams','community','hashtags','replies','likes']);
const oembedCache = new Map();

function letterDate(url) {
  let m = url.match(/newsletter-(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = url.match(/tidbits(\d{4})\/(\d{2})(\d{2})(\d{4})\/index\.html/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function inRange(iso) {
  const key = iso.slice(0, 10);
  return key >= AFTER.slice(0, 10) && key < BEFORE.slice(0, 10);
}
async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('utf8');
  } catch { return null; } finally { clearTimeout(t); }
}
function extractHrefs(html) {
  return [...new Set([...html.matchAll(hrefRe)].map((m) => m[1]))];
}
async function collectLetterUrls() {
  const urls = new Set();
  let page = 1;
  let total = 0;
  do {
    const res = await fetch(`${API}?per_page=100&after=${AFTER}&before=${BEFORE}&orderby=date&order=asc&page=${page}&_fields=id,date,link,title`, { headers: { 'User-Agent': UA } });
    if (!res.ok) break;
    total = Number(res.headers.get('x-wp-totalpages') || 0);
    const batch = await res.json();
    for (const p of batch) { if (/Top Tech Tidbits/i.test(p.title?.rendered || '')) { urls.add(p.link); } }
    page += 1;
    await delay(200);
  } while (page <= total);
  const matching = /newsletter-\d{2}-\d{2}-\d{4}|tidbits\d{4}\/\d{8}/;
  for (const arch of ['archive-2024', 'archive-2025']) {
    const t = await getText(`${SITE}/newsletters/${arch}/`);
    if (t) for (const u of [...new Set([...t.matchAll(hrefRe)].map((m) => m[1]))]) if (matching.test(u)) urls.add(u);
  }
  for (let p = 1; p < 40; p++) {
    const t = await getText(`${SITE}/newsletters/${p === 1 ? '' : '?_page=' + p}`);
    if (!t) break;
    const links = [...new Set([...t.matchAll(hrefRe)].map((m) => m[1]))];
    for (const u of links) { if (matching.test(u)) urls.add(u); }
    if (!links.some((x) => x.includes(`_page=${p + 1}`))) break;
  }
  const kept = [];
  for (const u of urls) {
    let d = letterDate(u);
    if (!d) { const rl = u.match(/newsletter-(\d{2})-(\d{2})-(\d{4})/); if (rl) continue; }
    if (d && inRange(d)) kept.push({ url: u.startsWith('http') ? u : SITE + u, date: d });
  }
  kept.sort((a, b) => a.date.localeCompare(b.date));
  console.error(`letters=${kept.length}`);
  return kept;
}

function ytDirect(host, u) {
  if (!/^(www\.)?youtube\.com$/.test(host)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2 || YT_DIRECT_SEG.has(segs[0])) return null;
  if (segs[0] === '@') return segs[1]?.toLowerCase() || null;
  if (segs[0] === 'channel' && segs[1]) return segs[1].toLowerCase();
  if (segs[0] === 'c' && segs[1]) return segs[1].toLowerCase();
  if (segs[0] === 'user' && segs[1]) return segs[1].toLowerCase();
  return null;
}
function ytVideo(host, u) {
  let id = null;
  if (/^(www\.)?youtube\.com$/.test(host)) {
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] === 'watch') id = u.searchParams.get('v');
    else if (segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'embed' || segs[0] === 'v') id = segs[1];
  } else if (/^(www\.)?youtu\.be$/.test(host)) {
    id = u.pathname.split('/').filter(Boolean)[0] || u.searchParams.get('v');
  }
  return id || null;
}
function xHandle(host, u) {
  if (!/^(www\.)?(twitter\.com|x\.com)$/.test(host)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  const seg = segs[0];
  if (!seg || X_SEG_IGNORE.has(seg.toLowerCase())) return null;
  return seg.replace(/^@/i, '').toLowerCase();
}
async function resolveChannel(videoId) {
  if (oembedCache.has(videoId)) return oembedCache.get(videoId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const u = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const j = await res.json();
        const name = (j.author_name || 'unknown').toLowerCase();
        oembedCache.set(videoId, name);
        return name;
      }
      if (res.status === 429) await delay(3000);
      else { oembedCache.set(videoId, null); return null; }
    } catch { /* retry */ }
  }
  oembedCache.set(videoId, null);
  return null;
}

async function main() {
  const letters = await collectLetterUrls();
  const ytDirectMap = new Map();
  const twMap = new Map();
  const issueVideos = [];   // per issue: Set of video ids
  let idx = 0;
  const CONC = 6;
  async function worker() {
    while (idx < letters.length) {
      const li = letters[idx];
      const html = await getText(li.url);
      const ytD = new Set();
      const xS = new Set();
      const vids = new Set();
      if (html) {
        for (const h of extractHrefs(html)) {
          let u;
          try { u = new URL(h); } catch { continue; }
          const host = u.hostname.toLowerCase().replace(/^www\./, '');
          const yd = ytDirect(host, u);
          if (yd && !ytD.has(yd)) { ytD.add(yd); ytDirectMap.set(yd, (ytDirectMap.get(yd) || 0) + 1); }
          const vid = ytVideo(host, u);
          if (vid) vids.add(vid);
          const xk = xHandle(host, u);
          if (xk && !xS.has(xk)) { xS.add(xk); twMap.set(xk, (twMap.get(xk) || 0) + 1); }
        }
      }
      issueVideos[idx] = vids;
      idx += 1;
      if (idx % 20 === 0) console.error(`\r[letters] ${idx}/${letters.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.error(`\r[letters] ${letters.length}/${letters.length}`);

  // resolve unique video ids -> channel names via oEmbed
  const allIds = [...new Set(issueVideos.flatMap((s) => [...s]))];
  console.error(`resolving ${allIds.length} unique video ids -> channels ...`);
  let done = 0;
  const CONC2 = 10;
  let ci = 0;
  async function vworker() {
    while (ci < allIds.length) {
      const id = allIds[ci++];
      await resolveChannel(id);
      done += 1;
      if (done % 50 === 0) console.error(`\r[oembed] ${done}/${allIds.length}`);
      await delay(120);
    }
  }
  await Promise.all(Array.from({ length: CONC2 }, vworker));
  console.error(`\r[oembed] ${done}/${allIds.length}`);
  const unresolvedCount = allIds.filter((id) => !oembedCache.get(id)).length;
  console.error(`unresolved videos: ${unresolvedCount}`);

  // count per-issue channel mentions (dedup within issue)
  const ytChannelMap = new Map();
  for (const vids of issueVideos) {
    const seen = new Set();
    for (const id of vids) {
      const ch = oembedCache.get(id);
      if (!ch || seen.has(ch)) continue;
      seen.add(ch);
      ytChannelMap.set(ch, (ytChannelMap.get(ch) || 0) + 1);
    }
  }

  const from = letters[0].date, to = letters[letters.length - 1].date;
  const ytChSorted = [...ytChannelMap.entries()].sort((a, b) => b[1] - a[1]);
  const ytDirectSorted = [...ytDirectMap.entries()].sort((a, b) => b[1] - a[1]);
  const twSorted = [...twMap.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [];
  lines.push('YOUTUBE CHANNELS MOST LINKED IN TOP TECH TIDBITS');
  lines.push(`(via video oEmbed attribution) | ${from} - ${to}, ${letters.length} issues | unique channels: ${ytChSorted.length}`);
  lines.push('');
  lines.push('  RANK  ISSUES  CHANNEL_NAME');
  ytChSorted.forEach(([ch, n], i) => lines.push(`  ${String(i + 1).padStart(4)}  ${String(n).padStart(6)}  ${ch}`));
  lines.push('');
  lines.push('YOUTUBE CHANNELS BY DIRECT CHANNEL LINK');
  lines.push(`(profile/channel URLs only) | unique channels: ${ytDirectSorted.length}`);
  lines.push('');
  lines.push('  RANK  ISSUES  CHANNEL');
  ytDirectSorted.forEach(([ch, n], i) => lines.push(`  ${String(i + 1).padStart(4)}  ${String(n).padStart(6)}  youtube.com/@${ch}`));
  lines.push('');
  lines.push('TWITTER / X ACCOUNTS MOST LINKED IN TOP TECH TIDBITS');
  lines.push(`(profile & status links) | ${from} - ${to}, ${letters.length} issues | unique accounts: ${twSorted.length}`);
  lines.push('');
  lines.push('  RANK  ISSUES  HANDLE');
  twSorted.forEach(([h, n], i) => lines.push(`  ${String(i + 1).padStart(4)}  ${String(n).padStart(6)}  @${h}`));
  fs.writeFileSync(path.join(__dirname, 'social-accounts.txt'), lines.join('\n') + '\n');
  console.error(`written social-accounts.txt (${ytChSorted.length} yt-video, ${ytDirectSorted.length} yt-direct, ${twSorted.length} twitter)`);
}
main().catch((e) => { console.error(e); process.exit(1); });