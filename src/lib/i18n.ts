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
  contactInvite: string;
  contactLinkLabel: string;
  intro: string;
  globalNewsMessage: string;
  latest: string;
  digest: string;
  digestWeek: string;
  digestUpdated: string;
  digestFallback: string;
  digestPreviousDay: string;
  digestNextDay: string;
  digestPreviousWeek: string;
  digestNextWeek: string;
  digestBackHome: string;
  digestViewWeekly: string;
  digestViewDaily: string;
  sourceLabel: string;
  empty: string;
  categories: string;
  search: string;
  allCategories: string;
}> = {
  en: {
    siteTitle: 'Inclusion and Accessibility News Hub',
    siteName: 'Inclu.si',
    subtitle: 'Stay on top of global accessibility news.',
    contactInvite: 'Have a source we should follow? ',
    contactLinkLabel: 'Contact us',
    intro: 'This site curates news on diversity, equity, inclusion, and accessibility from sources in multiple languages. English translations are provided to make reporting from different regions more accessible to more readers.',
    globalNewsMessage: 'Curated accessibility reporting across policy, design, and technology.',
    latest: 'Latest Coverage',
    digest: 'Daily Digest',
    digestWeek: 'Weekly Recap',
    digestUpdated: 'Updated (UTC+0)',
    digestFallback: 'Daily digest will appear here after the scheduled digest workflow runs.',
    digestPreviousDay: 'Previous digest',
    digestNextDay: 'Next digest',
    digestPreviousWeek: 'Previous week',
    digestNextWeek: 'Next week',
    digestBackHome: 'Back to homepage',
    digestViewWeekly: 'View weekly recap',
    digestViewDaily: 'View daily digest',
    sourceLabel: 'Source coverage',
    empty: 'No published stories yet. Trigger the ingest job or add an article from Pages CMS.',
    categories: 'Categories',
    search: 'Search',
    allCategories: 'All Categories',
  },
  'zh-TW': {
    siteTitle: 'Inclusion and Accessibility News Hub',
    siteName: 'Inclu.si',
    subtitle: '掌握全球無障礙新聞脈動。',
    contactInvite: '若你有值得追蹤的無障礙新聞來源，歡迎',
    contactLinkLabel: '聯絡我們',
    intro: '本站整理來自多種語言來源的多元、公平、共融與無障礙新聞並進行翻譯，讓讀者更容易掌握不同地區的重要報導。',
    globalNewsMessage: '聚焦政策、設計與科技的無障礙重點報導。',
    latest: '最新焦點',
    digest: '今日摘要',
    digestWeek: '本週摘要',
    digestUpdated: '更新時間 (UTC+0)',
    digestFallback: '每日摘要會在排程工作執行後顯示於此。',
    digestPreviousDay: '上一則摘要',
    digestNextDay: '下一則摘要',
    digestPreviousWeek: '上一週',
    digestNextWeek: '下一週',
    digestBackHome: '返回首頁',
    digestViewWeekly: '查看本週摘要',
    digestViewDaily: '查看每日摘要',
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
