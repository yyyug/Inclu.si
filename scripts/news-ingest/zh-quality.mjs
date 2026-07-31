const ZH_CHARS_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export function hasZhChars(text) {
  return ZH_CHARS_RE.test(String(text ?? ''));
}

const PLACEHOLDER_TITLE_PATTERNS = [
  /^無障礙社群訊號\s+\d+$/,
  /^Facebook 無障礙更新\s+\d+$/,
  /^無障礙新聞$/,
];

export function zhIsTranslated(title, summary) {
  const t = String(title ?? '');
  const s = String(summary ?? '');
  if (!hasZhChars(t) || !hasZhChars(s)) return false;
  for (const pattern of PLACEHOLDER_TITLE_PATTERNS) {
    if (pattern.test(t)) return false;
  }
  if (s.includes('尚待翻譯')) return false;
  return true;
}
