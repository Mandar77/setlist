#!/usr/bin/env bash
# Session 1, step 6: record the AWS account id as a GitHub secret.
#
# The id is never written to disk and never committed: this repository is public and
# ADR-005 keeps account identifiers out of it. CI reads it from the secret.
#
#   bash scripts/hitl/session1-finish.sh --dry-run
#   bash scripts/hitl/session1-finish.sh
set -euo pipefail

DRY_RUN=0
REPO_NAME="setlist"

usage() {
  cat <<'USAGE'
Usage: session1-finish.sh [--dry-run] [--repo NAME]

Prompts for the 12-digit AWS account id and stores it as the repository secret
AWS_ACCOUNT_ID. Nothing is written to disk.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo)    REPO_NAME="${2:?--repo needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh is not installed." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

OWNER="$(gh api user --jq .login)"
SLUG="${OWNER}/${REPO_NAME}"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] prompt (hidden) for the 12-digit AWS account id"
  echo "  [dry-run] validate it is exactly 12 digits"
  echo "  [dry-run] store it as the repository secret AWS_ACCOUNT_ID in ${SLUG}"
  echo "  [dry-run] nothing written to disk"
  exit 0
fi

printf 'AWS account id (12 digits, input hidden): '
read -rs ACCOUNT_ID
printf '\n'

if [[ ! "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "That is not a 12-digit AWS account id." >&2
  exit 1
fi

printf '%s' "$ACCOUNT_ID" | gh secret set AWS_ACCOUNT_ID --repo "$SLUG"
unset ACCOUNT_ID

echo "Stored as the repository secret AWS_ACCOUNT_ID."
echo "Next: docs/hitl/SESSION-1.md step 7 (Expo)."
