import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const sourceSchema = z.object({
  name: z.string(),
  url: z.string().url(),
});

const newsCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    lang: z.enum(['en', 'zh-TW']),
    summary: z.string(),
    category: z.enum([
      'digital-a11y',
      'assistive-tech',
      'laws-rights',
      'physical-design',
      'lifestyle-culture',
      'case-studies',
      'social-signals',
      'general',
    ]),
    tags: z.array(z.string()).default([]),
    sourceName: z.string(),
    sourceUrl: z.string().url(),
    relatedSources: z.array(sourceSchema).default([]),
    region: z.string().optional(),
    clusterId: z.string(),
    status: z.enum(['draft', 'published', 'archived', 'deleted']).default('draft'),
    translationOf: z.string().optional(),
    publishedAt: z.coerce.date(),
    fetchedAt: z.coerce.date(),
  }),
});

export const collections = {
  news: newsCollection,
};
