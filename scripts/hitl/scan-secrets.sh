#!/usr/bin/env bash
# Full-history secret scan. The gate that runs before this repository is ever pushed.
#
#   bash scripts/hitl/scan-secrets.sh              # scan; non-zero if anything is found
#   bash scripts/hitl/scan-secrets.sh --dry-run    # say what it would do, run nothing
#
# github-setup.sh calls this before its first push and aborts if it fails. You can also
# run it on demand — before a force-push, after a history rewrite, or whenever you are
# about to make something public.
#
# WHY EACH DECISION, all verified empirically against 2MS v5.4.0:
#
#   * Two scans, not one. `git` walks full history but consumes `git log -p`, which
#     emits no diff for merge commits — a secret introduced in a conflict resolution is
#     invisible to it. A tree scan sees that content but knows nothing about history.
#     Each misses what the other catches.
#   * The tree scan runs against a pristine `git archive` export of HEAD, not against
#     the working directory. Scanning the working directory means scanning .venv,
#     node_modules and .cache — which produces false positives from third-party code
#     (a list of PHP function names in pygments trips the generic-api-key rule) and
#     trains everyone to ignore the gate. HEAD is also exactly what a push publishes:
#     untracked files are not pushed, so they are not this gate's business.
#   * `--all-branches` is not optional. Without it only HEAD's ancestry is walked, so a
#     secret on another branch scans clean while remaining perfectly pushable.
#   * `--ignore-on-exit none` is the default, but passing it EXPLICITLY is what stops an
#     inherited 2MS_IGNORE_ON_EXIT=all from silently neutralising the gate.
#   * Test non-zero, never `-eq 2`. 2MS sums its error code (1) and results code (2), so
#     a gate keyed on 2 passes on exit 3 — and on every error path, including
#     binary-not-found (127). Those are exactly the moments a gate must not pass.
#   * A shallow clone scans clean even with a secret in history. Unscannable is not the
#     same as clean, so the gate refuses rather than reporting success.
set -euo pipefail

DRY_RUN=0
TWOMS_VERSION="v5.4.0"
# The Docker :latest tag lags the releases badly, so the native binary is the primary
# route and Docker is a pinned fallback.
TWOMS_DOCKER_TAG="checkmarx/2ms:v5.4.0"

usage() {
  cat <<'USAGE'
Usage: scan-secrets.sh [--dry-run]

Scans full git history AND the working tree for secrets, using Checkmarx 2MS.
Exits non-zero if anything is found, or if the scan could not be run at all.

Environment:
  SETLIST_2MS_BIN   Path to an existing 2ms binary, preferred over downloading.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Version-scoped on purpose. With a flat cache, bumping TWOMS_VERSION would silently
# keep using the previously downloaded binary — the cache would hit, the download and
# its checksum check would never run, and the pin in this file would be a comment
# rather than a fact.
CACHE_DIR="${ROOT}/.cache/2ms/${TWOMS_VERSION}"

# SHA-256 of each v5.4.0 release asset.
#
# Checkmarx publishes no checksums, SBOM or signatures for these assets, so there is
# nothing upstream to verify against. These digests were established by downloading
# each asset once, on 2026-09-29, and recording what arrived — trust-on-first-use, and
# worth naming as such rather than dressing up as provenance.
#
# What they do buy: this script downloads and then EXECUTES a 13 MB binary, so without
# a pin the gate would run whatever the URL served today. With it, a changed asset stops
# the gate instead of silently running something new.
#
# To rotate: bump TWOMS_VERSION, download each asset, `sha256sum` it, update this table,
# and say in the commit message that you did the download yourself.
twoms_sha256() {
  case "$1" in
    linux-amd64)   echo 5c8a94a53cd6f811b85e19f7d2ceae555355813e954b6ae5697d579ba92319dc ;;
    linux-arm64)   echo f6e05ef1406181354d08e8732f18dd6d43928d4a5d0c47a9451e0ef92e766580 ;;
    macos-amd64)   echo 86bbba33a73bc89ce12c9f2069e9a54a3556cc0d74b4cc1c7bd30c1d837beb3f ;;
    macos-arm64)   echo d28b713f10a93fdb986860f5904b4cbacf033619d4e7e5930a857b88be2a81da ;;
    windows-amd64) echo a9edd9934e84e5f4b34be68adaa825c6480d35cafc75791958c95db4b4880295 ;;
    *)             return 1 ;;
  esac
}

