# Autopilot state

Milestone: M0 | Last done: CORE-03 | Doing: CORE-04 (5 of 6 done_when met) | Blocked: 31 tasks — M0A-05 on ADR-008, M0A-06 on M0A-05, M0B-\* + M1-02/03 on H1

Metrics: coverage 95% (Python core), 96.0% stmts / 90.7% branches (`packages/core`) | **Stryker 55.4% against a 70% floor — CORE-04's one unmet item** | extraction P=0.988 R=0.982 F1=0.985 on 319 generated clean cases, 1.00 on the 8 hand-written | free-tier max 160% of dev's YouTube share (see ADR-008) | quarantined tests 0 | `make verify` ~60s

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
- **The TypeScript core reproduces the frozen oracle exactly** (CORE-04): all 8 golden
  cases field for field, all 10,000 generated inputs byte for byte, with
  `golden/diff-allowlist.yaml` empty and enforced from both directions. The differential
  was built before the code rather than after, and earned it: `\w` and `\s` mean
  different things in the two languages, pydantic was stripping the document text,
  the digest is computed *before* that strip, and Python's `sum()` has used Neumaier
  compensated summation since 3.12. A well-intentioned widening of the sentence lookahead
  to `\p{Lu}` broke a Greek tracklist — porting means reproducing, including the parts
  that look wrong.
- **CORE-04 is not done, and the open item is the mutation floor.** Coverage clears 90%;
  Stryker is at 55.4% against 70%. It moved 42.5 → 47.3 → 53.9 → 55.4 as table-driven
  tests landed, and the remaining survivors are csv-reader conditionals (reachable),
  regex-source mutants (mostly equivalent) and `throw`-message strings (killable only by
  asserting exact error text). The threshold stays where CLAUDE.md puts it and
  `make mutate-ts` fails on it; relaxing it would be a `human-needed` issue with an ADR.
- **Two instruments were found measuring nothing, both by mutation testing.** A SHA-256
  test that asserted `digest === sha256Hex(normalize(raw))` — both sides call the function
  under test, so a corrupted round constant changed both and the assertion held; FIPS
  180-4 vectors replaced it. And a Stryker run reporting "Ran 230 tests" while the two
  differential suites threw ENOENT during load, because the sandbox breaks a `../../..`
  path to `golden/`. That is the third and fourth thing in this repo found to report
  success while doing nothing.
- **`normalize_document` is not idempotent, in both languages, and that is a decision
  waiting.** It applies NFKC and then strips control characters, so the strip can make
  two combining marks adjacent that NFKC never compared, and a second pass reorders them
  by combining class. Hypothesis found the witness U+00B4, U+001F, U+1A7F — written by
  codepoint because the middle one is a control character and must not sit literally in a
  tracked file. NFKC turns U+00B4 into space + U+0301 (ccc 230); the strip then removes
  the U+001F separating it from U+1A7F (ccc 220), and the two marks swap. Latent, not live — there is
  one call site in each language, so nothing normalizes twice today; it would bite on a
  round trip, shifting every span after the affected position, which is the failure the
  ADR-007 span contract exists to prevent. The candidate fix is one more NFKC after the
  strip and it was measured, not guessed: zero output changes across all 14,900 inputs in
  the two differential corpora. It is still a change to the frozen oracle, so it needs an
  ADR rather than a quiet edit, and until then the property test is a true red that CI
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
