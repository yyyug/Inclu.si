import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_DIR = path.resolve('src/content/news');
const SIMILARITY_THRESHOLD = Number(process.env.CLUSTER_SIMILARITY_THRESHOLD ?? 0.72);
const MAX_HOURS_DIFF = Number(process.env.CLUSTER_MAX_HOURS_DIFF ?? 36);

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinDistance(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  const len1 = s1.length;
  const len2 = s2.length;

  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  const prev = new Array(len2 + 1);
  const curr = new Array(len2 + 1);

  for (let j = 0; j <= len2; j += 1) prev[j] = j;

  for (let i = 1; i <= len1; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= len2; j += 1) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= len2; j += 1) prev[j] = curr[j];
  }

  return prev[len2];
}

function levenshteinSimilarity(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  const longest = Math.max(s1.length, s2.length);
  if (longest === 0) return 1;
  return 1 - (levenshteinDistance(s1, s2) / longest);
}

function titleSimilarity(a, b) {
  const jac = jaccardSimilarity(a, b);
  const lev = levenshteinSimilarity(a, b);
  return (jac * 0.6) + (lev * 0.4);
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  return match[1];
}

function getField(frontmatter, key) {
  const regex = new RegExp(`^${key}:\\s*"([^"\\n]*)"$`, 'm');
  const match = frontmatter.match(regex);
  return match ? match[1] : '';
}

function parseRelatedSources(frontmatter) {
  const lines = frontmatter.split('\n');
  const sources = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === 'relatedSources:') {
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+name:\s+"/.test(lines[j])) {
        const nameMatch = lines[j].match(/^\s*-\s+name:\s+"([^"]+)"/);
        const urlLine = lines[j + 1] ?? '';
        const urlMatch = urlLine.match(/^\s+url:\s+"([^"]+)"/);
        if (nameMatch && urlMatch) {
          sources.push({ name: nameMatch[1], url: urlMatch[1] });
        }
        j += 2;
      }
      break;
    }
  }
  return sources;
}

function renderRelatedSources(sources) {
  const lines = ['relatedSources:'];
  for (const source of sources) {
    const safeName = source.name.replace(/"/g, '\\"');
    const safeUrl = source.url.replace(/"/g, '\\"');
    lines.push(`  - name: "${safeName}"`);
    lines.push(`    url: "${safeUrl}"`);
  }
  return `${lines.join('\n')}\n`;
}

function replaceClusterId(frontmatter, clusterId) {
  if (/^clusterId:\s*"[^"]*"$/m.test(frontmatter)) {
    return frontmatter.replace(/^clusterId:\s*"[^"]*"$/m, `clusterId: "${clusterId}"`);
  }
  return `${frontmatter}\nclusterId: "${clusterId}"`;
}

function replaceRelatedSources(frontmatter, sources) {
  const replacement = renderRelatedSources(sources);
  const pattern = /^relatedSources:\n(?:\s*-\s+name:\s+"[^"\n]*"\n\s+url:\s+"[^"\n]*"\n?)*/m;
  if (pattern.test(frontmatter)) {
    return frontmatter.replace(pattern, replacement);
  }

  return `${frontmatter}\n${replacement}`;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x) {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;

    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] += 1;
    }
  }
}

async function readStories() {
  const files = await fs.readdir(CONTENT_DIR);
  const stories = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(CONTENT_DIR, file);
    const text = await fs.readFile(filePath, 'utf8');
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter) continue;

    const title = getField(frontmatter, 'title');
    const category = getField(frontmatter, 'category');
    const sourceName = getField(frontmatter, 'sourceName');
    const sourceUrl = getField(frontmatter, 'sourceUrl');
    const clusterId = getField(frontmatter, 'clusterId');
    const publishedAtRaw = getField(frontmatter, 'publishedAt');
    const status = getField(frontmatter, 'status');
    const lang = getField(frontmatter, 'lang');

    if (!title || !publishedAtRaw || status !== 'published') continue;

    const publishedAt = new Date(publishedAtRaw);
    if (Number.isNaN(publishedAt.getTime())) continue;

    stories.push({
      file,
      filePath,
      text,
      frontmatter,
      title,
      category,
      lang,
      sourceName,
      sourceUrl,
      clusterId,
      publishedAt,
      relatedSources: parseRelatedSources(frontmatter),
    });
  }

  return stories;
}

