import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locale } from './i18n';

type NewsLang = 'en' | 'zh-TW';

export interface NewsData {
  title: string;
  slug: string;
  lang: NewsLang;
  summary: string;
  category: string;
  tags: string[];
  sourceName: string;
  sourceUrl: string;
  relatedSources: Array<{ name: string; url: string }>;
  sourceCountry?: string;
  queryRegion?: string;
  region?: string;
  ingestType?: string;
  ingestSource?: string;
  ingestProvider?: string;
  clusterId: string;
  status: 'draft' | 'published' | 'archived' | 'deleted';
  translationOf?: string;
  publishedAt: Date;
  fetchedAt: Date;
}

export interface NewsEntry {
  id: string;
  data: NewsData;
  body: string;
}

interface RawNewsRecord {
  title: string;
  slug: string;
  lang: NewsLang;
  summary: string;
  category: string;
  tags?: string[];
  sourceName: string;
  sourceUrl: string;
  relatedSources?: Array<{ name: string; url: string }>;
  sourceCountry?: string | null;
  queryRegion?: string | null;
  region?: string | null;
  ingestType?: string | null;
  ingestSource?: string | null;
  ingestProvider?: string | null;
  clusterId: string;
  status?: 'draft' | 'published' | 'archived' | 'deleted';
  translationOf?: string;
  publishedAt: string;
  fetchedAt: string;
  body?: string;
}

const NEWS_DATA_DIR = path.resolve('src/data/news');
const LEGACY_MD_DIR = path.resolve('src/content/news');

function mapLocale(locale: Locale): 'en' | 'zh-TW' {
  return locale === 'en' ? 'en' : 'zh-TW';
}

function normalizeRecord(raw: RawNewsRecord): NewsEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.slug || !raw.title || !raw.lang || !raw.publishedAt) return null;

  const publishedAt = new Date(raw.publishedAt);
  const fetchedAt = new Date(raw.fetchedAt || raw.publishedAt);
  if (Number.isNaN(publishedAt.getTime()) || Number.isNaN(fetchedAt.getTime())) return null;

  return {
    id: raw.slug,
    data: {
      title: String(raw.title),
      slug: String(raw.slug),
      lang: raw.lang,
      summary: String(raw.summary ?? ''),
      category: String(raw.category ?? 'general'),
      tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : [],
      sourceName: String(raw.sourceName ?? ''),
      sourceUrl: String(raw.sourceUrl ?? ''),
      relatedSources: Array.isArray(raw.relatedSources)
        ? raw.relatedSources
          .filter((source) => source && typeof source.name === 'string' && typeof source.url === 'string')
          .map((source) => ({ name: source.name, url: source.url }))
        : [],
      sourceCountry: raw.sourceCountry ?? undefined,
      queryRegion: raw.queryRegion ?? undefined,
      region: raw.region ?? undefined,
      ingestType: raw.ingestType ?? undefined,
      ingestSource: raw.ingestSource ?? undefined,
      ingestProvider: raw.ingestProvider ?? undefined,
      clusterId: String(raw.clusterId ?? ''),
      status: raw.status ?? 'published',
      translationOf: raw.translationOf,
      publishedAt,
      fetchedAt,
    },
    body: String(raw.body ?? raw.summary ?? ''),
  };
}

async function loadJsonNewsRecords(): Promise<NewsEntry[]> {
  const entries: NewsEntry[] = [];
  let files: string[] = [];

  try {
    files = await fs.readdir(NEWS_DATA_DIR);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(NEWS_DATA_DIR, file);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;

      for (const item of parsed) {
        const entry = normalizeRecord(item as RawNewsRecord);
        if (entry) entries.push(entry);
      }
    } catch {
      continue;
    }
  }

  return entries;
}

function extractFrontmatterField(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*"([^"]*)"$`, 'm'));
  return match ? match[1] : '';
}

function parseLegacyMarkdown(text: string): NewsEntry | null {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  const slug = extractFrontmatterField(frontmatter, 'slug');
  const title = extractFrontmatterField(frontmatter, 'title');
  const lang = extractFrontmatterField(frontmatter, 'lang') as NewsLang;
  const summary = extractFrontmatterField(frontmatter, 'summary');
  const category = extractFrontmatterField(frontmatter, 'category') || 'general';
  const sourceName = extractFrontmatterField(frontmatter, 'sourceName');
  const sourceUrl = extractFrontmatterField(frontmatter, 'sourceUrl');
  const clusterId = extractFrontmatterField(frontmatter, 'clusterId');
  const status = (extractFrontmatterField(frontmatter, 'status') || 'published') as NewsData['status'];
  const publishedAtRaw = extractFrontmatterField(frontmatter, 'publishedAt');
  const fetchedAtRaw = extractFrontmatterField(frontmatter, 'fetchedAt') || publishedAtRaw;
  const sourceCountry = extractFrontmatterField(frontmatter, 'sourceCountry') || undefined;
  const queryRegion = extractFrontmatterField(frontmatter, 'queryRegion') || undefined;
  const region = extractFrontmatterField(frontmatter, 'region') || undefined;
  const translationOf = extractFrontmatterField(frontmatter, 'translationOf') || undefined;

  const publishedAt = new Date(publishedAtRaw);
  const fetchedAt = new Date(fetchedAtRaw);

  if (!slug || !title || !lang || Number.isNaN(publishedAt.getTime())) return null;
  if (Number.isNaN(fetchedAt.getTime())) return null;

  return {
    id: slug,
    data: {
      title,
      slug,
      lang,
      summary,
      category,
      tags: [],
      sourceName,
      sourceUrl,
      relatedSources: sourceName && sourceUrl ? [{ name: sourceName, url: sourceUrl }] : [],
      sourceCountry,
      queryRegion,
      region,
      clusterId,
      status,
      translationOf,
      publishedAt,
      fetchedAt,
    },
    body,
  };
}

async function loadLegacyMarkdownRecords(): Promise<NewsEntry[]> {
  const entries: NewsEntry[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(LEGACY_MD_DIR);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(LEGACY_MD_DIR, file);

    try {
      const text = await fs.readFile(filePath, 'utf8');
      const entry = parseLegacyMarkdown(text);
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }

  return entries;
}

async function loadAllNewsEntries(): Promise<NewsEntry[]> {
  const [jsonEntries, legacyEntries] = await Promise.all([
    loadJsonNewsRecords(),
    loadLegacyMarkdownRecords(),
  ]);

  const bySlug = new Map<string, NewsEntry>();
  for (const entry of [...legacyEntries, ...jsonEntries]) {
    const current = bySlug.get(entry.data.slug);
    if (!current || entry.data.fetchedAt.getTime() >= current.data.fetchedAt.getTime()) {
      bySlug.set(entry.data.slug, entry);
    }
  }

  return Array.from(bySlug.values());
}

export async function getPublishedNewsByLocale(locale: Locale): Promise<NewsEntry[]> {
  const lang = mapLocale(locale);
  const items = await loadAllNewsEntries();

  return items
    .filter((entry) => entry.data.lang === lang && entry.data.status === 'published')
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());
}

export async function getPublishedNewsBySlug(locale: Locale, slug: string): Promise<NewsEntry | null> {
  const lang = mapLocale(locale);
  const items = await loadAllNewsEntries();
  return items.find((entry) => entry.data.lang === lang && entry.data.status === 'published' && entry.data.slug === slug) ?? null;
}

export function collectCategoryCounts(entries: NewsEntry[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const current = counts.get(entry.data.category) ?? 0;
    counts.set(entry.data.category, current + 1);
  }

  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}
