#!/usr/bin/env bash
# Session 1, step 2: prepare the GitHub repository.
#
# Runs a full-history secret scan FIRST, then adopts or creates the repository, pushes
# main and develop, and applies rulesets, environments, labels and Actions settings.
#
# The scan runs before anything else on purpose: it is the only step whose failure must
# stop the session, and finding out after forty minutes of setup is no use to anyone.
#
# Run this in an ordinary terminal, not in the Claude chat.
#
#   bash scripts/hitl/github-setup.sh --dry-run    # print every call, change nothing
#   bash scripts/hitl/github-setup.sh
set -euo pipefail

DRY_RUN=0
REPO_NAME="setlist"
SKIP_SCAN=0
SKIP_MAIN_PUSH=0

# The scanner itself — version pinning, resolution and invocation — lives in
# scripts/hitl/scan-secrets.sh.

usage() {
  cat <<'USAGE'
Usage: github-setup.sh [--dry-run] [--repo NAME] [--skip-main-push] [--skip-scan-I-ACCEPT-THE-RISK]

  --dry-run   Print every command without executing it.
  --repo      Repository name (default: setlist).

  --skip-main-push
              Push develop only. ADR-005 reserves every write to main for you, and
              Claude Code runs under a guard that blocks pushing it, so the agent
              uses this. main arrives with your first release merge.

  --skip-scan-I-ACCEPT-THE-RISK
              Push without the secret scan. Named to be hard to type by accident.
              This repository is public; anything pushed is public permanently, and
              git history is not cleaned by deleting a file later.

Environment:
  SETLIST_2MS_BIN   Path to an existing 2ms binary, used in preference to downloading.

Requires: gh (authenticated), git, and either a 2ms binary or Docker.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo)    REPO_NAME="${2:?--repo needs a value}"; shift 2 ;;
    --skip-main-push) SKIP_MAIN_PUSH=1; shift ;;
    --skip-scan-I-ACCEPT-THE-RISK) SKIP_SCAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCAN="${ROOT}/scripts/hitl/scan-secrets.sh"

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

run_api() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] gh api %s\n' "$*"
  else
    gh api "$@" >/dev/null
  fi
}

