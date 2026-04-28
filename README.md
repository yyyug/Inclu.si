# Inclu.si

A multilingual accessibility news website powered by Astro, Google News RSS, NewsAPI, and Ollama Cloud.

- Site title: Inclu.si
- Frontend: Astro + Tailwind CSS
- CMS: Pages CMS (Git-based)
- Hosting target: Cloudflare Pages

## What Is Implemented

- System language auto-routing at `/` (`zh*` -> `/zh-tw/`, otherwise `/en/`)
- News list and detail pages in English and Traditional Chinese
- 4-hour ingest workflow for multi-source news ingest (Google RSS + NewsAPI for `accessibility` and `無障礙`)
- Daily ingest workflow for X/Twitter social signals (`a11y`, `accessibility`, `inclusion`, plus selected accounts; rolling 24h UTC)
- Daily digest workflow with top stories summary shown above the news feed
- Static full-text search using Pagefind (`/en/search`, `/zh-tw/search`)

## Project Structure

```text
.
├─ .github/workflows/
│  ├─ news-ingest.yml
│  ├─ tweets-ingest.yml
│  └─ daily-digest.yml
├─ scripts/
│  ├─ fetch-news.mjs
│  ├─ fetch-a11y-tweets.mjs
│  └─ generate-daily-digest.mjs
├─ src/content/news/             # Generated + manual article markdown
├─ src/data/daily-digest.json    # Daily digest data source for homepage
├─ src/pages/en/search.astro
├─ src/pages/zh-tw/search.astro
└─ .pages.yml                    # Pages CMS config
```

## Installation

1. Use Node.js 22+.
2. Install dependencies:

```bash
npm install
```

3. Create local environment file from template:

```bash
cp .env.example .env
```

4. Fill required environment variables (fail-fast; no silent fallback):

- `OLLAMA_API_KEY`
- `OLLAMA_BASE_URL` (example `https://ollama.com/v1`)
- `OLLAMA_MODEL`
- `OLLAMA_TIMEOUT_MS` (example `60000`)
- `APIFY_TOKEN`
- `APIFY_ACTOR_ID`
- `A11Y_TWEET_QUERY` (optional override; leave empty to auto-build query)
- `A11Y_TWEET_KEYWORDS` (default `a11y,accessibility,inclusion`)
- `A11Y_TWEET_ACCOUNTS` (default `BlindNewWorld,UCBInfo`)
- `A11Y_TWEET_WINDOW_HOURS` (default `24`)
- `A11Y_TWEET_MAX_ITEMS` (default `100`)
- `A11Y_TWEET_LANGUAGES` (default `en,zh,ja,ko`)
- `DIGEST_LOOKBACK_DAYS` (example `2`)
- `GOOGLE_NEWS_RSS_URLS` (comma-separated RSS feed URLs)
- `NEWS_API_KEY`
- `NEWS_API_BASE_URL` (example `https://newsapi.org/v2/everything`)
- `NEWS_API_QUERIES` (example `accessibility,無障礙`)
- `NEWS_API_PAGE_SIZE` (example `50`)
- `MAX_ITEMS_PER_RUN`

## Local Usage

Run development server:

```bash
npm run dev
```

Manually ingest news once:

```bash
npm run news:ingest
```

Manually ingest social-signal tweets once:

```bash
npm run tweets:ingest
```

Run tweet ingest + clustering pipeline:

```bash
npm run tweets:pipeline
```

Manually generate daily digest once:

```bash
npm run news:digest
```

Build static site + search index:

```bash
npm run build
```

Preview production build:

```bash
npm run preview
```

## Source Catalog Import Files

Import-ready source lists are included for regional expansion and multilingual ingestion:

- `data/source-catalog.csv`
- `data/source-catalog.json`

Each record includes region, language codes, suggested keyword seeds, and ingestion priority with `rss` first and `x.com` as secondary signal.

## Homepage Digest Data Design

Daily digest content is read from `src/data/daily-digest.json`.

Data shape:

