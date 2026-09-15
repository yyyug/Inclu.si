#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const AFTER = process.env.TIDBITS_AFTER || '2024-01-01T00:00:00';
const BEFORE = process.env.TIDBITS_BEFORE || '2026-09-11T00:00:00';
const PROBE = (process.env.TIDBITS_PROBE || '1') === '1';
const PROBE_MIN = Number(process.env.TIDBITS_PROBE_MIN || 4);

const SITE = 'https://toptechtidbits.com';
const API = `${SITE}/wp-json/wp/v2/posts`;
const UA = 'IncluSi-research/1.0 (news-aggregator source analysis)';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function dateKey(d) {
  return String(d).slice(0, 10).replace(/-/g, '-');
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
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function restPosts() {
  const posts = [];
  let page = 1;
  let total = 0;
  do {
    const res = await fetch(`${API}?per_page=100&after=${AFTER}&before=${BEFORE}&orderby=date&order=asc&page=${page}&_fields=id,date,link,title,content`, { headers: { 'User-Agent': UA } });
    if (!res.ok) break;
    total = Number(res.headers.get('x-wp-totalpages') || 0);
    const batch = await res.json();
    posts.push(...batch);
    page += 1;
    await delay(200);
  } while (page <= total);
  return posts;
}

function hrefsOf(text) {
  return [...new Set([...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
}

function letterDate(url) {
  let m = url.match(/newsletter-(\d{2})-(\d{2})-(\d{4})/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = url.match(/tidbits(\d{4})\/(\d{2})(\d{2})(\d{4})\/index\.html/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = url.match(/tidbits(\d{4})\/(\d{2})(\d{2})(\d{4})\/?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

async function collectLetterUrls() {
  const urls = new Set();
  const matching = /newsletter-\d{2}-\d{2}-\d{4}|tidbits\d{4}\/\d{8}/;

  const posts = await restPosts();
  console.error(`rest posts=${posts.length}`);
  for (const p of posts) {
    if (/Top Tech Tidbits/i.test(p.title?.rendered || '')) urls.add(p.link);
  }

  for (const archUrl of [`${SITE}/newsletters/archive-2024/`, `${SITE}/newsletters/archive-2025/`]) {
    const t = await getText(archUrl);
    if (t) {
      for (const u of hrefsOf(t)) {
if (matching.test(u))  urls.add(u);
      }
    }
  }

  // paginate the current newsletters index
  for (let p = 1; p < 40; p++) {
    const u = `${SITE}/newsletters/${p === 1 ? '' : '?_page=' + p}`;
    const t = await getText(u);
    if (!t) break;
    const found = hrefsOf(t).filter((x) => matching.test(x) || /newsletters\/\?_page=/.test(x));
    let added = 0;
    for (const x of found) {
      if (matching.test(x)) {
        urls.add(x);
        added += 1;
      }
    }
    const hasMore = found.some((x) => x.includes(`_page=${p + 1}`));
    if (!hasMore) {
      console.error(`newsletters index: ${p} pages scanned`);
      break;
    }
  }

  // keep only in-range letters
  const kept = [];
  for (const u of urls) {
    const d = letterDate(u);
    if (!d || !inRange(d)) continue;
    kept.push({ url: u.startsWith('http') ? u : SITE + u, date: d });
  }
  kept.sort((a, b) => a.date.localeCompare(b.date));
  console.error(`letters collected=${kept.length}`);
  return kept;
}

function normalizeUrl(href) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href, SITE);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) {
    host = host.slice(4);
    u.hostname = host;
  }
  if (host === 'toptechtidbits.com') return null;
  u.searchParams.forEach((v, k) => {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|igshid|ref_|ref|via|source)/i.test(k)) u.searchParams.delete(k);
  });
  return u.href;
}

function extractHrefs(html) {
  const src = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const n = normalizeUrl(m[1]);
    if (n) out.push(n);
  }
  return out;
}

async function probeFeed(domain) {
  const paths = ['/feed/', '/feed', '/rss.xml', '/atom.xml', '/index.xml', '/rss', '/feed/atom', '/feeds/posts/default'];
  for (const p of paths) {
    let ok = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(`https://${domain}${p}`, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      ok = res.ok;
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 2048).toString('utf8').toLowerCase();
      const looks = /<rss|<feed|<\?xml|rss\+xml|atom\+xml/.test(buf);
      if (looks) {
        const kind = buf.includes('<feed') ? 'Atom' : 'RSS';
        return { url: `https://${domain}${p}`, kind };
      }
      void ct;
      await delay(120);
    } catch {
      /* skip */
    }
    if (!ok) await delay(120);
  }
  return null;
}

async function probeFeeds(domains) {
  const results = new Map();
  let done = 0;
  const workers = domains.map(async (d) => {
    const hit = await probeFeed(d);
    results.set(d, hit || { no: true });
    done += 1;
    if (done % 25 === 0) console.error(`\r[feed probe] ${done}/${domains.length}`);
  });
  await Promise.all(workers);
  return results;
}

const esc = (s) => String(s ?? '').replace(/\|/g, '').trim();

const AGG_EXACT = new Set([
  'youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'linkedin.com', 'instagram.com',
  'tiktok.com', 'threads.net', 'pinterest.com', 'snapchat.com', 'reddit.com', 'twitch.tv',
  'discord.com', 'discord.gg', 'telegram.org', 'whatsapp.com', 'bsky.app', 'bluesky.social',
  'mastodon.social', 'mastodon.toptechtidbits.com', 'mastodon.world', 'kipp.social',
  'techhub.social', 'mstdn.social', 'mas.to', 'groups.io',
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'youtu.be', 'forms.gle', 'tiny.cc', 'is.gd',
  'ow.ly', 'dlvr.it', 'buff.ly', 'lnkd.in', 'fb.me', 't.me', 'mailchi.mp',
  'apps.apple.com', 'itunes.apple.com', 'podcasts.apple.com', 'play.google.com',
  'surveymonkey.com', 'wufoo.com', 'typeform.com', 'buystripe.com', 'stripe.com',
  'buy.stripe.com', 'paypal.com', 'ko-fi.com', 'patreon.com', 'buymeacoffee.com',
  'gofundme.com', 'amazon.com', 'amzn.to', 'canva.com', 'venngage.com',
  'elegantinsightsjewelry.com', 'awarewolfgear.com', 'theapexprogram.com', 'merchandise',
]);
function aggExclude(d) {
  if (AGG_EXACT.has(d)) return true;
  if (/zoom\.us$/.test(d)) return true;
  if (/campaign-archive\.com$/.test(d)) return true;
  if (/list-manage\.com$/.test(d)) return true;
  if (/^meet\.google\.com|^forms\.|^docs\.google|^sheets\.google|^calendar\./.test(d)) return true;
  return false;
}

async function main() {
  console.error(`letters in ${AFTER.slice(0, 10)} .. ${BEFORE.slice(0, 10)}`);

  const letters = await collectLetterUrls();
  if (!letters.length) throw new Error('no letters collected');

  const byDomain = new Map();
  let totalLinks = 0;
  const concurrency = 6;
  let idx = 0;
  async function worker() {
    while (idx < letters.length) {
      const li = letters[idx++];
      const html = await getText(li.url);
      if (!html) {
        console.error(`skip ${li.url}`);
        continue;
      }
      const hrefs = extractHrefs(html);
      const seen = new Set(hrefs);
      for (const h of seen) {
        const host = new URL(h).hostname.toLowerCase();
        totalLinks += 1;
        const rec = byDomain.get(host) || { count: 0, range: [li.date, li.date] };
        rec.count += 1;
        if (li.date < rec.range[0]) rec.range[0] = li.date;
        if (li.date > rec.range[1]) rec.range[1] = li.date;
        byDomain.set(host, rec);
      }
      if (idx % 20 === 0) console.error(`\r[fetch] ${idx}/${letters.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.error(`\r[fetch] ${letters.length}/${letters.length}`);

  const sorted = [...byDomain.entries()].map(([d, r]) => ({ domain: d, ...r })).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  console.error(`domains=${sorted.length} source-links=${totalLinks} newsletters=${letters.length}`);

  let feeds = new Map();
  if (PROBE) {
    const probeList = sorted.filter((d) => d.count >= PROBE_MIN).map((d) => d.domain);
    console.error(`probing feeds for ${probeList.length} domains (count>=${PROBE_MIN}) ...`);
    feeds = await probeFeeds(probeList);
  }

  const from = letters[0].date;
  const to = letters[letters.length - 1].date;

  const lines = [];
  lines.push('TOP TECH TIDBITS - ARTICLE SOURCE DOMAIN ANALYSIS');
  lines.push(`Newsletters: ${from} - ${to} (${letters.length} issues)`);
  lines.push(`Total source links: ${totalLinks}`);
  lines.push(`Total unique domains: ${sorted.length}`);
  lines.push('');
  lines.push('RANKED DOMAIN LIST (with RSS feed status):');
  let rank = 1;
  for (const d of sorted) {
    const f = feeds.get(d.domain);
    let feedStr = 'Not checked';
    if (f?.no) feedStr = 'NO FEED (404)';
    else if (f?.url) feedStr = `${f.kind}: ${f.url.replace(/^https:\/\//, '')}`;
    lines.push(`  ${String(rank).padStart(3)}. ${String(d.count).padStart(5)} articles | ${d.domain.padEnd(38)} | ${esc(feedStr)}`);
    rank += 1;
  }
  lines.push('');
  lines.push(`Range covered: ${from} -> ${to}`);
  fs.writeFileSync(path.join(ROOT, 'tidbits-domain-analysis.txt'), lines.join('\n') + '\n');

  const confirmed = sorted.filter((d) => feeds.get(d.domain)?.url);
  const noFeed = sorted.filter((d) => feeds.get(d.domain)?.no);
  const notChecked = sorted.filter((d) => !feeds.get(d.domain)?.url && !feeds.get(d.domain)?.no);
  const fl = [];
  fl.push('ACTIONABLE RSS FEEDS FOR DISABILITY/ACCESSIBILITY NEWS AGGREGATOR');
  fl.push('=================================================================');
  fl.push(`Source: Top Tech Tidbits newsletters (${from} - ${to}, ${letters.length} issues)`);
  fl.push('');
  fl.push('CONFIRMED FEEDS (sorted by link frequency in newsletters):');
  confirmed.forEach((d, i) => {
    const f = feeds.get(d.domain);
    fl.push(`${String(i + 1).padStart(2)}. ${d.domain} (${d.count} links) - ${f.kind}: ${f.url}`);
  });
  fl.push('');
  fl.push('NO FEED (must scrape):');
  noFeed.forEach((d) => fl.push(`- ${d.domain} (${d.count} links)`));
  fl.push('');
  const unresolved = notChecked.filter((d) => d.count >= 2).slice(0, 100);
  fl.push(`UNRESOLVED / NOT CHECKED (${unresolved.length} shown of ${notChecked.length} total; count >= ${PROBE_MIN} only probed)`);
  unresolved.forEach((d) => fl.push(`- ${d.domain} (${d.count} links)`));
  fs.writeFileSync(path.join(ROOT, 'tidbits-rss-feeds.txt'), fl.join('\n') + '\n');

  // ---- aggregator-ready feeds (news/technology, RSS/Atom confirmed) ----
  const aggregator = confirmed
    .filter((d) => d.count >= 3)
    .filter((d) => !aggExclude(d.domain))
    .sort((a, b) => b.count - a.count)
    .map((d) => { const f = feeds.get(d.domain); return { ...d, feed: f }; });
  const al = [
    'AGGREGATOR-READY RSS / ATOM FEEDS',
    '=================================',
    `Source: Top Tech Tidbits newsletters (${from} - ${to}, ${letters.length} issues)`,
    `Minimum link count threshold: 3`,
    `Total ready feeds: ${aggregator.length}`,
    '',
    'COUNT  KIND  DOMAIN  FEED_URL',
  ];
  for (const a of aggregator) al.push(`${String(a.count).padStart(5)}  ${a.feed.kind.padEnd(4)}  ${a.domain}  ${a.feed.url}`);
  al.push('');
  al.push('Filters applied:');
  al.push('- domains with confirmed RSS/Atom feed only');
  al.push('- link-count >= 3 in sampled newsletters');
  al.push('- excluded social, shorteners, app stores, zoom/forms/sponsors');
  fs.writeFileSync(path.join(ROOT, 'aggregator-feeds.txt'), al.join('\n') + '\n');
  const tsv = ['count\tkind\tdomain\tfeed_url', ...aggregator.map((a) => `${a.count}\t${a.feed.kind}\t${a.domain}\t${a.feed.url}`)].join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT, 'aggregator-feeds.tsv'), tsv);

  console.error('wrote tidbits-domain-analysis.txt & tidbits-rss-feeds.txt & aggregator-feeds.txt');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});