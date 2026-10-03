# ADR-011 — Dependency policy: required checks, no surprise majors, cached lockfile ages

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decided by:** the human
- **Context:** the 2026-10-01 Dependabot outage and the TypeScript 6 auto-merge that followed it
- **Related:** [ADR-005](0005-credentials-branches-deploys.md) (branches and who merges)

## Context

Two failures on 2026-10-01 to 10-03, from one root.

The lockfile pinned `rolldown` 1.2.12 one day after publication, against a seven-day
`minimumReleaseAge`. That setting binds at resolution time and has no opinion about a
lockfile that already exists, so every `--frozen-lockfile` install replayed the immature
pin and stayed green. Dependabot, whose update preserves existing resolutions, died on
every npm run for two days. Dependency automation had stopped and the only signal was in
a bot's logs.

The `resolvable` CI job existed for exactly this and was green throughout, because it
deletes the lockfile before resolving. That proves a compliant lockfile *could* be
produced; it cannot prove the committed one is compliant. `tools/check_lockfile_maturity.js`
now reads the committed artifact instead.

Then unblocking Dependabot produced the second failure. PR #14 had been opened as the
patch 5.7.2 → 5.7.3 with auto-merge correctly armed. It sat for two days. When resolution
started working, Dependabot rewrote that same PR on that same branch into 5.7.2 → 6.0.3.
The workflow re-ran, read `semver-major` and declined to arm it — but auto-merge is
GitHub-side state, and declining to arm does not disarm. CI went green, GitHub merged it,
and `types-ts` broke with 22 errors on `develop`.

Nothing in that sequence was a wrong decision in isolation. The gaps were all of the same
kind: a control that could only ever say yes, and had no way to withdraw one.

## Decision

### 1. CI jobs are required status checks for pull requests into `develop`

A failing type-check blocks any merge regardless of approvals. Today a green review and a
red build can still merge, which is how a broken `develop` becomes possible at all.

This does not conflict with [ADR-005](0005-credentials-branches-deploys.md)'s
fast-forward flow. The autopilot pushes `task/*`, waits for CI, and fast-forwards
`develop`; the commit being fast-forwarded already carries its green checks from the task
branch, so the push satisfies the requirement rather than being blocked by it. The
implementing task must confirm that empirically, not assume it — a required check that
accidentally blocks the normal flow would be discovered at the worst moment.

`main` is untouched by this ADR. Only the human merges there.

### 2. Dependabot proposes no majors

`.github/dependabot.yml`:

- **weekly** schedule (already true);
- **minor and patch grouped into one PR per ecosystem** — including `github-actions`,
  which currently has no group and so still produces one PR per action;
- **`ignore` all `version-update:semver-major`**;
- **`cooldown: default-days: 7`** with the per-type keys kept, matching
  `minimumReleaseAge` in `pnpm-workspace.yaml` and `exclude-newer` in `pyproject.toml`.

Majors stop arriving as surprise pull requests and become planned tasks instead, which is
the general rule in `AUTOPILOT.md` §2.3. A major is a behaviour change with migration
work attached; it belongs in the ledger with `done_when` items, not in a queue of ten
bot PRs nobody has time to read.

The cost is accepted and named: nothing will now open a PR when a major appears, so
majors are noticed when a task needs one or at a milestone gate, not continuously.

### 3. The auto-merge policy is a required check that can disarm

- It **re-runs on every pull-request update**, not only on open.
- It **disables auto-merge on anything that is not patch or minor**, rather than merely
  declining to enable it. Unclassified counts as not-safe, for the same reason it is
  excluded from arming.
- It is a **required check**, so its verdict gates the merge instead of racing it.

Point three is what makes the first two load-bearing. A policy job that runs alongside
the merge rather than in front of it can be outrun, which is precisely what happened.

### 4. The lockfile-age check runs where it is useful, and fails closed carefully

`tools/check_lockfile_maturity.js`:

- runs **when `pnpm-lock.yaml` changes** and **nightly**, rather than on every push —
  it is ~350 registry requests and the answer only changes when the lockfile does, plus
  once a day as versions age;
- **caches publish dates**, which are immutable: a version's publish time never changes,
  so it is cacheable forever and only new `name@version` pairs need fetching;
- **retries transient registry errors before failing closed.** It must still fail on an
  unknown age — unknown is not mature — but a 503 is not evidence of anything, and a
  check that goes red on registry weather is a check people start ignoring.

### 5. TypeScript stays on 5.x

The upgrade is task **TS-6**, which depends on **M1-06**. Expo pins the TypeScript
version it supports, and upgrading the repo ahead of the pinned SDK means either
diverging from the toolchain the app is built with or doing the migration twice. M1-06 is
the gate at which the SDK pin is settled.

## Consequences

- A red build can no longer be merged into `develop` by approval alone.
- The weekly dependency surface becomes three grouped PRs instead of up to fifteen, and
  no major lands without someone deciding it should.
- The lockfile-maturity check gets cheap enough to run often and honest enough to be
  believed, which are the two properties that decide whether a gate survives.
- Majors going unproposed is a real loss of signal, accepted deliberately. If staleness
  becomes a problem it is a new task, not a reversal of this ADR.
- The ten Dependabot PRs currently open against majors are superseded: they close, and
  anything wanted from them becomes a task.
