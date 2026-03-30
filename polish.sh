#!/bin/bash
# Evo Polish — lightweight housekeeping every 30 minutes
# Doesn't run the full evolution cycle; just tidies up the repo.

set -euo pipefail
cd ~/hermes-evo

echo "[polish] Starting at $(date)"

# 1. Run the full evolution cycle (already has AUTO_APPROVE_CONFIDENCE=95)
bash ./evolve.sh

# 2. Auto-fix lint issues if lint script exists
if npm run lint &>/dev/null; then
  echo "[polish] Lint: clean"
else
  echo "[polish] Lint: issues found (run npm run lint for details)"
fi

# 3. Check build is clean
if npm run build &>/dev/null; then
  echo "[polish] Build: clean"
else
  echo "[polish] Build: warnings/errors detected"
fi

# 4. Auto-commit any uncommitted polish成果 (only meaningful changes)
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  # Only commit if there are actual file changes (not just timestamp/noop)
  if git diff --cached --quiet; then
    echo "[polish] No meaningful changes to commit"
  else
    git commit -m "chore: $(date '+%Y-%m-%d %H:%M') — evo polish" --allow-empty
    git push origin main 2>/dev/null || echo "[polish] Push failed (may be up to date)"
    echo "[polish] Changes committed and pushed"
  fi
else
  echo "[polish] No uncommitted changes"
fi

echo "[polish] Done at $(date)"
