# Autopilot state

Milestone: M1 | Last done: M0A-06 | Next: **nothing is selectable** — everything left waits on the human session H1 or on [issue #17](https://github.com/Mandar77/setlist/issues/17). [ADR-008](../adr/0008-free-tier-gate-vs-ped-volumes.md) is **decided and applied**: `make estimate` exits 0 | Blocked: 34 tasks, nearly all on H1

Metrics: coverage 95% (Python core), 96.0% stmts / 90.7% branches (`packages/core`) | Stryker 55.4%, now an [ADR-010](../adr/0010-mutation-floor-ratchet.md) ratchet with the 70% target carried to CORE-04b, which blocks CORE-07 | extraction P=0.988 R=0.982 F1=0.985 on 319 generated clean cases, 1.00 on the 8 hand-written | OCR golden set 620 images across 3 classes, 14 OFL/Apache faces, 1,719 of 1,977 seed rows drawable | free-tier worst row 89.9% of prod's YouTube quota against a 90% provider gate (ADR-008 applied) | quarantined tests 0 | `make verify` ~90s

Notes:

- **ADR-008 is applied and `make estimate` exits 0.** Provider quotas gate at 90% and AWS
  allowances stay at 70%, chosen on a row's `scope` — a threshold per *kind* of limit
  rather than a knob per row. The distinction is real: an AWS allowance that is exceeded
  **bills**, while YouTube's quota refuses the request. Planned volumes follow from the
  gate: prod 250 → 236 playlists, dev 30 → 16, scans 30,000 → 28,000. The ADR expected
  prod's CloudFront row to need only "reconciliation"; it did not — 732,000 of 1,000,000
  is the *plan's own inclusion*, not a share this project allocates, so the volumes feeding
  it had to come down. PED §10.8 is amended inline (amendments 33–34): its "35,000 scans"
  counted scans alone, ignoring the 15 requests a review session costs and the 2 an OCR
  page does. **Option (A) is deliberately untaken** — dev still cannot burst one playlist
  (500 units/day against 800) because re-splitting a quota trades away the reserve that
  absorbs a wrong estimate. That is [issue #19](https://github.com/Mandar77/setlist/issues/19).
- **The platform is built** (M0A-06): single table, provider-command topic, Cognito on
  LITE, the Function URL + OAC, SSM config and flags, log retention, alarms, and the two
  guardrail Lambdas. The never-use test caught the one mistake that mattered — the first
  version synthesized a CloudFront **Distribution**, which is banned because prod's
  flat-rate Free plan is enrolled by hand and a CDK-created one would be ordinary
  pay-as-you-go. A bill, in the environment the plan exists to make free.
- **The app runs the core on Hermes, offline** (M1-07, proven on the CI emulator). Paste
  text, get a grounded song list: title, artist, qualifiers, confidence, and the source
  line each item was read from. All three variants install side by side. The work is
  finished; the task reads `blocked` because M1-01 needs an Expo access token only a human
  can create ([issue #18](https://github.com/Mandar77/setlist/issues/18)), and three of
  its four done_when items are met by `expo prebuild` + Gradle rather than `eas build`.
- **Four emulator CI rounds, four different real defects, none findable locally:**
  `set -euo pipefail` under dash; android-emulator-runner running each script line in its
  own `sh -c`, so a `for` loop died on "end of file unexpected"; a debug APK that installs,
  launches and shows **nothing** because it expects a Metro server; and Metro unable to
  resolve `./confidence.js` because `packages/core` is NodeNext TypeScript, where that
  means `./confidence.ts`. CI now bundles before it builds, so the next one surfaces in a
  minute rather than after four.
- **The ledger has no selectable work left.** 31 done, 35 blocked, 12 waiting on a
  dependency that is itself blocked. Everything still open needs one of three things that
  the loop cannot supply: the human's AWS/GitHub/Expo session (H1), the ADR-008 decision,
  or issue #17. Three tasks are marked blocked on evidence rather than guesswork —
  M0A-06, M1-01 and M6-02, whose work is *finished* but whose `verify` is `make estimate`
  or `make preflight`, and those exit 1 on ADR-008's seven rows.
- **The OCR golden set is generated** (M2-01): 620 images — 220 handwriting, 220 print,
  180 screenshot — drawn in Chromium from 14 OFL/Apache faces, with ground truth taken
  from the same seed and the same `truthFor` the text corpus uses. Two things are worth
  carrying forward. **A struck-out line has two right answers**: OCR must read it, the
  extractor must not return it, so the manifest carries `line.text` for CER/WER and
  `songTruth` for song-level F1. And **the first version clipped** — a long credit ran off
  the right edge while the manifest still claimed the whole string, which is ground truth
  for characters no engine could read. The renderer now measures the laid-out page and
  refuses to write an image whose text did not fit; the arithmetic that was supposed to
  prevent it was itself wrong by 4.6px, and a test found that.
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
- **That job was not enough, and the same thing happened again** on 2026-10-01: the
  lockfile took rolldown 1.2.12 one day after publication against a seven-day floor,
  Dependabot died on every npm run for two days, and the job stayed green the whole time.
  Resolving from nothing proves a compliant lockfile *could* exist; it cannot prove the
  committed one is compliant, because it begins by deleting it — and vite's `~1.2.9`
  means a fresh resolve keeps picking the mature 1.2.11 while git still held 1.2.12.
  `tools/check_lockfile_maturity.js` now reads the committed artifact instead, 358
  versions against the registry's own publish times, and treats "cannot establish age"
  as a failure. Both must-fail directions are time-stable, which the obvious fixture is
  not: a real package pinned to a recent version stops failing once it ages past the
  floor. Dependency updates are flowing again — 11 open PRs.
- **And unblocking Dependabot immediately produced the next failure, from the same
  outage.** A TypeScript major merged itself into develop against the auto-merge
  workflow's own "majors never do", and broke `types-ts` with 22 errors. No step in the
  sequence was wrong: the PR was opened as the patch 5.7.2 -> 5.7.3 and auto-merge was
  armed correctly; it then sat for two days unable to resolve; when it could, Dependabot
  rewrote that same PR on that same branch into 6.0.3; the workflow re-ran, read
  `semver-major` and skipped arming. Skipping is not disarming — auto-merge is
  GitHub-side state, not a per-push decision — so the old arming fired. The workflow had
  one state transition and needed two, and the negative branch now acts rather than does
  nothing. `check_workflows.js` asserts the two conditions are complements. Reverted;
  TypeScript 6 goes back to being a thing a person opts into.
- **The TypeScript core reproduces the frozen oracle exactly** (CORE-04): all 8 golden
  cases field for field, all 10,000 generated inputs byte for byte, with
  `golden/diff-allowlist.yaml` empty and enforced from both directions. The differential
  was built before the code rather than after, and earned it: `\w` and `\s` mean
  different things in the two languages, pydantic was stripping the document text,
  the digest is computed *before* that strip, and Python's `sum()` has used Neumaier
  compensated summation since 3.12. A well-intentioned widening of the sentence lookahead
  to `\p{Lu}` broke a Greek tracklist — porting means reproducing, including the parts
  that look wrong.
- **CORE-04 is done; the mutation floor became a ratchet** ([ADR-010](../adr/0010-mutation-floor-ratchet.md)).
  Coverage clears 90%; Stryker measured 55.4%, having moved 42.5 → 47.3 → 53.9 → 55.4 as
  table-driven tests landed. 70% is still the target and is now CORE-04b, a dependency of
  CORE-07 — the oracle cannot retire until the TS suite is shown to catch regressions
  without it. The break threshold moves to the measured score and may only rise, which is
  also the stricter choice: a fixed 70 against a score of 55 could not have detected a
  drop to 45. Remaining survivors are csv-reader conditionals (reachable), regex-source
  mutants (mostly equivalent) and `throw`-message strings (killable only by asserting
  exact error text).
- **Two instruments were found measuring nothing, both by mutation testing.** A SHA-256
  test that asserted `digest === sha256Hex(normalize(raw))` — both sides call the function
  under test, so a corrupted round constant changed both and the assertion held; FIPS
  180-4 vectors replaced it. And a Stryker run reporting "Ran 230 tests" while the two
  differential suites threw ENOENT during load, because the sandbox breaks a `../../..`
  path to `golden/`. That is the third and fourth thing in this repo found to report
  success while doing nothing.
- **ADR-008's rule was computed and reaches only three of the seven rows.** Planned
  volumes follow from the gate, provider rows judged at 90% because the runtime unit
  bucket is what stops the spend: that gives prod 236, stage 50, dev 16, all bound by the
  YouTube quota. The other four rows - `cloudwatch_logs_gb` in every environment and
  prod's `cloudfront_requests` - are not fed by a playlist volume at all, so no value of
  the three, including zero, moves them. Back with the human rather than guessed at;
  nothing was applied, so `make estimate` still exits 1 on seven rows and not on four.
- **A service nobody scheduled.** `services/ingestion/` exists and PED S365 gives it
  scans, idempotency and quotas - it publishes the `ScanSubmitted.v1` that M3-02 consumes
  - and no task in the ledger built it. Found only because ADR-008's runtime caps had to
  be attached to the tasks building bff, ingestion and yt-adapter, and one of the three
  did not exist. Now M3-01b, and M3-02 depends on it.
- **`normalize_document` is not idempotent, in both languages; decided, and HYG-02 fixes
  it** ([ADR-009](../adr/0009-oracle-bug-fixes.md): the frozen oracle may take bug fixes,
  never features, when both implementations move in one change and the corpus does not).
  It applies NFKC and then strips control characters, so the strip can make
  two combining marks adjacent that NFKC never compared, and a second pass reorders them
  by combining class. Hypothesis found the witness U+00B4, U+001F, U+1A7F — written by
  codepoint because the middle one is a control character and must not sit literally in a
  tracked file. NFKC turns U+00B4 into space + U+0301 (ccc 230); the strip then removes
  the U+001F separating it from U+1A7F (ccc 220), and the two marks swap. Latent, not live — there is
  one call site in each language, so nothing normalizes twice today; it would bite on a
  round trip, shifting every span after the affected position, which is the failure the
  ADR-007 span contract exists to prevent. The fix is one more NFKC after the
  strip and it was measured, not guessed: zero output changes across all 14,900 inputs in
  the two differential corpora, which is exactly ADR-009's condition for allowing it. Both
  implementations move in one commit, and the shrunk witness becomes a permanent explicit
  example in both property suites. Until HYG-02 lands, the property test is a true red that CI
  hits at random. The port reproduces the bug exactly, so CORE-04's parity claim stands.
- **The golden text set is generated** (CORE-03): 433 cases, 2,538 expected songs, built
  from the seed so the expected answers never come from parser output. Two tiers — `clean`
  carries the PED gate (currently P=0.988 R=0.982 F1=0.985), `noisy` is prose and
  undecidable orders and is held only to grounding, because the deterministic pass is not
  the component that reads prose.
- **Three extractor gaps are recorded as noisy cases, for CORE-04 to fix.** A `feat.`
  credit on the LEFT flips the orientation, so "Calvin Harris feat. Dua Lipa - One Kiss"
  returns the title "Calvin Harris" — `has_version_annotation` treats a featured credit as
  a title-side cue, which is true for "(Live)" and false here, and this is one of the
  commonest shapes there is. `fold()` transliterates emoji through anyascii, so a trailing
  🔥 joins the title. A leading 🎵 is not stripped as a list marker.
- Building that corpus was mostly a lesson in **the generator being wrong, not the
  extractor**. Four made-up requirements — ` -- ` as a separator, ` | ` mixed with list
  markers, randomized headerless CSV column order, bare "1 " as a marker — took clean F1
  from 0.606 to 0.985 once removed. Every one of them first read as an extractor failure.
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