die() { printf '\nSECRET SCAN FAILED: %s\n' "$1" >&2; exit 1; }

# Maps this machine to a release asset basename. Assets are named by platform with no
# version string: linux-amd64.zip, windows-amd64.zip, macos-arm64.zip, ...
twoms_asset() {
  local os arch
  case "$(uname -s)" in
    Linux)                os=linux ;;
    Darwin)               os=macos ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *)                    return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *)             return 1 ;;
  esac
  # Only linux and macos publish arm64; windows publishes amd64 only.
  if [[ "$os" == "windows" && "$arch" != "amd64" ]]; then return 1; fi
  printf '%s-%s' "$os" "$arch"
}

twoms_download() {
  local asset url zip bin
  asset="$(twoms_asset)" || return 1
  url="https://github.com/Checkmarx/2ms/releases/download/${TWOMS_VERSION}/${asset}.zip"
  zip="${CACHE_DIR}/${asset}.zip"
  bin="${CACHE_DIR}/2ms"
  if [[ "$asset" == windows-* ]]; then bin="${CACHE_DIR}/2ms.exe"; fi

  mkdir -p "$CACHE_DIR"
  echo "  downloading ${url}" >&2

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$zip" "$url" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$zip" "$url" || return 1
  else
    return 1
  fi

  # Verify before unzipping, and certainly before executing. A mismatch is not a
  # warning: this script is about to run whatever came down that wire.
  local want got
  want="$(twoms_sha256 "$asset")" || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$zip" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
  else
    echo "  cannot verify the download: no sha256sum or shasum on PATH" >&2
    rm -f "$zip"
    return 1
  fi
  if [[ "$got" != "$want" ]]; then
    rm -f "$zip"
    {
      echo "  CHECKSUM MISMATCH for ${asset}.zip"
      echo "    expected ${want}"
      echo "    actual   ${got}"
      echo "  Refusing to unzip or execute it. Either the release was re-cut, or"
      echo "  something is wrong. Verify upstream before touching the pinned digest."
    } >&2
    return 1
  fi
  echo "  checksum verified (${TWOMS_VERSION} ${asset})" >&2

  command -v unzip >/dev/null 2>&1 || return 1
  unzip -oq "$zip" -d "$CACHE_DIR" || return 1
  chmod +x "$bin" 2>/dev/null || true
  [[ -x "$bin" ]] || return 1
  printf '%s' "$bin"
}

# Echoes a path to a binary, or the literal string "docker".
twoms_resolve() {
  if [[ -n "${SETLIST_2MS_BIN:-}" && -x "${SETLIST_2MS_BIN}" ]]; then
    printf '%s' "${SETLIST_2MS_BIN}"; return 0
  fi
  if command -v 2ms >/dev/null 2>&1; then
    command -v 2ms; return 0
  fi
  local cached
  for cached in "${CACHE_DIR}/2ms" "${CACHE_DIR}/2ms.exe"; do
    if [[ -x "$cached" ]]; then printf '%s' "$cached"; return 0; fi
  done
  if twoms_download; then return 0; fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    printf 'docker'; return 0
  fi
  return 1
}

if [[ $DRY_RUN -eq 1 ]]; then
  cat <<EOF
Secret scan (dry run) — nothing was executed.

  resolve a 2ms binary, in order:
    \$SETLIST_2MS_BIN -> PATH -> ${CACHE_DIR}
    -> download ${TWOMS_VERSION} from GitHub releases -> Docker ${TWOMS_DOCKER_TAG}
  refuse if none of those work (fail closed — an unscanned repo is not a clean one)

  assert the repository is not a shallow clone
  unset every 2MS_* / 2ms_* environment variable

  2ms git "${ROOT}" --all-branches --ignore-on-exit none
  git archive HEAD | tar -x -C <tmp>   # pristine export of tracked files only
  2ms filesystem --path <tmp> --ignore-on-exit none

  exit non-zero on ANY non-zero result from either scan
EOF
  exit 0
fi

echo "Secret scan: full history + working tree"

