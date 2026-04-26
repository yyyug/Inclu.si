import { getCollection, type CollectionEntry } from 'astro:content';
import type { Locale } from './i18n';

export type NewsEntry = CollectionEntry<'news'>;

function mapLocale(locale: Locale): 'en' | 'zh-TW' {
  return locale === 'en' ? 'en' : 'zh-TW';
}

export async function getPublishedNewsByLocale(locale: Locale): Promise<NewsEntry[]> {
  const lang = mapLocale(locale);
  const items = await getCollection('news', ({ data }) => data.lang === lang && data.status === 'published');
  return items.sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());
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
