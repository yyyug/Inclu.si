/**
 * fix-homepage-urls.mjs
 * For every EN+ZH markdown pair whose sourceUrl is a bare homepage,
 * search DuckDuckGo for the article title + domain and update both files.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONTENT_DIR = new URL('../src/content/news/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const DELAY_MS = 1200; // polite delay between DDG requests

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isHomepageUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.pathname === '/' || parsed.pathname === '';
  } catch {
    return false;
  }
}

async function searchDDG(query, domain) {
  const q = encodeURIComponent(query);
  const url = `https://duckduckgo.com/html/?q=${q}`;
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; inclu.si-url-fixer/1.0)' },
    });
    html = await res.text();
  } catch (e) {
    return null;
  }
  // Extract uddg= encoded links from DDG results
  const re = /uddg=(https?[^&"]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const decoded = decodeURIComponent(m[1]);
    try {
      const u = new URL(decoded);
      if (u.hostname.includes(domain.replace(/^www\./, '')) && !isHomepageUrl(decoded)) {
        return decoded;
      }
    } catch {
      // skip
    }
  }
  return null;
}

async function main() {
  const files = await readdir(CONTENT_DIR);
  const enFiles = files.filter((f) => f.endsWith('.md') && !f.includes('-zh-'));

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const enFile of enFiles) {
    const enPath = join(CONTENT_DIR, enFile);
    const zhFile = enFile.replace(/(-[a-f0-9]{8}\.md)$/, '-zh$1');
    const zhPath = join(CONTENT_DIR, zhFile);

    const enContent = await readFile(enPath, 'utf8');

    // Check if sourceUrl is a homepage
    const sourceMatch = enContent.match(/^sourceUrl:\s*"(https?:\/\/[^"]+)"/m);
    if (!sourceMatch) { skipped++; continue; }
    const currentUrl = sourceMatch[1];
    if (!isHomepageUrl(currentUrl)) { skipped++; continue; }

    // Extract title
    const titleMatch = enContent.match(/^title:\s*"([^"]+)"/m);
    if (!titleMatch) { failed++; console.warn(`[SKIP] No title in ${enFile}`); continue; }
    const title = titleMatch[1];

    let domain;
    try {
      domain = new URL(currentUrl).hostname;
    } catch {
      failed++; continue;
    }

    const query = `"${title}" site:${domain}`;
    process.stdout.write(`[SEARCH] ${domain}: ${title.slice(0, 60)}... `);
    await sleep(DELAY_MS);
    const articleUrl = await searchDDG(query, domain);

    if (!articleUrl) {
      // Try without quotes
      await sleep(DELAY_MS);
      const articleUrl2 = await searchDDG(`${title} ${domain}`, domain);
      if (!articleUrl2) {
        console.log('→ NOT FOUND');
        failed++;
        continue;
      }
      console.log(`→ ${articleUrl2}`);
      await patchFiles(enPath, zhPath, enContent, currentUrl, articleUrl2, zhFile);
      fixed++;
      continue;
    }

    console.log(`→ ${articleUrl}`);
    await patchFiles(enPath, zhPath, enContent, currentUrl, articleUrl, zhFile);
    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}, Skipped (already article URL): ${skipped}, Not found: ${failed}`);
}

async function patchFiles(enPath, zhPath, enContent, oldUrl, newUrl, zhFile) {
  const oldLine = `sourceUrl: "${oldUrl}"`;
  const newLine = `sourceUrl: "${newUrl}"`;
  const newEnContent = enContent.replace(oldLine, newLine);
  await writeFile(enPath, newEnContent, 'utf8');

  // Also patch ZH pair if it exists
  try {
    const zhContent = await readFile(zhPath, 'utf8');
    const newZhContent = zhContent.replace(oldLine, newLine);
    await writeFile(zhPath, newZhContent, 'utf8');
  } catch {
    // ZH file may not exist, ignore
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
