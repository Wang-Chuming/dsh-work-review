#!/usr/bin/env bash
# Nightly entry point: write yesterday's Dream, then optionally run the review pass.
#
#   automation/run-nightly.sh [date]     # date = yesterday | YYYY-MM-DD
#
# Env:
#   DSH_WORK_REVIEW_VAULT      vault root (default: ~/.dsh/work-review.json's vaultRoot)
#   WORK_REVIEW_AUTO_REVIEW    off (default) | dry | live
#                              dry  → chain `review.js --run` (read-only, agent cannot write)
#                              live → chain `review.js --live` (agent may edit tasks and commit locally)
#   WORK_REVIEW_DAY_START_HOUR day boundary hour, default 5
#   DSH_CLI                    path to the harness CLI (default: the app bundle path)
#
# Exit codes: 0 ok / unchanged; 2 bad args or env; 3 validation failed; 4 providers failed;
#             5 review providers failed; 6 review output unparsable.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

DATE="${1:-yesterday}"
DAY_START_HOUR="${WORK_REVIEW_DAY_START_HOUR:-5}"

ARGS=("--date" "$DATE" "--day-start-hour" "$DAY_START_HOUR")
if [ -n "${DSH_WORK_REVIEW_VAULT:-}" ]; then
  ARGS+=("--vault" "$DSH_WORK_REVIEW_VAULT")
fi

case "${WORK_REVIEW_AUTO_REVIEW:-off}" in
  dry)  ARGS+=("--review" "--provider" "${WORK_REVIEW_PROVIDER:-auto}") ;;
  live) ARGS+=("--review-live" "--provider" "${WORK_REVIEW_PROVIDER:-auto}") ;;
  off)  ;;
  *)
    echo "WORK_REVIEW_AUTO_REVIEW must be off | dry | live (got: ${WORK_REVIEW_AUTO_REVIEW})" >&2
    exit 2
    ;;
esac

exec node "$ROOT/lib/nightly.js" "${ARGS[@]}"
