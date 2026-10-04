# Journal — what was learned, and what it cost to learn it

`docs/plan/STATE.md` is the autopilot's working memory and is capped at one screen
(`AUTOPILOT.md` §3). This file is where its long-form notes go, so that cap costs nothing.

Nothing here is a status. For what is done, blocked or next, read
[`plan/TASKS.yaml`](../plan/TASKS.yaml) and [`plan/STATE.md`](../plan/STATE.md).

---

## Instruments found reporting success while doing nothing

The recurring failure of this project, by a wide margin. Seven so far, which is why the
house rule is that **every gate is checked against something that must FAIL as well as
something that must pass**.

1. **`blockExoticSubDependencies`** — not a real pnpm key. The real name is
   `blockExoticSubdeps`. `pnpm config get` echoed the wrong name back, which is what made
   the earlier verification look like confirmation.
2. **Dependabot's `cooldown`** — the per-semver-type days default to 0 and override the
   `default-days: 7` sitting directly above them.
3. **`--frozen-lockfile`** — replays a lockfile without consulting any of the
   resolution-time policies that produced it. This let the workspace reach a state where
   `pnpm install` could not run at all — three pins younger than the seven-day cooldown and
   an `undici-types` whose provenance attestation had lapsed — while every CI install stayed
   green. What noticed was Dependabot, by dying; dependency updates had silently stopped for
   two days.
4. **A SHA-256 test** asserting `digest === sha256Hex(normalize(raw))` — both sides call the
   function under test, so a corrupted round constant changed both and the assertion held.
   Replaced with the published FIPS 180-4 vectors; a one-bit change to a round constant now
   fails eight tests.
5. **A Stryker run reporting "Ran 230 tests"** while the two differential suites threw
   ENOENT during load, because the sandbox breaks a `../../..` path to `golden/`.
6. **A secret scanner that never looked at new files**, a staleness test that rewrote its
   own subject, and a Trivy skip list that could have been widened to any directory at all
   — all caught by must-fail fixtures.
7. **`never-use.test.ts`'s capacity-cap test** (ADR-013) — loops over
   `findResources('AWS::ApplicationAutoScaling::ScalableTarget')`, which returns zero,
   because `TableV2` renders `AWS::DynamoDB::GlobalTable` and carries autoscaling *inline*.
   The loop has never had a body. The first one found inside the never-use suite itself.

Two near-misses worth the same respect: **two cdk-nag rules passed their own violating
fixtures** (they read a typed L1 accessor rather than the rendered template, so anything set
through an escape hatch was invisible), and a **KICS pack that could have loaded silently**.

Related, and the reason `make nag` goes through the CDK **CLI**: `app.synth()` does *not*
throw on an error annotation. It writes `aws:cdk:error` metadata and exits 0.

---

## Supply chain

- **`tools/check_lockfile_maturity.js` reads the committed artifact**, 358 versions against
  the registry's own publish times, and treats "cannot establish age" as a failure. The
  earlier job that deleted both lockfiles and resolved from nothing proves a compliant
  lockfile *could* exist; it cannot prove the committed one is compliant, because it begins
  by deleting it. vite's `~1.2.9` meant a fresh resolve kept picking the mature 1.2.11 while
  git still held rolldown 1.2.12, taken one day after publication against a seven-day floor.
- **Both must-fail directions are time-stable**, which the obvious fixture is not: a real
  package pinned to a recent version stops failing once it ages past the floor.
- **A TypeScript major merged itself into develop** against the auto-merge workflow's own
  "majors never do". No step was wrong: the PR opened as patch 5.7.2 → 5.7.3 and auto-merge
  armed correctly; it sat two days unable to resolve; Dependabot then rewrote that same PR on
  that same branch into 6.0.3; the workflow re-ran, read `semver-major`, and *skipped* arming.
  **Skipping is not disarming** — auto-merge is GitHub-side state, not a per-push decision —
  so the old arming fired. The workflow had one state transition and needed two.
  `check_workflows.js` now asserts the two conditions are complements.

---