note() { printf '\n==> %s\n' "$1"; }
warn() { printf 'WARNING: %s\n' "$1" >&2; }
die()  { printf '\nREFUSING TO PUSH: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- secret gate

# The scan lives in its own script so it can be run on demand — before a force-push,
# after a history rewrite, or any time you are about to make something public — and so
# it can be tested without triggering a push.
scan_secrets() {
  note "Secret scan (2MS, full history) — before anything is pushed"

  if [[ $SKIP_SCAN -eq 1 ]]; then
    warn "scan SKIPPED by explicit flag. This repository is public and history is permanent."
    return 0
  fi

  # -r, not -x: the file is tracked at mode 0644 and is invoked with `bash` below, so
  # requiring the execute bit would abort the session on a fresh clone — and the next
  # thing the usage text offers is --skip-scan, which is the opposite of helpful.
  [[ -r "$SCAN" ]] || die "${SCAN} is missing or unreadable."

  if [[ $DRY_RUN -eq 1 ]]; then
    bash "$SCAN" --dry-run
    return 0
  fi

  # Fails closed: a non-zero exit here aborts the whole session before the first push,
  # whether that is because secrets were found or because the scan could not run.
  bash "$SCAN" || die "the secret scan did not pass. Nothing was pushed."
}

# ---------------------------------------------------------------- preflight

command -v gh  >/dev/null || { echo "gh is not installed. See docs/hitl/SESSION-1.md" >&2; exit 1; }
command -v git >/dev/null || { echo "git is not installed." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

scan_secrets

OWNER="$(gh api user --jq .login)"
SLUG="${OWNER}/${REPO_NAME}"
note "Target repository: ${SLUG}"

# ---------------------------------------------------------------- 1. repository
if gh repo view "$SLUG" >/dev/null 2>&1; then
  VISIBILITY="$(gh repo view "$SLUG" --json visibility --jq .visibility)"
  note "Repository exists (${VISIBILITY}); adopting it."
  if [[ "$VISIBILITY" != "PUBLIC" ]]; then
    warn "Repository is ${VISIBILITY}. The plan assumes public, so that GitHub Actions"
    warn "and the security features are free. Change it in the web UI if you want that."
  fi
else
  note "Creating public repository ${SLUG}"
  run gh repo create "$SLUG" --public \
    --description "Turn a photo or a pasted list of songs into a playlist. Serverless, \$0/month."
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  run git remote add origin "https://github.com/${SLUG}.git"
fi

# ---------------------------------------------------------------- 2. push
# `main` is deliberately separable. ADR-005 reserves every write to main for the human,
# and Claude Code runs under a guard that blocks `git push ... main` outright — so when
# the agent does the initial push, this script has to be able to do everything else
# without it. `main` then arrives the first time the human merges a release PR.
#
# Running it yourself, leave the flag off and both branches go up.
if [[ $SKIP_MAIN_PUSH -eq 1 ]]; then
  note "Pushing develop (skipping main, as asked)"
else
  note "Pushing main and develop"
  run git push -u origin main
fi
run git push -u origin develop

note "Setting the default branch to develop"
# Claude Code works on develop; main is the release branch the human merges into.
run gh repo edit "$SLUG" --default-branch develop

# ---------------------------------------------------------------- 3. rulesets
note "Adding branch rulesets"

# JSON on stdin, not repeated `-f` flags. `rules` is an array of objects, and
# `-f 'rules[][type]=pull_request'` repeated does not build one -- gh collapses the
# repeats and the API answers 422 with no indication of which field it disliked.
#
# Idempotent: a ruleset of the same name already present is updated rather than
# duplicated, so re-running this script does not leave two of everything.
add_ruleset() {
  local name="$1" body="$2" existing
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] create or update ruleset %s on %s\n' "$name" "$SLUG"
    return 0
  fi

  existing="$(gh api "repos/${SLUG}/rulesets" --jq \
    ".[] | select(.name == \"${name}\") | .id" 2>/dev/null || true)"

  if [[ -n "$existing" ]]; then
    printf '%s' "$body" | gh api --method PUT "repos/${SLUG}/rulesets/${existing}" --input - >/dev/null
    printf '  updated ruleset %s\n' "$name"
  else
    printf '%s' "$body" | gh api --method POST "repos/${SLUG}/rulesets" --input - >/dev/null
    printf '  created ruleset %s\n' "$name"
  fi
}

# main: pull request required, no force pushes, no deletion.
add_ruleset protect-main '{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
  "rules": [{"type": "pull_request"}, {"type": "non_fast_forward"}, {"type": "deletion"}]
}'

# develop: no force pushes, no deletion, and every CI job must have passed on the commit.
#
# Still no pull-request requirement. Claude Code fast-forwards develop constantly
# (ADR-005), and requiring a PR here would stop the autopilot loop dead.
#
# `required_status_checks` is the ADR-011 addition, and it is the rule that needed the
# most care, because a ruleset's required checks apply to DIRECT PUSHES as well as to
# pull requests. The normal flow is: push task/*, CI runs there, fast-forward develop.
# That works precisely because required checks are evaluated against the COMMIT, and the
# commit already carries its green checks from the task branch — nothing re-runs, and
# nothing blocks. What would break it is requiring a check that never runs on a task
# branch at all, since "required but absent" blocks the push. That is why
# `Dependabot auto-merge policy` also triggers on push: it reports success immediately
# when there is nothing to police, so the check exists on every commit that could reach
# develop.
#
# `strict_required_status_checks_policy` is false on purpose. Strict means "the branch
# must be up to date with the base before merging", which for a fast-forward flow would
# demand a rebase-and-rerun cycle for every push that lost a race.
add_ruleset protect-develop '{
  "name": "protect-develop",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/heads/develop"], "exclude": []}},
  "rules": [
    {"type": "non_fast_forward"},
    {"type": "deletion"},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "do_not_enforce_on_create": true,
      "required_status_checks": [
        {"context": "make verify"},
        {"context": "cdk synth (6 combinations, offline)"},
        {"context": "Extraction accuracy gate"},
        {"context": "Secret scanning (2MS)"},
        {"context": "CodeQL (python)"},
        {"context": "CodeQL (javascript-typescript)"},
        {"context": "Dependency scan"},
        {"context": "Lockfiles resolve under the supply-chain policies"},
        {"context": "Semgrep"},
        {"context": "Trivy"},
        {"context": "Ledger, suppressions, secrets, shell"},
        {"context": "Zero-cost guardrails (cdk-nag + KICS)"},
        {"context": "Engine conformance (Node + Chromium)"},
        {"context": "OCR golden images (M2-01)"},
        {"context": "ETL against DynamoDB Local"},
        {"context": "Dependabot auto-merge policy"}
      ]
    }}
  ]
}'

