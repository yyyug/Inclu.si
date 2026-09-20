import fs from 'node:fs/promises';
import path from 'node:path';
import { askLLM, stripCodeFence } from './digest-llm.mjs';

const DIGESTS_DIR = path.resolve('src/data/digests');
const WEEK_KEY_PATTERN = /^(\d{4})-W(\d{2})$/;
const WEEK_MIN_HIGHLIGHTS = Number(process.env.DIGEST_WEEK_MIN_HIGHLIGHTS ?? 3);
const WEEK_MAX_HIGHLIGHTS = Number(process.env.DIGEST_WEEK_MAX_HIGHLIGHTS ?? 50);
const FORCE = process.env.DIGEST_WEEK_FORCE === '1' || process.env.FORCE === '1';
const DRY_RUN = process.env.DIGEST_DRY_RUN === '1';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day);
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + 7 * (week - 1));
  return result;
}

function weekRange(weekKey) {
  const match = WEEK_KEY_PATTERN.exec(weekKey);
  if (!match) throw new Error(`Invalid ISO week key: ${weekKey}`);
  const start = mondayOfIsoWeek(Number(match[1]), Number(match[2]));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start: formatDate(start), end: formatDate(end) };
}

async function listDailyFiles() {
  let files = [];
  try {
    files = await fs.readdir(DIGESTS_DIR);
  } catch {
    return [];
  }
  return files.filter((file) => /^daily-\d{4}\.json$/.test(file)).sort();
}

function normalizeLocaleDigest(record) {
  const highlights = Array.isArray(record?.highlights)
    ? record.highlights
      .filter((item) => item && typeof item.slug === 'string')
      .map((item) => ({ title: String(item.title ?? ''), slug: item.slug, url: item.url ? String(item.url) : '' }))
    : [];
  return {
    title: String(record?.title ?? ''),
    summary: String(record?.summary ?? ''),
    highlights,
  };
}

async function loadDailyDigests() {
  const entries = [];
  for (const file of await listDailyFiles()) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(DIGESTS_DIR, file), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      for (const [date, record] of Object.entries(parsed)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !record || typeof record !== 'object') continue;
        entries.push({
          date,
          generatedAt: String(record.generatedAt ?? ''),
          en: normalizeLocaleDigest(record.en),
          'zh-TW': normalizeLocaleDigest(record['zh-TW']),
        });
      }
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

function mergeWeeklyHighlights(days, locale) {
  const scored = new Map();

  for (const day of days) {
    const highlights = day[locale]?.highlights ?? [];
    highlights.forEach((item, index) => {
      let record = scored.get(item.slug);
      if (!record) {
        record = { title: item.title, slug: item.slug, url: item.url ? String(item.url) : '', score: 0, count: 0 };
        scored.set(item.slug, record);
      }
      record.score += 10000 - index;
      record.count += 1;
    });
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score || b.count - a.count || a.slug.localeCompare(b.slug))
    .slice(0, WEEK_MAX_HIGHLIGHTS)
    .map((item) => ({ title: item.title, slug: item.slug, url: item.url }));
}

function buildWeeklyPrompt(weekKey, range, days) {
  const dayLines = (locale) =>
    days
      .map((day) => {
        const digest = day[locale];
        if (!digest?.title) return `${day.date}: (no ${locale} digest)`;
        return `${day.date} | ${digest.title} | ${digest.summary}`;
      })
      .join('\n');

  return [
    'You are a disability accessibility news editor.',
    `Write a weekly recap for ISO week ${weekKey} (${range.start} to ${range.end}) by synthesizing that week's daily digests.`,
    'The weekly highlight list was already selected from the daily digests and is not part of the output.',
    '',
    'Return strict JSON only with keys: enTitle, enSummary, zhTitle, zhSummary.',
    "Title requirements: 8-15 words, captures the week's main theme or lead development.",
    "Summary requirements: 2-3 sentences, neutral and factual tone, lead with the most significant development of the week. Do not include a list of stories.",
    '',
    'English week digest (date | title | summary):',
    dayLines('en'),
    '',
    'Traditional Chinese week digest (date | title | summary):',
    dayLines('zh-TW'),
  ].join('\n');
}