## The core, the oracle and the port

- **The TypeScript core reproduces the frozen oracle exactly** (CORE-04): all 8 golden cases
  field for field, all 10,000 generated inputs byte for byte, `golden/diff-allowlist.yaml`
  empty and enforced from both directions. The differential was built *before* the code and
  earned it: `\w` and `\s` mean different things in the two languages, pydantic was stripping
  the document text, the digest is computed *before* that strip, and Python's `sum()` has used
  Neumaier compensated summation since 3.12. A well-intentioned widening of the sentence
  lookahead to `\p{Lu}` broke a Greek tracklist — **porting means reproducing, including the
  parts that look wrong.**
- **`normalize_document` is not idempotent, in both languages** (ADR-009, fixed by HYG-02).
  NFKC then strip-controls means the strip can make two combining marks adjacent that NFKC
  never compared, and a second pass reorders them by combining class. Hypothesis found
  U+00B4, U+001F, U+1A7F — written by codepoint because the middle one is a control character.
  Latent, not live: one call site per language. It would bite on a round trip, shifting every
  span after the affected position — the exact failure the ADR-007 span contract exists to
  prevent. The fix is one more NFKC after the strip, and it was **measured, not guessed**:
  zero output changes across all 14,900 inputs in the two differential corpora.
- **The mutation floor became a ratchet** (ADR-010). Stryker measured 55.4%, having moved
  42.5 → 47.3 → 53.9 → 55.4 as table-driven tests landed. A fixed 70 against a score of 55
  could not have detected a drop to 45, so the ratchet is also the stricter choice. Remaining
  survivors: csv-reader conditionals (reachable), regex-source mutants (mostly equivalent),
  and `throw`-message strings (killable only by asserting exact error text).

---

## Corpora

- **The seed catalog** (CORE-02): 2,242 real MusicBrainz recordings, 83.1% with an ISRC.
  Two bugs worth remembering: `type=album|live` is an **AND** in MusicBrainz browse, not an
  OR, and a global row target silently drops every artist below the cutoff — which were
  exactly the non-Latin ones.
- **The golden text set** (CORE-03): 433 cases, 2,538 expected songs, built from the seed so
  the expected answers never come from parser output. Building it was mostly a lesson in **the
  generator being wrong, not the extractor**: four made-up requirements — ` -- ` as a
  separator, ` | ` mixed with list markers, randomized headerless CSV column order, bare
  `"1 "` as a marker — took clean F1 from 0.606 to 0.985 once removed. Every one first read
  as an extractor failure.
- **The OCR golden set** (M2-01): 620 images from 14 OFL/Apache faces. **A struck-out line
  has two right answers** — OCR must read it, the extractor must not return it — so the
  manifest carries `line.text` for CER/WER and `songTruth` for song-level F1. **The first
  version clipped**: a long credit ran off the right edge while the manifest still claimed
  the whole string, which is ground truth for characters no engine could read. The renderer
  now measures the laid-out page and refuses to write an image whose text did not fit — and
  the arithmetic meant to prevent it was itself wrong by 4.6px, which a test found. Glare was
  capped after it *erased* text at 0.86 alpha: **an augmentation is useful while it degrades
  and useless once it erases.**

### Three extractor gaps, recorded as noisy cases
A `feat.` credit on the **left** flips the orientation, so "Calvin Harris feat. Dua Lipa -
One Kiss" returns the title "Calvin Harris" — `has_version_annotation` treats a featured
credit as a title-side cue, true for "(Live)" and false here. `fold()` transliterates emoji
through anyascii, so a trailing 🔥 joins the title. A leading 🎵 is not stripped as a list
marker.

---

## Infrastructure and cost

- **Four layers enforce the never-use list, deliberately redundant:** cdk-nag fails
  `cdk synth`, KICS scans finished templates, an IAM permission boundary denies what IAM can
  express, and the budget action trips on actual spend. Parity tests tie the first three to
  `budget.yaml`.
