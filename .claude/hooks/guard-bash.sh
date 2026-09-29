#!/usr/bin/env bash
# Autopilot guard for the Bash tool (PreToolUse). Exit 2 blocks; stderr goes to Claude.
input="$(cat)"
if command -v node >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).tool_input||{}).command||""))}catch(e){}})')"
else
  cmd="$(printf '%s' "$input" | python3 -c 'import json,sys
try: sys.stdout.write(str(json.load(sys.stdin).get("tool_input",{}).get("command","")))
except Exception: pass')"
fi

block() { echo "Blocked by the autopilot guard: $1. See docs/plan/AUTOPILOT.md, ADR-005." >&2; exit 2; }
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
