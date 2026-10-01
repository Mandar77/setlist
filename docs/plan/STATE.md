# Autopilot state

Milestone: M0 | Last done: M0A-09 | Next: CORE-01 | Blocked: 31 tasks — M0A-05 on ADR-008, M0A-06 on M0A-05, M0B-\* + M1-02/03 on H1

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
  that never looked at new files, a staleness test that rewrote its own subject, and a
  `diagnostics` environment nothing created.
- Worth remembering: `app.synth()` does **not** throw on an error annotation. It writes
  `aws:cdk:error` metadata and exits 0; the CDK **CLI** fails the build. Anything
  checking the nag gate must go through the CLI.
- `make verify` runs without Docker and spans both languages; CI runs that exact target.
  `make nag`, `make kics` and shellcheck need Docker.
- **Blocking the first push:** the git author identity. `scan-secrets.sh` refuses until
  it is declared in `security/published-identities.txt` or rewritten to a noreply
  address. See `docs/hitl/QUEUE.md` and SESSION-1 step 1b.
- Nothing pushed — no remote branches. Work fast-forwards `develop` locally until
  Session 1, then everything pushes at once (AUTOPILOT §2.1 step 8).
