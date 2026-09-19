@echo off
rem Run local YouTube capture, then push candidates to trigger CI ingestion.
rem Requirements: node, git (both on PATH). Double-click to run.
chcp 65001 >NUL
cd /d "%~dp0.."

echo === [1/4] Fetching YouTube videos from sources-youtube.tsv ===
node youtube-local\fetch-youtube.mjs
if errorlevel 1 (
  echo.
  echo [FAIL] YouTube fetch failed. See messages above.
  echo Hint: too many requests in a short time makes YouTube rate-limit
  echo (HTTP 404). Wait a few minutes and run this file again.
  pause
  exit /b 1
)

echo === [2/4] Committing candidate file ===
git add youtube-local\youtube-candidates.json
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "chore: update YouTube candidates"
) else (
  echo [INFO] No new YouTube videos; nothing to commit.
)

echo === [3/4] Pulling latest remote changes (rebase) ===
git -c core.editor=true pull --rebase --autostash origin main
if errorlevel 1 (
  echo [FAIL] git pull failed. Resolve conflicts and push manually.
  pause
  exit /b 1
)

echo === [4/4] Pushing to GitHub (triggers CI ingestion) ===
git push origin main
if errorlevel 1 (
  echo [FAIL] git push failed.
  pause
  exit /b 1
)

echo.
echo Done. The CI run has been triggered; it will summarize and deploy the new videos.
pause