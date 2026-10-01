#!/usr/bin/env bash
# Session 1, step 6: tell CI about the AWS account the bootstrap stack just created.
#
# One hidden prompt, for the 12-digit account id. Everything else is derived from it,
# because the role names are fixed by infra/bootstrap/template.ts and asking a human to
# retype four ARNs is four chances to paste the wrong one into the wrong environment.
# `infra/test/bootstrap.test.ts` asserts the names below still match the template.
#
# Nothing is written to disk and nothing is echoed. This repository is public and
# ADR-005 keeps account identifiers out of it entirely — an ARN contains the account id,
# which is why these go into environment secrets rather than a config file.
#
#   bash scripts/hitl/session1-finish.sh --dry-run
#   bash scripts/hitl/session1-finish.sh
set -euo pipefail

DRY_RUN=0
REPO_NAME="setlist"
PARTITION="aws"

usage() {
  cat <<'USAGE'
Usage: session1-finish.sh [--dry-run] [--repo NAME] [--partition aws|aws-us-gov|aws-cn]

Prompts once for the 12-digit AWS account id, then:
  * stores it as the repository secret AWS_ACCOUNT_ID
  * stores AWS_DEPLOY_ROLE in the dev, stage and prod environments
  * stores AWS_DIAGNOSTICS_ROLE in the diagnostics environment
  * sets the repository variable AWS_ENABLED=true, which un-gates the AWS workflows

Nothing is written to disk. Run with --dry-run first to see every call.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --repo)      REPO_NAME="${2:?--repo needs a value}"; shift 2 ;;
    --partition) PARTITION="${2:?--partition needs a value}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh is not installed." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

OWNER="$(gh api user --jq .login)"
SLUG="${OWNER}/${REPO_NAME}"

# Role names, fixed by infra/bootstrap/template.ts. Deploy roles are per environment;
# the GitHub environment name and the role suffix are the same string by design, since
# the trust policy matches on `environment:<name>`.
DEPLOY_ENVIRONMENTS=(dev stage prod)
DEPLOY_ROLE_PREFIX="setlist-deploy-"
DIAGNOSTICS_ROLE="setlist-diagnostics"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "  [dry-run] prompt (hidden) for the 12-digit AWS account id"
  echo "  [dry-run] validate it is exactly 12 digits"
  echo "  [dry-run] gh secret set AWS_ACCOUNT_ID --repo ${SLUG}"
  for env in "${DEPLOY_ENVIRONMENTS[@]}"; do
    echo "  [dry-run] gh secret set AWS_DEPLOY_ROLE --env ${env}" \
         "(arn:${PARTITION}:iam::<account>:role/${DEPLOY_ROLE_PREFIX}${env})"
  done
  echo "  [dry-run] gh secret set AWS_DIAGNOSTICS_ROLE --env diagnostics" \
       "(arn:${PARTITION}:iam::<account>:role/${DIAGNOSTICS_ROLE})"
  echo "  [dry-run] gh variable set AWS_ENABLED=true --repo ${SLUG}"
  echo "  [dry-run] nothing written to disk"
  exit 0
fi

printf 'AWS account id (12 digits, input hidden): '
read -rs ACCOUNT_ID
printf '\n'

if [[ ! "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  # Deliberately does not echo what was typed: a near-miss is still an account id.
  echo "That is not a 12-digit AWS account id." >&2
  exit 1
fi

# Verify the environments exist before writing anything into them. `gh secret set`
# against a missing environment fails per call, which would leave the repository
# half-configured and the error buried three screens up.
for env in "${DEPLOY_ENVIRONMENTS[@]}" diagnostics; do
  if ! gh api "repos/${SLUG}/environments/${env}" >/dev/null 2>&1; then
    echo "Environment '${env}' does not exist in ${SLUG}." >&2
    echo "Run scripts/hitl/github-setup.sh first — the deploy roles' trust policies" >&2
    echo "pin each role to its environment by name, so the names have to match." >&2
    exit 1
  fi
done

printf '%s' "$ACCOUNT_ID" | gh secret set AWS_ACCOUNT_ID --repo "$SLUG"
echo "  stored AWS_ACCOUNT_ID (repository)"

for env in "${DEPLOY_ENVIRONMENTS[@]}"; do
  printf 'arn:%s:iam::%s:role/%s%s' "$PARTITION" "$ACCOUNT_ID" "$DEPLOY_ROLE_PREFIX" "$env" \
    | gh secret set AWS_DEPLOY_ROLE --repo "$SLUG" --env "$env"
  echo "  stored AWS_DEPLOY_ROLE (environment ${env})"
done

printf 'arn:%s:iam::%s:role/%s' "$PARTITION" "$ACCOUNT_ID" "$DIAGNOSTICS_ROLE" \
  | gh secret set AWS_DIAGNOSTICS_ROLE --repo "$SLUG" --env diagnostics
echo "  stored AWS_DIAGNOSTICS_ROLE (environment diagnostics)"

unset ACCOUNT_ID

# Last, and only once everything above succeeded. This is the switch every AWS job is
# gated on, so flipping it before the secrets exist would turn a clean no-op into a run
# of red jobs.
gh variable set AWS_ENABLED --repo "$SLUG" --body 'true'
echo "  set AWS_ENABLED=true — the AWS workflows are now live"

cat <<EOF

Done. Nothing was written to disk.

Next: docs/hitl/SESSION-1.md step 7 (Expo).

Worth knowing: until now every AWS job no-opped because AWS_ENABLED was false. The
next push to develop will actually deploy dev and then stage.
EOF
