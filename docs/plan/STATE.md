# Autopilot state

Milestone: M0 | Last done: CORE-02 | Next: CORE-03 | Blocked: 31 tasks — M0A-05 on ADR-008, M0A-06 on M0A-05, M0B-\* + M1-02/03 on H1

Metrics: coverage 95% (Python core) | text precision/recall 1.00 on 8 hand-written cases | free-tier max 160% of dev's YouTube share (see ADR-008) | quarantined tests 0 | `make verify` ~50s

Notes:

- **M0a is complete except M0A-05 and M0A-06.** PREP-01/02/03 and M0A-01/02/03/04/07/08/09/10
  are done: toolchain, CDK app, the cdk-nag pack, the KICS pack, the account bootstrap
  template, seven workflows, the Session 1 scripts and two canary fixtures.
- **A human decision is waiting, and it blocks `make preflight` and so M0A-06.** The
  free-tier estimator's first run fails on seven rows, reproducing the PED's own
  arithmetic. The sharp one is a plain bug: dev gets 500 YouTube units a day and one
  15-song playlist costs 800, so **dev cannot create a single playlist**. The rest is a
  real conflict — PED §11 sized prod at 250 playlists/month *because* that is what
  7,000 units/day buys, which is 95.2% against a gate set at 70%. Five options in
  [ADR-008](../adr/0008-free-tier-gate-vs-ped-volumes.md); nothing was edited to make
  the gate pass.
- Four layers now enforce the never-use list, deliberately redundant: cdk-nag fails
  `cdk synth`, KICS scans finished templates, an IAM permission boundary denies what
  IAM can express, and the budget action trips on actual spend. Parity tests tie the
  first three to `budget.yaml` so none can drift from it or from each other.
- Every gate in this repo is checked against something that must FAIL as well as
  something that must pass. That has now caught: two cdk-nag rules that passed their
  own violating fixtures, a KICS pack that could have loaded silently, a secret scanner
  that never looked at new files, a staleness test that rewrote its own subject, a
  `diagnostics` environment nothing created, and a Trivy skip list that could have been
  widened to any directory at all.
- Worth remembering: `app.synth()` does **not** throw on an error annotation. It writes
  `aws:cdk:error` metadata and exits 0; the CDK **CLI** fails the build. Anything
  checking the nag gate must go through the CLI.
- `make verify` runs without Docker and spans both languages; CI runs that exact target.
  `make nag`, `make kics` and shellcheck need Docker.
- **Pushed.** `github.com/Mandar77/setlist` is public, `develop` is the default branch,
  `main` is untouched and stays that way (ADR-005). Four environments, two rulesets, and
  `AWS_ENABLED=false` gating every job that would reach AWS. The author identity is
  declared in `security/published-identities.txt`; the full-history 2MS scan was clean
  before anything left the machine.
- **What the first real CI runs cost, and bought.** Seven of eleven jobs failed on the
  first push and none of those failures were reachable locally. In order: `make verify`
  never ran at all, because the Makefile hard-coded `python -m uv` and CI installs the
  binary — the "CI runs the same commands as make verify" claim came apart the first
  time it was checked. A 2MS image tag that does not exist. A 9.8 and a HIGH in
  dependencies. `blockExoticSubDependencies`, which is not a pnpm setting; the real name
  is `blockExoticSubdeps`, and `pnpm config get` echoing the wrong name back is what had
  made the earlier verification look like confirmation. Then eslint three minors behind
  its own `@eslint/js`, and Trivy failing on the KICS fixtures — files written to contain
  violations, found to contain violations.
- Three settings in this repo have now been found to do nothing while reporting success,
  all three supply-chain controls: `blockExoticSubDependencies`, which was not a real
  key; Dependabot's `cooldown`, whose per-semver-type days default to 0 and override the
  `default-days: 7` sitting right above them; and `--frozen-lockfile` itself, which
  replays a lockfile without consulting any of the resolution-time policies that
  produced it. The third let the workspace reach a state where `pnpm install` could not
  run at all — three pins younger than the seven-day cooldown, and an `undici-types`
  whose provenance attestation had lapsed — while every CI install stayed green. What
  noticed was Dependabot, by dying; dependency updates had silently stopped. There is a
  CI job now that deletes both lockfiles and resolves from nothing, which is the only
  way those policies are ever consulted.
- **The seed catalog is in** (CORE-02): 2,242 real recordings from MusicBrainz, 83.1%
  with an ISRC, tagged live/remaster/feat/non-Latin. The harvest is manual and polite
  (1 req/s, UA naming the repo); `make seed` is the gate, and it reads the committed
  file offline. Two bugs there are worth remembering: `type=album|live` is an AND in
  MusicBrainz browse, not an OR, and a global row target silently drops every artist
  below the cutoff — which were exactly the non-Latin ones.
- **The Python core is frozen** as `tools/oracle-py` (CORE-01). It is what CORE-04's
  TypeScript port gets diffed against, so it takes no bug fixes: a wrong answer in there
  is behaviour to reproduce, not a defect. A CLI reads stdin and prints byte-stable JSON
  — sorted keys, sorted qualifiers, literal UTF-8 — so another language can drive it,
  and `golden/oracle/` pins the full output of all 8 golden cases. `make verify` fails
  if a single byte moves.
- A suppression now has to suppress something. `security/suppressions.yaml` was paperwork
  no scanner read; `.trivyignore.yaml` is generated from it and checked for staleness, and
  Trivy's own `expired_at` carries the same date — so the deadline is enforced by the
  scanner rather than only complained about by CI.
