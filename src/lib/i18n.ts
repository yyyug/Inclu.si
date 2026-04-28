export const locales = ['en', 'zh-TW'] as const;

export type Locale = (typeof locales)[number];

export const localeLabels: Record<Locale, string> = {
  en: 'English',
  'zh-TW': '繁體中文',
};

export const siteCopy: Record<Locale, {
  siteTitle: string;
  siteName: string;
  subtitle: string;
  intro: string;
  globalNewsMessage: string;
  latest: string;
  digest: string;
  digestUpdated: string;
  digestFallback: string;
  sourceLabel: string;
  empty: string;
  categories: string;
  search: string;
  allCategories: string;
}> = {
  en: {
    siteTitle: 'Accessibility News Hub',
    siteName: 'Inclu.si',
    subtitle: 'Stay on top of global accessibility news.',
    intro: 'This site curates news on diversity, equity, inclusion, and accessibility from sources in multiple languages. English translations are provided to make reporting from different regions more accessible to more readers.',
    globalNewsMessage: 'Curated accessibility reporting across policy, design, and technology.',
    latest: 'Latest Coverage',
    digest: 'Daily Digest',
    digestUpdated: 'Updated',
    digestFallback: 'Daily digest will appear here after the scheduled digest workflow runs.',
    sourceLabel: 'Source coverage',
    empty: 'No published stories yet. Trigger the ingest job or add an article from Pages CMS.',
    categories: 'Categories',
    search: 'Search',
    allCategories: 'All Categories',
  },
  'zh-TW': {
    siteTitle: 'Inclu.si',
    siteName: 'Inclu.si',
    subtitle: '掌握全球無障礙新聞脈動。',
    intro: '本站整理來自多種語言來源的多元、公平、共融與無障礙新聞並進行翻譯，讓讀者更容易掌握不同地區的重要報導。',
    globalNewsMessage: '聚焦政策、設計與科技的無障礙重點報導。',
    latest: '最新焦點',
    digest: '今日摘要',
    digestUpdated: '更新時間',
    digestFallback: '每日摘要會在排程工作執行後顯示於此。',
    sourceLabel: '相關來源',
    empty: '目前沒有已發佈文章，可先執行抓稿工作或在 Pages CMS 新增文章。',
    categories: '分類',
    search: '搜尋',
    allCategories: '所有分類',
  },
};

export function normalizeLocale(value: string | undefined): Locale {
  if (!value) {
    return 'en';
  }

  const lower = value.toLowerCase();
  if (lower.startsWith('zh')) {
    return 'zh-TW';
  }

  return 'en';
}

export function localeBasePath(locale: Locale): string {
  return locale === 'en' ? '/en' : '/zh-tw';
}
