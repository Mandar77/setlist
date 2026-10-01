# Autopilot state

Milestone: M0 | Last done: M0A-04 | Next: M0A-06 | Blocked: 31 tasks — M0A-05 on ADR-008, M0B-\* + M1-02/03 on H1

Metrics: coverage 95% (Python core) | text precision/recall 1.00 on 8 hand-written cases | free-tier max 160% of dev's YouTube share (see ADR-008) | quarantined tests 0 | `make verify` 41s

Notes:

- PREP-01/02/03 and M0A-01/02/03/04 done. M0A-05 is built but **blocked**: see below.
- **A human decision is waiting, and it blocks `make preflight`.** The free-tier
  estimator's first run fails on seven rows, reproducing the PED's own arithmetic. The
  sharp one is a plain bug: dev gets 500 YouTube units a day and one 15-song playlist
  costs 800, so **dev cannot create a single playlist**. The rest is a real conflict —
  PED §11 sized prod at 250 playlists/month *because* that is what 7,000 units/day
  buys, which is 95.2% against a gate set at 70%. Five options in
  [ADR-008](../adr/0008-free-tier-gate-vs-ped-volumes.md); nothing was edited to make
  the gate pass.
- Two enforcers now cover the never-use list, deliberately redundant: the cdk-nag pack
  fails `cdk synth`, the KICS pack scans finished templates. A parity test asserts they
  cover the same 22 rule ids in both directions, because a rule only one of them knows
  about still looks enforced from either side.
- Both packs are checked against samples that must fail as well as ones that must pass.
  That is not ceremony — it has caught four real defects so far, including two cdk-nag
  rules that passed their own violating fixtures because `addPropertyOverride` leaves
  the typed accessor undefined while the template gets the property.
- Worth remembering: `app.synth()` does **not** throw on an error annotation. It writes
  `aws:cdk:error` metadata and exits 0; the CDK **CLI** fails the build. Anything
  checking the nag gate must go through the CLI.
- `make verify` runs without Docker and spans both languages; CI runs that exact target.
  `make kics` and the nag gate fixture need Docker.
- **Blocking the first push:** the git author identity. `scan-secrets.sh` refuses until
  it is declared in `security/published-identities.txt` or rewritten to a noreply
  address. See `docs/hitl/QUEUE.md` and SESSION-1 step 1b.
- Nothing pushed — no remote branches. Work fast-forwards `develop` locally until
  Session 1, then everything pushes at once (AUTOPILOT §2.1 step 8).
