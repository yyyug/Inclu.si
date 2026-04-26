import type { Locale } from './i18n';

export const categoryLabels: Record<string, Record<Locale, string>> = {
  'digital-a11y': { en: 'Digital A11y', 'zh-TW': '數位無障礙' },
  'assistive-tech': { en: 'Assistive Tech', 'zh-TW': '輔助科技' },
  'laws-rights': { en: 'Laws & Rights', 'zh-TW': '政策與法規' },
  'physical-design': { en: 'Physical Design', 'zh-TW': '空間與通用設計' },
  'lifestyle-culture': { en: 'Lifestyle & Culture', 'zh-TW': '文化與生活' },
  'case-studies': { en: 'Case Studies', 'zh-TW': '案例與最佳實踐' },
  'social-signals': { en: 'Social Signals', 'zh-TW': '社群訊號' },
  general: { en: 'General', 'zh-TW': '綜合' },
};

export const categoryKeys = Object.keys(categoryLabels);
