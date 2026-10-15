#!/usr/bin/env bash
# Run the Beyblade HK monitor poll and push the fresh snapshot to GitHub.
# Used by local cron (OpenClaw) because the GitHub token lacks `workflow` scope,
# so the Actions workflow can't be committed. The site itself is on GitHub Pages.
#
# cron: */15 * * * *  (Asia/Hong_Kong)
set -euo pipefail

REPO_DIR="/home/ivan/.openclaw/workspaceexitexit/work/hkbey-monitor-clone"
LOG="/home/ivan/.openclaw/workspaceexitexit/logs/hkbey-monitor.log"
mkdir -p "$(dirname "$LOG")"

cd "$REPO_DIR"
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  node pollers/poll.mjs
  # Notify layer (no-op if BEY_TG_TOKEN unset).
  BEY_TG_CHAT="${BEY_TG_CHAT:-6467508991}" node pollers/notify.mjs || true
  git add data/
  if git diff --cached --quiet; then
    echo "no data change"
  else
    git -c user.name="Jietech" -c user.email="sales@3dscanner.com.hk" \
      commit -q -m "data: poll $(date -u +'%Y-%m-%dT%H:%MZ')"
    git push -q origin main && echo "pushed"
  fi
} >> "$LOG" 2>&1
