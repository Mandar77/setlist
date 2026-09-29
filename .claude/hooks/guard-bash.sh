#!/usr/bin/env bash
# Autopilot guard for the Bash tool (PreToolUse). Exit 2 blocks; stderr goes to Claude.
#
# This enforces ADR-005: no local AWS access, no deploys outside CI, no force pushes,
# nothing touching main, no agent-entered secrets.
#
# It FAILS CLOSED. If the command string cannot be extracted — no JSON parser on PATH,
# malformed payload, empty result from a non-empty input — the command is blocked rather
# than allowed. A guard that silently stops matching is worse than no guard, because
# everyone keeps assuming it is there.
#
# Covered by tools/test-guard-hook.sh, which runs in `make verify` and in CI.
set -uo pipefail

block() { echo "Blocked by the autopilot guard: $1. See docs/plan/AUTOPILOT.md, ADR-005." >&2; exit 2; }

input="$(cat)"

# An empty payload is not a safe command to run — it is a broken hook contract.
if [[ -z "${input//[[:space:]]/}" ]]; then
  block "the hook received an empty payload, so the command could not be checked"
fi

extract_with_node() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).tool_input||{}).command||""))}catch(e){process.exit(1)}})'
}

extract_with_python() {
  "$1" -c 'import json,sys
try:
    sys.stdout.write(str(json.load(sys.stdin).get("tool_input",{}).get("command","")))
except Exception:
    sys.exit(1)'
}

cmd=""
extracted=0
if command -v node >/dev/null 2>&1; then
  if cmd="$(printf '%s' "$input" | extract_with_node)"; then extracted=1; fi
fi
if [[ $extracted -eq 0 ]]; then
  for py in python3 python py; do
    if command -v "$py" >/dev/null 2>&1; then
      if cmd="$(printf '%s' "$input" | extract_with_python "$py")"; then extracted=1; break; fi
    fi
  done
fi

if [[ $extracted -eq 0 ]]; then
  block "no working JSON parser (node or python) was available to read the command"
fi

# A payload that parsed but yielded nothing is either a different tool's shape or a
# malformed one. Either way the guard has not seen a command, so it cannot clear it.
if [[ -z "$cmd" ]]; then
  block "the command could not be read from the hook payload"
fi

check() { if [[ $cmd =~ $1 ]]; then block "$2"; fi; }

sep='(^|[;&|(`]|\$\()[[:space:]]*'
push='git([[:space:]]+-[cC][[:space:]]+[^[:space:]]+)*[[:space:]]+push'

check "${sep}aws[[:space:]]"                                        "AWS is reached only from CI through OIDC"
check '(cdk|sam)[[:space:]]+(deploy|destroy)'                      "deploys run only in CI"
check "${sep}make[[:space:]][^;&|]*(deploy|destroy)"                "deploys run only in CI"
check "${push}[^;&|]*[[:space:]](-f|--force|\+)"                    "no force pushes"
check "${push}[^;&|]*[[:space:]:](main|master)([[:space:]]|\$)"     "only the human changes main"
check 'gh[[:space:]]+pr[[:space:]]+merge'                           "only the human merges pull requests"
check 'gh[[:space:]]+secret'                                        "secrets are entered only by the human"
check 'gh[[:space:]]+api[^;&|]*(-X|--method)[[:space:]]*DELETE'     "no destructive GitHub API calls"
exit 0