function replaceStatus(frontmatter, status) {
  if (/^status:\s*"[^"]*"$/m.test(frontmatter)) {
    return frontmatter.replace(/^status:\s*"[^"]*"$/m, `status: "${status}"`);
  }
  return `${frontmatter}\nstatus: "${status}"`;
}

function buildGroups(stories) {
  const uf = new UnionFind(stories.length);

  for (let i = 0; i < stories.length; i += 1) {
    for (let j = i + 1; j < stories.length; j += 1) {
      if (stories[i].category !== stories[j].category) continue;

      const hoursDiff = Math.abs(stories[i].publishedAt.getTime() - stories[j].publishedAt.getTime()) / 3600000;
      if (hoursDiff > MAX_HOURS_DIFF) continue;

      const score = titleSimilarity(stories[i].title, stories[j].title);
      if (score >= SIMILARITY_THRESHOLD) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < stories.length; i += 1) {
    const root = uf.find(i);
    const bucket = groups.get(root) ?? [];
    bucket.push(stories[i]);
    groups.set(root, bucket);
  }

  return Array.from(groups.values()).filter((group) => group.length > 1);
}

function chooseCanonicalClusterId(group) {
  const sorted = [...group].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  const existing = sorted.map((story) => story.clusterId).filter(Boolean);
  if (existing.length > 0) {
    return existing.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }

  const first = sorted[0];
  const fallback = first.sourceUrl || first.file;
  const simple = Buffer.from(fallback).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  return `cluster-${simple || 'merged'}`;
}

function collectMergedSources(group) {
  const merged = new Map();

  for (const story of group) {
    const primaryKey = `${story.sourceName}|${story.sourceUrl}`;
    if (story.sourceName && story.sourceUrl && !merged.has(primaryKey)) {
      merged.set(primaryKey, { name: story.sourceName, url: story.sourceUrl });
    }

    for (const rel of story.relatedSources) {
      const key = `${rel.name}|${rel.url}`;
      if (rel.name && rel.url && !merged.has(key)) {
        merged.set(key, rel);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function updateGroup(group) {
  const canonicalClusterId = chooseCanonicalClusterId(group);
  const mergedSources = collectMergedSources(group);

  const leadByLang = new Map();
  const sorted = [...group].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  for (const story of sorted) {
    const key = story.lang || 'unknown';
    if (!leadByLang.has(key)) {
      leadByLang.set(key, story.file);
    }
  }

  let changed = 0;
  for (const story of group) {
    let nextFrontmatter = replaceClusterId(story.frontmatter, canonicalClusterId);
    nextFrontmatter = replaceRelatedSources(nextFrontmatter, mergedSources);
    const status = leadByLang.get(story.lang || 'unknown') === story.file ? 'published' : 'archived';
    nextFrontmatter = replaceStatus(nextFrontmatter, status);

    if (nextFrontmatter === story.frontmatter) continue;

    const nextText = story.text.replace(/^---\n[\s\S]*?\n---\n?/, `---\n${nextFrontmatter}\n---\n`);
    await fs.writeFile(story.filePath, nextText, 'utf8');
    changed += 1;
  }

  return changed;
}

async function main() {
  const stories = await readStories();
  const groups = buildGroups(stories);

  let changedFiles = 0;
  for (const group of groups) {
    changedFiles += await updateGroup(group);
  }

  console.log(`Scanned stories: ${stories.length}`);
  console.log(`Similar groups: ${groups.length}`);
  console.log(`Changed files: ${changedFiles}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
