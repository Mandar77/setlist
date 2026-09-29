#!/usr/bin/env bash
# Store provider credentials as GitHub environment secrets.
#
# Values are read from hidden prompts only: never from argv (which lands in your shell
# history and in the process table) and never from a file. CI copies them into SSM
# SecureString; they are never committed and never pasted into the Claude chat.
#
#   bash scripts/hitl/set-provider-secrets.sh --dry-run google
#   bash scripts/hitl/set-provider-secrets.sh expo
#   bash scripts/hitl/set-provider-secrets.sh google
#   bash scripts/hitl/set-provider-secrets.sh spotify
set -euo pipefail

DRY_RUN=0
REPO_NAME="setlist"
PROVIDER=""

usage() {
  cat <<'USAGE'
Usage: set-provider-secrets.sh [--dry-run] [--repo NAME] <expo|google|spotify>

  expo     EXPO_TOKEN (repository scope)
  google   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, per environment
  spotify  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET, prod only
           (only if you hold an active Spotify Premium subscription)

Values are read from hidden prompts. Never pass a credential as an argument.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo)    REPO_NAME="${2:?--repo needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    expo|google|spotify) PROVIDER="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PROVIDER" ]] || { usage; exit 2; }

command -v gh >/dev/null || { echo "gh is not installed." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

OWNER="$(gh api user --jq .login)"
SLUG="${OWNER}/${REPO_NAME}"

# store_value NAME [ENVIRONMENT] - reads from a hidden prompt, never from argv.
store_value() {
  local name="$1" env="${2:-}" value
  local scope="repository"
  [[ -n "$env" ]] && scope="environment ${env}"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] prompt (hidden) for ${name}, store in ${scope} of ${SLUG}"
    return 0
  fi

  printf '%s (%s, input hidden, empty to skip): ' "$name" "$scope"
  read -rs value
  printf '\n'

  if [[ -z "$value" ]]; then
    echo "  skipped ${name}"
    return 0
  fi

  if [[ -n "$env" ]]; then
    printf '%s' "$value" | gh secret set "$name" --repo "$SLUG" --env "$env"
  else
    printf '%s' "$value" | gh secret set "$name" --repo "$SLUG"
  fi
  unset value
  echo "  stored ${name}"
}

case "$PROVIDER" in
  expo)
    echo "Expo access token (expo.dev -> Account settings -> Access tokens)"
    store_value EXPO_TOKEN
    ;;
  google)
    echo "Google OAuth clients - one per environment, from the Google Cloud console."
    echo "Use the redirect URIs printed in the latest deploy job summary, exactly."
    for env in dev stage prod; do
      store_value GOOGLE_CLIENT_ID "$env"
      store_value GOOGLE_CLIENT_SECRET "$env"
    done
    ;;
  spotify)
    cat <<'WARN'
Spotify dev mode requires the app OWNER to hold an active Premium subscription, and
caps the app at 5 users. If you do not have Premium, press Enter twice to skip: the
Spotify adapter stays unbuilt and nothing else is affected.
WARN
    store_value SPOTIFY_CLIENT_ID prod
    store_value SPOTIFY_CLIENT_SECRET prod
    ;;
esac

echo
echo "Done. CI copies these into SSM SecureString on the next deploy."
echo "Never paste a credential into the Claude chat."
