import type { APIRoute } from 'astro';
import { getPublishedNewsByLocale } from '../../lib/news';

export const GET: APIRoute = async () => {
  const entries = await getPublishedNewsByLocale('en');
  const index = entries.map((entry) => ({
    url: `/en/news/${entry.data.slug}`,
    title: entry.data.title,
    summary: entry.data.summary,
    category: entry.data.category,
    sourceName: entry.data.sourceName,
    tags: entry.data.tags,
    publishedAt: entry.data.publishedAt.toISOString(),
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