- **The never-use test caught the one mistake that mattered in M0A-06** — the first version
  synthesized a CloudFront **Distribution**, which is banned because prod's flat-rate Free
  plan is enrolled by hand and a CDK-created one would be ordinary pay-as-you-go. A bill, in
  the environment the plan exists to make free.
- **ADR-008 is applied and `make estimate` exits 0.** Provider quotas gate at 90% and AWS
  allowances at 70%, chosen on a row's `scope` — a threshold per *kind* of limit rather than
  a knob per row. The distinction is real: an AWS allowance that is exceeded **bills**, while
  YouTube's quota refuses the request. The ADR expected prod's CloudFront row to need only
  "reconciliation"; it did not — 732,000 of 1,000,000 is the *plan's own inclusion*, not a
  share this project allocates, so the volumes feeding it had to come down. PED §10.8's
  "35,000 scans" counted scans alone, ignoring the 15 requests a review session costs and the
  2 an OCR page does (amendments 33–34).
- **ADR-008 option (A) is deliberately untaken.** dev still cannot burst one playlist (500
  units/day against 800) because re-splitting a quota trades away the reserve that absorbs a
  wrong estimate. Closed as intended on 2026-10-04: dev uses the provider simulator and never
  makes a live YouTube call, so it does not need the units.
- **A service nobody scheduled.** `services/ingestion/` exists and PED §365 gives it scans,
  idempotency and quotas — it publishes the `ScanSubmitted.v1` that M3-02 consumes — and no
  task built it. Found only because ADR-008's runtime caps had to be attached to the tasks
  building bff, ingestion and yt-adapter, and one of the three did not exist. Now M3-01b.
- **A suppression now has to suppress something.** `security/suppressions.yaml` was paperwork
  no scanner read; `.trivyignore.yaml` and `osv-scanner.toml` are generated from it and
  checked for staleness, and the scanners' own expiry fields carry the same date.

---

## CI, and what the first real runs cost

**Seven of eleven jobs failed on the first push and none of those failures were reachable
locally.** `make verify` never ran at all, because the Makefile hard-coded `python -m uv`
and CI installs the binary — the "CI runs the same commands as `make verify`" claim came
apart the first time it was checked. Then a 2MS image tag that does not exist, a 9.8 and a
HIGH in dependencies, `blockExoticSubDependencies`, eslint three minors behind its own
`@eslint/js`, and Trivy failing on the KICS fixtures — files written to contain violations,
found to contain violations.

### Five emulator rounds, five different real defects, none findable locally
1. `set -euo pipefail` under dash, which has no `pipefail`.
2. `android-emulator-runner` executes **each script line in its own `sh -c`**, so a `for`
   loop died on "end of file unexpected".
3. A **debug APK that installs, launches and shows nothing**, because it expects a Metro
   server. `assembleRelease` embeds the bundle.
4. **Metro unable to resolve `./confidence.js`**, because `packages/core` is NodeNext
   TypeScript where that specifier means `./confidence.ts`. Fixed with a `resolveRequest`
   shim — and by reverting `disableHierarchicalLookup`, which is exactly wrong under pnpm.
5. A **"Pixel Launcher isn't responding" ANR dialog** owning the focused window, on top of an
   app that was rendering correctly.

Round 5 is the one that changed `CLAUDE.md`. Two diagnoses were made from log text alone — "a
cold-launch race", then "the element never appeared" — and the second shipped a fix for a
cause that did not exist. A step in that same job uploads a screenshot and the UI hierarchy
on failure; reading it took one command and ended the question. **When a check fails, read
what it produced before changing anything.**

CI now runs `expo export` before Gradle, so a bundler failure surfaces in about a minute
instead of after a four-minute build as `:app:createBundleReleaseJsAndAssets FAILED` with the
real error forty lines above it.

---

## The repository itself

`github.com/Mandar77/setlist` is public, `develop` is the default branch, `main` is untouched
and stays that way (ADR-005). Four environments, two rulesets, and `AWS_ENABLED=false` gating
every job that would reach AWS. The author identity is declared in
`security/published-identities.txt`; the full-history 2MS scan was clean before anything left
the machine.
