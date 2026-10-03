#!/usr/bin/env bash
# Disarm auto-merge on a pull request, if it is armed.
#
#   scripts/ci/dependabot-disarm.sh <pr-url> <update-type>
#
# Extracted from .github/workflows/dependabot-auto-merge.yml so it can be tested. A
# workflow step is unreachable from a test runner, and this is the step whose absence let
# a TypeScript major merge itself into develop on 2026-10-03: the workflow could ARM
# auto-merge and had no way to take it back, so a PR opened as a patch kept its arming
# when Dependabot rewrote it into a major.
#
# Declining to arm is not the same as disarming. That sentence is the whole reason this
# file exists, and `tools/test-dependabot-disarm.sh` is what proves it still holds.
#
# Exit status is 0 whenever the PR ends up not armed — whether this disarmed it or it was
# never armed. A non-zero exit means the API call itself failed, which is worth failing
# the job over: silently failing to disarm is the original bug wearing a different hat.
set -euo pipefail

PR_URL="${1:?usage: dependabot-disarm.sh <pr-url> <update-type>}"
UPDATE_TYPE="${2:?usage: dependabot-disarm.sh <pr-url> <update-type>}"

case "$UPDATE_TYPE" in
  version-update:semver-patch | version-update:semver-minor)
    # Safe to leave armed. This script is only invoked for the other cases, so reaching
    # here means the caller's condition and this one disagree — which is worth saying out
    # loud rather than quietly doing nothing.
    printf 'refusing to disarm a %s: the caller should not have invoked this\n' "$UPDATE_TYPE" >&2
    exit 2
    ;;
esac

# Query before disabling. `gh pr merge --disable-auto` errors when auto-merge was never
# armed, and the tempting `|| true` would swallow a genuine API failure alongside the
# expected one.
armed="$(gh pr view "$PR_URL" --json autoMergeRequest -q '.autoMergeRequest // empty')"

if [ -n "$armed" ]; then
  gh pr merge --disable-auto "$PR_URL"
  printf 'auto-merge was armed on a %s — disarmed\n' "$UPDATE_TYPE"
else
  printf 'auto-merge not armed on this %s; nothing to disarm\n' "$UPDATE_TYPE"
fi
