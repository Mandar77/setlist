#!/usr/bin/env bash
# Regression test for .claude/hooks/guard-bash.sh.
#
# The guard is the structural enforcement of ADR-005: no local AWS access, no deploys
# outside CI, no force pushes, no touching main, no secrets from an agent. A guard that
# silently stops matching is worse than no guard, because everyone assumes it is there.
#
# This lives in a script rather than in a shell one-liner for a practical reason: the
# test cases contain the very strings the guard blocks, so a command line containing
# them gets blocked before it can run. File contents are not inspected; command lines
# are.
#
#   bash tools/test-guard-hook.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${ROOT}/.claude/hooks/guard-bash.sh"

[[ -f "$GUARD" ]] || { echo "guard hook not found at ${GUARD}" >&2; exit 1; }

pass=0
fail=0

# verdict COMMAND -> prints BLOCK or ALLOW
verdict() {
  local cmd="$1" payload rc
  # Build the hook's JSON payload without depending on node being present.
  payload="$(CMD="$cmd" python -c 'import json,os,sys; sys.stdout.write(json.dumps({"tool_input":{"command":os.environ["CMD"]}}))')"
  set +e
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then echo ALLOW; else echo BLOCK; fi
}

check() {
  local expected="$1" cmd="$2" got
  got="$(verdict "$cmd")"
  if [[ "$got" == "$expected" ]]; then
    pass=$((pass + 1))
    printf '  ok   %-6s %s\n' "$got" "$cmd"
  else
    fail=$((fail + 1))
    printf '  FAIL expected %s, got %s: %s\n' "$expected" "$got" "$cmd" >&2
  fi
}

echo "guard-bash.sh regression test"
echo
echo "must BLOCK:"

# Direct AWS access - ADR-005 says AWS is reached only from CI via OIDC.
check BLOCK 'aws s3 ls'
check BLOCK 'aws sts get-caller-identity'
# Hidden behind a pipeline, a separator, or an env prefix.
check BLOCK 'echo hi && aws s3 ls'
check BLOCK 'ls; aws s3 ls'
check BLOCK '(aws s3 ls)'

# Deploys run only in CI.
check BLOCK 'cdk deploy --all'
check BLOCK 'npx cdk deploy --all'
check BLOCK 'cdk destroy'
check BLOCK 'sam deploy --guided'
check BLOCK 'make deploy ENV=prod'

# History and branch protection.
check BLOCK 'git push --force origin develop'
check BLOCK 'git push -f origin develop'
check BLOCK 'git push origin main'
check BLOCK 'git push origin HEAD:main'
check BLOCK 'git push origin master'

# Only the human merges, and only the human enters secrets.
check BLOCK 'gh pr merge 3'
check BLOCK 'gh pr merge --squash 12'
check BLOCK 'gh secret set EXAMPLE_TOKEN'
check BLOCK 'gh api --method DELETE repos/owner/name/branches'

echo
echo "must ALLOW:"

check ALLOW 'make verify'
check ALLOW 'make preflight ENV=dev'
check ALLOW 'git push origin task/prep-02-windows-hardening'
check ALLOW 'git push -u origin develop'
check ALLOW 'git commit -m "feat: add a thing"'
check ALLOW 'git status --short'
check ALLOW 'pnpm -C packages/core test'
check ALLOW 'python -m uv run pytest -q'
check ALLOW 'gh run list --branch develop --limit 1'
check ALLOW 'gh issue create --title "x" --label human-needed'
check ALLOW 'shellcheck scripts/hitl/github-setup.sh'

echo
echo "must FAIL CLOSED (the guard cannot read the command):"

# A guard that cannot see the command must block, not shrug. Without these, the guard
# could silently stop matching — no parser on PATH, a malformed payload, a different
# tool's payload shape — and every check would pass by default.
raw_verdict() {
  local payload="$1" rc
  set +e
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then echo ALLOW; else echo BLOCK; fi
}

check_raw() {
  local expected="$1" payload="$2" label="$3" got
  got="$(raw_verdict "$payload")"
  if [[ "$got" == "$expected" ]]; then
    pass=$((pass + 1))
    printf '  ok   %-6s %s\n' "$got" "$label"
  else
    fail=$((fail + 1))
    printf '  FAIL expected %s, got %s: %s\n' "$expected" "$got" "$label" >&2
  fi
}

check_raw BLOCK ''                          'empty payload'
check_raw BLOCK '   '                       'whitespace-only payload'
check_raw BLOCK 'not json at all'           'unparseable payload'
check_raw BLOCK '{}'                        'payload with no tool_input'
check_raw BLOCK '{"tool_input":{}}'         'tool_input with no command'
check_raw BLOCK '{"tool_input":{"command":""}}' 'empty command string'

echo
if [[ $fail -gt 0 ]]; then
  echo "guard hook test: ${pass} passed, ${fail} FAILED" >&2
  exit 1
fi
echo "guard hook test: ${pass} passed, 0 failed"