# ---------------------------------------------------------------- 4. environments
# These names are not cosmetic. The bootstrap template pins each deploy role's trust
# policy to `repo:<owner>/<repo>:environment:<name>` with StringEquals, so a missing or
# misspelled environment means the role simply cannot be assumed — and the failure
# surfaces as an opaque STS error in CI, not as "you forgot an environment".
#
# `diagnostics` is one of them. ADR-005 forbids local AWS credentials, so the read-only
# diagnostics workflow is the only way to look at deployed state; without this
# environment it has nothing to assume.
note "Creating environments"
for env in dev stage diagnostics; do
  run_api --method PUT "repos/${SLUG}/environments/${env}"
done

# prod: restricted to main, and requires the owner's review before any deploy.
OWNER_ID="$(gh api user --jq .id)"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '  [dry-run] gh api --method PUT repos/%s/environments/prod (reviewer=%s, main only)\n' \
    "$SLUG" "$OWNER"
else
  gh api --method PUT "repos/${SLUG}/environments/prod" \
    --input - >/dev/null <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [{"type": "User", "id": ${OWNER_ID}}],
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
JSON
  gh api --method POST "repos/${SLUG}/environments/prod/deployment-branch-policies" \
    -f name='main' -f type='branch' >/dev/null
fi

# ------------------------------------------------- 4b. the AWS gate, explicitly off
# Every workflow that touches AWS is gated on `vars.AWS_ENABLED == 'true'`, so until
# the bootstrap stack exists they no-op instead of failing. Setting it to `false` here
# rather than leaving it absent is deliberate: an absent variable and a disabled one
# behave identically, and the difference matters the day someone asks why nothing
# deployed. `session1-finish.sh` flips it once the roles exist.
note "Setting AWS_ENABLED=false until the bootstrap stack exists"
run_api --method POST "repos/${SLUG}/actions/variables" \
  -f name='AWS_ENABLED' -f value='false'

# ---------------------------------------------------------------- 5. labels
note "Adding labels"
add_label() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] gh label create %s\n' "$1"
  else
    gh label create "$1" --color "$2" --description "$3" --force >/dev/null
  fi
}
add_label human-needed  D93F0B "Blocked on a human step; see docs/hitl/"
add_label autopilot     0E8A16 "Opened or driven by the autopilot loop"
add_label quarantine    FBCA04 "Flaky test, quarantined with an expiry"
add_label cost          B60205 "Touches the \$0 guarantee"

# ---------------------------------------------------------------- 6. settings
note "Applying repository settings"
run gh repo edit "$SLUG" \
  --enable-issues --enable-merge-commit=false --enable-rebase-merge=false \
  --enable-squash-merge --delete-branch-on-merge

# Dependabot auto-merge targets develop; see .github/dependabot.yml.
run_api --method PUT "repos/${SLUG}/vulnerability-alerts"
run_api --method PUT "repos/${SLUG}/automated-security-fixes"

note "Done."
cat <<EOF

Next:
  1. Restart Claude Code. Auto mode does not trust a remote added mid-session.
  2. Continue with docs/hitl/SESSION-1.md step 3 (AWS account).

Not done here, on purpose:
  - No secrets were set. Those come from set-provider-secrets.sh, which reads them
    from hidden prompts.
  - Secret scanning push protection is on by default for public repositories; the
    2MS scan above is the layer that runs before GitHub ever sees the history.
EOF
