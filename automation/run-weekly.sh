#!/usr/bin/env bash
# Weekly entry point: turn last week's journals and Dreams into life/routines/<week>.md.
#
#   automation/run-weekly.sh [week]   # week = last | current | YYYY-Www
#
# Env:
#   DSH_WORK_REVIEW_VAULT   vault root (default: config file)
#   WORK_REVIEW_PROVIDER    auto (default) | dsh-default | a configured provider id
#
# Exit codes: 0 ok / unchanged; 2 bad args or env; 3 validation failed; 4 providers failed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

WEEK="${1:-last}"

ARGS=("--week" "$WEEK")
if [ -n "${DSH_WORK_REVIEW_VAULT:-}" ]; then
  ARGS+=("--vault" "$DSH_WORK_REVIEW_VAULT")
fi
if [ -n "${WORK_REVIEW_PROVIDER:-}" ]; then
  ARGS+=("--provider" "$WORK_REVIEW_PROVIDER")
fi

exec node "$ROOT/lib/cli.js" "${ARGS[@]}"
