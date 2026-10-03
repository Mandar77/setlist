#!/usr/bin/env bash
# Prove scripts/ci/dependabot-disarm.sh actually disarms, against a stubbed `gh`.
#
#   bash tools/test-dependabot-disarm.sh
#
# The failure this guards against is specific and has happened: on 2026-10-03 a
# TypeScript major merged itself into develop because the auto-merge workflow could only
# ever ARM auto-merge. It re-ran when Dependabot rewrote the PR, correctly read
# `semver-major`, and correctly skipped the arming step — and the arming from when the PR
# was a patch was still live, because declining to arm does not disarm.
#
# "The step exists" is not the property that matters; "the step calls the API" is. A stub
# `gh` on PATH records what it was asked to do, so these assertions are about behaviour
# rather than about the presence of a line in a YAML file.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
script="$repo_root/scripts/ci/dependabot-disarm.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0

ok() {
  passed=$((passed + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  failed=$((failed + 1))
  printf '  FAIL %s\n' "$1" >&2
}

# A stub `gh` that reports whatever auto-merge state the test asked for, and logs every
# invocation so the assertions can look at what was actually called.
make_gh() {
  local armed="$1"
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$tmp/calls.log"
if [ "\$1" = 'pr' ] && [ "\$2" = 'view' ]; then
  printf '%s' '$armed'
  exit 0
fi
if [ "\$1" = 'pr' ] && [ "\$2" = 'merge' ]; then
  exit 0
fi
exit 0
STUB
  chmod +x "$tmp/bin/gh"
  : >"$tmp/calls.log"
}

run() {
  PATH="$tmp/bin:$PATH" bash "$script" "$@"
}

printf 'dependabot-disarm: behaviour against a stubbed gh\n\n'

# 1. Armed major -> must call `gh pr merge --disable-auto`.
make_gh '{"enabledAt":"2026-10-03T00:00:00Z"}'
if run https://example.invalid/pr/1 version-update:semver-major >/dev/null 2>&1; then
  if grep -q -- '--disable-auto' "$tmp/calls.log"; then
    ok 'armed major: calls gh pr merge --disable-auto'
  else
    bad 'armed major: did NOT call --disable-auto (this is the 2026-10-03 bug)'
  fi
else
  bad 'armed major: script exited non-zero'
fi

# 2. Not armed -> must NOT call merge at all. Calling `--disable-auto` on a PR that was
#    never armed is an error, and swallowing it is how a real failure gets hidden.
make_gh ''
if run https://example.invalid/pr/2 version-update:semver-major >/dev/null 2>&1; then
  if grep -q -- '--disable-auto' "$tmp/calls.log"; then
    bad 'unarmed: called --disable-auto anyway'
  else
    ok 'unarmed: does not call merge'
  fi
else
  bad 'unarmed: script exited non-zero'
fi

# 3. An unclassified update type is not safe, so it disarms too.
make_gh '{"enabledAt":"2026-10-03T00:00:00Z"}'
if run https://example.invalid/pr/3 unknown >/dev/null 2>&1; then
  if grep -q -- '--disable-auto' "$tmp/calls.log"; then
    ok 'unclassified: disarms, same as a major'
  else
    bad 'unclassified: left armed'
  fi
else
  bad 'unclassified: script exited non-zero'
fi

# 4. A patch must be refused outright. If the caller's condition and this script's ever
#    disagree, that must be loud rather than a silent disarm of something safe.
make_gh '{"enabledAt":"2026-10-03T00:00:00Z"}'
if run https://example.invalid/pr/4 version-update:semver-patch >/dev/null 2>&1; then
  bad 'patch: should have refused, but exited 0'
else
  if grep -q -- '--disable-auto' "$tmp/calls.log"; then
    bad 'patch: refused but still disarmed'
  else
    ok 'patch: refused, and disarmed nothing'
  fi
fi

# 5. A failing API call must fail the script. Fail-closed, like every other gate here.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<STUB
#!/usr/bin/env bash
if [ "\$1" = 'pr' ] && [ "\$2" = 'view' ]; then
  printf '%s' '{"enabledAt":"x"}'
  exit 0
fi
exit 1
STUB
chmod +x "$tmp/bin/gh"
if run https://example.invalid/pr/5 version-update:semver-major >/dev/null 2>&1; then
  bad 'api failure: exited 0, so a failed disarm would pass silently'
else
  ok 'api failure: exits non-zero'
fi

printf '\ndependabot-disarm test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
