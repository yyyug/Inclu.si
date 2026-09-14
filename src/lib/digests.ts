import fs from 'node:fs/promises';
import path from 'node:path';
import type { Locale } from './i18n';

const DIGESTS_DIR = path.resolve('src/data/digests');

export interface DigestHighlight {
  title: string;
  slug: string;
}

export interface LocaleDigest {
  title: string;
  summary: string;
  highlights: DigestHighlight[];
}

export interface DailyDigest {
  date: string;
  generatedAt: string;
  en: LocaleDigest;
  'zh-TW': LocaleDigest;
}

export interface WeeklyDigest {
  week: string;
  range: { start: string; end: string };
  generatedAt: string;
  en: LocaleDigest;
  'zh-TW': LocaleDigest;
}

export interface ResolvedDigestLink {
  label: string;
  href: string;
  external: boolean;
}

function normalizeLocaleDigest(record: unknown): LocaleDigest {
  const r = record as Record<string, unknown> | undefined;
  const rawHighlights = Array.isArray(r?.highlights) ? r.highlights : [];
  const highlights: DigestHighlight[] = rawHighlights
    .filter((item: any): item is { title: string; slug: string } => item && typeof item.slug === 'string')
    .map((item: any) => ({ title: String(item.title ?? ''), slug: String(item.slug) }));
  return {
    title: String(r?.title ?? ''),
    summary: String(r?.summary ?? ''),
    highlights,
  };
}

function normalizeDailyEntry(date: string, record: unknown): DailyDigest | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  return {
    date,
    generatedAt: String(r.generatedAt ?? ''),
    en: normalizeLocaleDigest(r.en),
    'zh-TW': normalizeLocaleDigest(r['zh-TW']),
  };
}

function normalizeWeeklyEntry(week: string, record: unknown): WeeklyDigest | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  const range = r.range as Record<string, unknown> | undefined;
  return {
    week,
    range: { start: String(range?.start ?? ''), end: String(range?.end ?? '') },
    generatedAt: String(r.generatedAt ?? ''),
    en: normalizeLocaleDigest(r.en),
    'zh-TW': normalizeLocaleDigest(r['zh-TW']),
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let allDailyCache: DailyDigest[] | null = null;
let allWeeklyCache: WeeklyDigest[] | null = null;

export async function loadAllDailyDigests(): Promise<DailyDigest[]> {
  if (allDailyCache) return allDailyCache;

  let files: string[] = [];
  try {
    files = await fs.readdir(DIGESTS_DIR);
  } catch {
    allDailyCache = [];
    return allDailyCache;
  }

  const entries: DailyDigest[] = [];
  const dailyFiles = files.filter((f) => /^daily-\d{4}\.json$/.test(f)).sort();

  for (const file of dailyFiles) {
    const data = await readJsonObject(path.join(DIGESTS_DIR, file));
    for (const [date, record] of Object.entries(data)) {
      const entry = normalizeDailyEntry(date, record);
      if (entry) entries.push(entry);
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  allDailyCache = entries;
  return allDailyCache;
}

export async function loadAllWeeklyDigests(): Promise<WeeklyDigest[]> {
  if (allWeeklyCache) return allWeeklyCache;

  let files: string[] = [];
  try {
    files = await fs.readdir(DIGESTS_DIR);
  } catch {
    allWeeklyCache = [];
    return allWeeklyCache;
  }

  const entries: WeeklyDigest[] = [];
  const weeklyFiles = files.filter((f) => /^weekly-\d{4}\.json$/.test(f)).sort();

  for (const file of weeklyFiles) {
    const data = await readJsonObject(path.join(DIGESTS_DIR, file));
    for (const [week, record] of Object.entries(data)) {
      const entry = normalizeWeeklyEntry(week, record);
      if (entry) entries.push(entry);
    }
  }

  entries.sort((a, b) => a.week.localeCompare(b.week));
  allWeeklyCache = entries;
  return allWeeklyCache;
}

export async function getDailyDigest(date: string): Promise<DailyDigest | null> {
  const all = await loadAllDailyDigests();
  return all.find((d) => d.date === date) ?? null;
}

export async function getWeeklyDigest(week: string): Promise<WeeklyDigest | null> {
  const all = await loadAllWeeklyDigests();
  return all.find((d) => d.week === week) ?? null;
}

export async function getLatestDailyDigest(): Promise<DailyDigest | null> {
  const all = await loadAllDailyDigests();
  return all.length > 0 ? all[all.length - 1] : null;
}

export async function getLatestWeeklyDigest(): Promise<WeeklyDigest | null> {
  const all = await loadAllWeeklyDigests();
  return all.length > 0 ? all[all.length - 1] : null;
}

export function buildHighlightLinks(
  digest: LocaleDigest | null,
  entryBySlug: Map<string, { data: { title: string; sourceUrl: string } }>,
  basePath: string,
): ResolvedDigestLink[] {
  if (!digest?.highlights) return [];
  return digest.highlights.map((item) => {
    const entry = entryBySlug.get(item.slug);
    const href = entry?.data.sourceUrl ?? basePath;
    const external = /^https?:\/\//.test(href);
    return { label: entry?.data.title ?? item.title, href, external };
  });
}