```json
{
	"date": "2026-04-26",
	"generatedAt": "2026-04-26T00:10:00.000Z",
	"en": {
		"title": "Daily Accessibility Digest",
		"summary": "...",
		"highlights": [{ "title": "...", "slug": "..." }]
	},
	"zh-TW": {
		"title": "每日無障礙摘要",
		"summary": "...",
		"highlights": [{ "title": "...", "slug": "..." }]
	}
}
```

The homepage digest block is rendered before the regular news list and links highlights to article detail pages.

## Workflow Separation

### 1) 4-hour ingest

File: `.github/workflows/news-ingest.yml`

- Schedule: every 4 hours at minute 5
- Action: runs `npm run news:ingest`
- Output: commits new markdown into `src/content/news`

### 2) Daily digest

File: `.github/workflows/daily-digest.yml`

- Schedule: every day at `00:10` UTC
- Action: runs `npm run news:digest`
- Output: updates and commits `src/data/daily-digest.json`

### 3) Daily X/Twitter social signals ingest

File: `.github/workflows/tweets-ingest.yml`

- Schedule: every day at `00:20` UTC
- Action: runs `npm run tweets:ingest` then `npm run news:cluster`
- Default limits: rolling `24` hours, max `100` tweets, languages `en,zh,ja,ko`, keywords `a11y,accessibility,inclusion`, and accounts `BlindNewWorld,UCBInfo`
- Output: commits new markdown into `src/content/news`

## Static Search (Pagefind)

- Search pages:
	- `/en/search`
	- `/zh-tw/search`
- Build script automatically runs:

```bash
astro build && npx pagefind --site dist
```

Search index output is generated into `dist/pagefind` during build.

## CMS Usage (Pages CMS)

1. Connect this repository in Pages CMS.
2. Open the `News Articles` collection.
3. Add/edit/delete markdown records.
4. Set `status: published` for visible stories.

## Cloudflare Pages Deployment

Use these settings:

- Framework preset: Astro
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `22`

If you run ingestion/digest only via GitHub Actions, Cloudflare does not need Ollama secrets.
If you run these scripts at build time (not recommended), add corresponding secrets in Cloudflare Pages.

## GitHub Setup (Actions + Secrets)

1. Push this project to GitHub.
2. In the repository, open `Settings -> Secrets and variables -> Actions`.
3. Add these repository secrets:

- `OLLAMA_API_KEY`
- `OLLAMA_BASE_URL` (for example `https://ollama.com/v1`)
- `NEWS_API_KEY`

4. Add this repository variable:

- `APIFY_ACTOR_ID` (for example `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`)

5. Ensure Actions are enabled in `Settings -> Actions`.
6. Manually run workflows once from the `Actions` tab:

- `4-Hour Ingest Accessibility News`
- `Daily Accessibility Digest`

7. Confirm commits are created by `github-actions[bot]` in:

- `src/data/news`
- `src/data/daily-digest.json`

The 4-hour ingest workflow already runs both steps in order:

- `npm run news:ingest`
- `npm run news:cluster`

This means similarity clustering (Jaccard + Levenshtein) is fixed in the 4-hour pipeline, not handled in the frontend.

## Cloudflare Pages Setup (Production)

1. In Cloudflare Dashboard, go to `Workers & Pages -> Create -> Pages -> Connect to Git`.
2. Select this GitHub repository.
3. Use these build settings:

- Framework preset: `Astro`
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `22`

4. Set production branch to your main branch (for example `main`).
5. Add custom domain (optional), then update DNS in Cloudflare.
6. Keep ingest/digest in GitHub Actions so Cloudflare builds stay deterministic.

## Recommended Runtime Variables

For local or CI runs, use:

- `MAX_ITEMS_PER_RUN=8` to `12`
- `BATCH_SIZE=3` (must stay between 3 and 5)
- `A11Y_TWEET_MAX_ITEMS=100`
- `A11Y_TWEET_LANGUAGES=en,zh,ja,ko`
- `CLUSTER_SIMILARITY_THRESHOLD=0.72`
- `CLUSTER_MAX_HOURS_DIFF=36`

Useful commands:

```bash
npm run news:ingest
npm run tweets:ingest
npm run news:cluster
npm run news:pipeline
npm run tweets:pipeline
npm run news:digest
```