function parseWeeklyResponse(content, enHighlights, zhHighlights) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw new Error(`Weekly digest LLM returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    en: {
      title: String(parsed.enTitle || 'Weekly Accessibility Digest'),
      summary: String(parsed.enSummary || ''),
      highlights: enHighlights,
    },
    'zh-TW': {
      title: String(parsed.zhTitle || '每週無障礙摘要'),
      summary: String(parsed.zhSummary || ''),
      highlights: zhHighlights,
    },
  };
}

function fallbackWeeklyResponse(range, enHighlights, zhHighlights) {
  return {
    en: {
      title: `Weekly Accessibility Digest ${range.start} – ${range.end}`,
      summary: `Weekly recap of accessibility developments from ${range.start} to ${range.end}.`,
      highlights: enHighlights,
    },
    'zh-TW': {
      title: `每週無障礙摘要 ${range.start} – ${range.end}`,
      summary: `${range.start} 至 ${range.end} 的無障礙重點報導週回顧。`,
      highlights: zhHighlights,
    },
  };
}

async function readJsonObject(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonObjectSorted(filePath, data) {
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

async function getExistingWeek(weekKey) {
  const year = weekKey.slice(0, 4);
  const filePath = path.join(DIGESTS_DIR, `weekly-${year}.json`);
  const data = await readJsonObject(filePath);
  return data[weekKey] ?? null;
}

async function upsertWeeklyDigest(output) {
  const year = output.week.slice(0, 4);
  await fs.mkdir(DIGESTS_DIR, { recursive: true });
  const filePath = path.join(DIGESTS_DIR, `weekly-${year}.json`);
  const data = await readJsonObject(filePath);
  data[output.week] = {
    range: output.range,
    generatedAt: output.generatedAt,
    en: output.en,
    'zh-TW': output['zh-TW'],
  };
  await writeJsonObjectSorted(filePath, data);
  console.log(`[weekly] wrote ${filePath}`);
}

async function main() {
  const days = await loadDailyDigests();
  if (days.length === 0) {
    console.log('[weekly] No daily digests found; nothing to aggregate.');
    return;
  }

  const explicitWeek = String(process.env.DIGEST_WEEK ?? '').trim();
  let targetWeeks;
  if (explicitWeek) {
    if (!WEEK_KEY_PATTERN.test(explicitWeek)) {
      throw new Error(`Invalid DIGEST_WEEK value: ${explicitWeek}. Expected format like 2026-W37.`);
    }
    targetWeeks = [explicitWeek];
  } else {
    const weeksWithData = new Set(days.map((day) => isoWeekOf(new Date(`${day.date}T00:00:00Z`))));
    targetWeeks = [...weeksWithData].sort();
    console.log(`[weekly] BACKFILL mode: ${targetWeeks.length} ISO week(s) with daily data`);
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const targetWeek of targetWeeks) {
    const weekDays = days.filter((day) => isoWeekOf(new Date(`${day.date}T00:00:00Z`)) === targetWeek);

    if (weekDays.length === 0) {
      console.log(`[weekly] ${targetWeek}: no daily digests; skipped.`);
      skipped += 1;
      continue;
    }

    const existing = await getExistingWeek(targetWeek);
    if (existing && !FORCE) {
      console.log(`[weekly] ${targetWeek} already generated (use DIGEST_WEEK_FORCE=1 to regenerate).`);
      skipped += 1;
      continue;
    }

    const range = weekRange(targetWeek);
    const enHighlights = mergeWeeklyHighlights(weekDays, 'en');
    const zhHighlights = mergeWeeklyHighlights(weekDays, 'zh-TW');
    if (enHighlights.length < WEEK_MIN_HIGHLIGHTS && zhHighlights.length < WEEK_MIN_HIGHLIGHTS) {
      console.log(`[weekly] ${targetWeek}: not enough highlights (en=${enHighlights.length}, zh=${zhHighlights.length}); skipped.`);
      skipped += 1;
      continue;
    }

    console.log(`[weekly] week=${targetWeek} days=${weekDays.length} en_highlights=${enHighlights.length} zh_highlights=${zhHighlights.length}`);

    if (DRY_RUN) {
      console.log('[weekly] DRY RUN: skipping LLM call and file write.');
      skipped += 1;
      continue;
    }

    try {
      let localeDigests;
      try {
        const prompt = buildWeeklyPrompt(targetWeek, range, weekDays);
        const content = await askLLM(prompt, prompt, { validateJson: true });
        localeDigests = parseWeeklyResponse(content, enHighlights, zhHighlights);
      } catch (error) {
        console.warn(`[weekly] ${targetWeek} LLM failed (${error.message}); using templated recap.`);
        localeDigests = fallbackWeeklyResponse(range, enHighlights, zhHighlights);
      }

      const output = {
        week: targetWeek,
        range,
        generatedAt: new Date().toISOString(),
        ...localeDigests,
      };

      await upsertWeeklyDigest(output);
      console.log(`Generated weekly digest for ${targetWeek}`);
      generated += 1;
    } catch (error) {
      console.error(`[weekly] ${targetWeek} failed: ${error.message}`);
      failed += 1;
    }
  }

  console.log(`[weekly] DONE: generated=${generated} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});