# A shallow clone has no history to scan, and 2MS reports a clean exit 0 on one.
if [[ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" != "false" ]]; then
  die "this is a shallow clone, so history cannot be scanned. Run: git fetch --unshallow"
fi

# Commit identities, before the content scans. 2MS reads diff content and never looks
# at author/committer headers, so without this the address git stamps on every commit
# is the one piece of personal data in the repository that nothing checks — while the
# gate prints "clean". It is also the only finding here that cannot be fixed after a
# push, which is why it runs first.
if command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python || command -v python3)"
  if ! "$PY" "${ROOT}/tools/check_no_secrets.py" --history; then
    die "see above. Nothing was pushed."
  fi
else
  die "python is required to check commit identities and repository content."
fi

# 2MS binds 2MS_*-prefixed environment variables automatically (viper AutomaticEnv), and
# several of them — 2MS_IGNORE_ON_EXIT, 2MS_IGNORE_RULE, 2MS_ALLOWED_VALUES,
# 2MS_MAX_SECRET_SIZE — turn a finding into a clean exit with no output whatsoever.
#
# `unset` cannot remove these: a name starting with a digit is not a valid shell
# identifier, so `unset 2MS_IGNORE_ON_EXIT` is a silent no-op while the variable stays
# in the environment the child inherits. `env -u` removes them by name regardless, so
# the scan runs with them stripped rather than merely wished away.
SCRUB=()
while read -r stale; do
  if [[ -n "$stale" ]]; then SCRUB+=(-u "$stale"); fi
done < <(env | sed -n 's/^\(2[Mm][Ss][A-Za-z0-9_]*\)=.*/\1/p' | sort -u)

if [[ ${#SCRUB[@]} -gt 0 ]]; then
  echo "  stripping ${#SCRUB[@]} inherited 2MS_* variable(s) that could suppress findings"
fi

if ! BIN="$(twoms_resolve)"; then
  die "2MS could not be found, downloaded, or run via Docker.

  The scan is not optional: this repository is public and git history is permanent.
  Install 2MS one of these ways, then re-run:

    brew install 2ms
    download ${TWOMS_VERSION} from https://github.com/Checkmarx/2ms/releases
    start Docker (the script will then use ${TWOMS_DOCKER_TAG})

  Or point SETLIST_2MS_BIN at an existing binary."
fi

# Pristine export of HEAD: exactly the tracked content a push would publish, with no
# .venv, node_modules or .cache to generate third-party false positives.
EXPORT_DIR="$(mktemp -d)"
cleanup() { rm -rf "$EXPORT_DIR"; }
trap cleanup EXIT

if ! git -C "$ROOT" archive HEAD | tar -x -C "$EXPORT_DIR"; then
  die "could not export HEAD for the tree scan (git archive or tar failed)."
fi

rc=0
if [[ "$BIN" == "docker" ]]; then
  echo "  scanner: Docker ${TWOMS_DOCKER_TAG}"
  docker run --rm -v "${ROOT}:/repo" "$TWOMS_DOCKER_TAG" \
    git /repo --all-branches --ignore-on-exit none || rc=$?
  if [[ $rc -eq 0 ]]; then
    docker run --rm -v "${EXPORT_DIR}:/tree" "$TWOMS_DOCKER_TAG" \
      filesystem --path /tree --ignore-on-exit none || rc=$?
  fi
else
  echo "  scanner: ${BIN} ($("$BIN" --version 2>/dev/null || echo 'version unknown'))"
  env "${SCRUB[@]}" "$BIN" git "$ROOT" --all-branches --ignore-on-exit none || rc=$?
  if [[ $rc -eq 0 ]]; then
    env "${SCRUB[@]}" "$BIN" filesystem --path "$EXPORT_DIR" --ignore-on-exit none || rc=$?
  fi
fi

if [[ $rc -ne 0 ]]; then
  die "2MS exited ${rc}.

  Exit 1 means the scan itself failed — fix that and re-run; an unscanned repo is not
  a clean one. Exit 2 means it found something.

  If it found a secret: rotate it first and treat it as compromised, then remove it
  from history (git filter-repo) before pushing. Deleting the file in a later commit
  does NOT remove it from history, and this repository is public."
fi

echo "  clean: no secrets in history or in the working tree"
