# Setlist Autopilot Plan (v1.0, 2026-09-28)

Give this file to Claude Code. It does three things:
- answers the three open questions (ADR-001 to ADR-003);
- settles the other decisions that would stall the build (ADR-004 to ADR-006);
- sets out how Claude Code finishes Setlist while taking as little of your time as possible.

**Precedence:** this file and `docs/adr/` > PED > PRD. When they conflict, Claude Code amends the losing spec in the same change.

---

## 0. Your part (about 2 hours in total)

### Right now (about 10 minutes)
1. Save this file as `docs/plan/AUTOPILOT.md` in the repo.
2. Press Esc on Claude Code's question panel. This file answers all three questions.
3. Update Claude Code and work in **auto mode**. Auto is the default on current versions. In VS Code, pick **Auto** from the mode indicator once.
4. Recommended: merge the block in section 7.1 into `~/.claude/settings.json`, then check it with `claude auto-mode config`. Only you can add it, because a repository can't grant itself auto-mode rules.
5. Send Claude Code: *"Read docs/plan/AUTOPILOT.md and do the Bootstrap in section 4. Tell me when to restart you."* Bootstrap writes into `.claude/`, which is a protected folder, so approve the one or two prompts it raises.
6. When it says so, restart Claude Code in the repo folder and type `/autopilot`.

### Later
When something needs you, Claude Code opens a GitHub issue labeled `human-needed`, assigned to you, with exact steps.

| When | What | Time |
|---|---|---|
| Before any cloud deploy | **Session 1**: GitHub setup script, AWS account and one CloudFormation upload, Expo token | about 40 min |
| After the first dev deploy | **Session 2**: Google Cloud OAuth for YouTube, a test Google account, Firebase push, optional Spotify | about 45 min |
| During M2 | **Session 3**: copy 15 short song lists by hand and photograph them | about 25 min |
| At beta (M7) | **Session 4**: add testers and send the invite Claude Code drafted | about 15 min |
| M0, M4, M7, M8 | **Release**: merge the `develop` -> `main` pull request. Nothing else deploys prod | 1 click each |
| New AWS accounts only, month 4-5 | Switch from the Free plan to the Paid plan after Claude Code shows 30 days at $0 | about 5 min |

Section 6 has the full steps. Everything else is Claude Code's job.
- If auto mode pauses with a prompt, answer it. Blocked actions are listed under `/permissions` -> Recently denied.
- If a session stops at a usage limit, start Claude Code again and type `/autopilot`. The ledger (section 3) is its memory.

---

## 1. Decisions

### ADR-001: Parser home is one TypeScript core (answers "Parser home")
**Decision.** Port the core to TypeScript. `packages/core` (TypeScript + zod) is the only song grammar. It runs on Hermes in the Expo app, in the browser (PWA), and in Node Lambdas for extraction and matching.

**Why.** PED section 9 requires parsing to work offline, and NFR-M-003 needs scan-to-preview under 4 s. Two grammars would drift apart, and every parser fix would have to be made twice.

**How.**
- **Freeze the Python core** as `tools/oracle-py/`, with a CLI that takes text on stdin plus `sourceKind` and prints JSON. It gets no new features.
- **Port with a differential test.** The TypeScript output must equal the oracle's on every golden case and on at least 10,000 generated inputs. Allowed differences are listed in `golden/diff-allowlist.yaml`, and only ADR-002 orientation changes may be listed there.
- **Keep the core pure.** No Node, DOM, or React Native APIs; an ESLint rule enforces this.
- **Prove identical behavior on three engines:**
  - Node (Vitest);
  - Chromium (Playwright);
  - Hermes, through a dev-only self-test screen that Maestro drives in CI (task M1-04). Check Unicode normalization (NFKC) and regex Unicode features on Hermes first, and polyfill anything that differs.
- **Retire the oracle.** Once parity holds and all three engines pass, delete it and keep its outputs as frozen fixtures.

**Spec edits.** PED section 9, section 10.3 (extraction runs on Node), and section 14 (TypeScript test stack).

### ADR-002: Line orientation in "X - Y" (answers "Dash order")
**Decision.** Use defaults per source kind, but let evidence override them. Resolve orientation in this order:
1. **Explicit cues** (confidence 0.95 or higher): "Title by Artist", a quoted title, CSV headers, labeled fields, timestamped DJ tracklists (artist first).
2. **Document convention** (about 0.85): the majority orientation of cue-bearing lines in the same input. A side that repeats across lines is the artist.
3. **Source-kind prior** (0.6):
   - `scan_handwriting`, `scan_print`, `screenshot`: title first;
   - `paste`, `file`: artist first.
4. **Low confidence** (below 0.8): the parser also emits the swapped reading as `alternate`. Spans still point at the raw text, so grounding holds.
5. **Resolve in matching.** Check `alternate` against free catalogs (MusicBrainz, Deezer) before spending any YouTube quota.
   - Pick the orientation whose best candidate wins by at least 0.10.
   - Otherwise keep the prior and send the item to review.
   - Autonomous creation never goes ahead on an unresolved orientation.

**Example.** Take pasted text `1. Wonderwall - Oasis`:
- The prior says artist first, and confidence is low, so the swap is emitted as `alternate`.
- MusicBrainz finds a recording "Wonderwall" by "Oasis", so the swap wins.
- The same line from a scan is already right on the prior.

**Title-only lines** are common on band setlists. Use a document-level artist hint if there is one: a header such as "Oasis setlist", or an optional "All songs by" field in review. Otherwise send the line to review.

**Targets.**
- Parser-only orientation accuracy of at least 90% on bare-dash lines.
- At least 98% after matching.
- No extra YouTube units spent on orientation.
- The 8 existing golden cases keep their expected outputs.

**Spec edits.** PRD FR-002 (orientation is inferred, and defaults depend on source kind) and PED epic E4 (the example gains a `sourceKind`).

### ADR-003: Build order, M0 first (answers "Next up")
**Decision.** Finish M0 first, split so the work never waits on you:
- **M0a** starts now and needs no AWS. It covers the nag pack, KICS zero-cost queries, free-tier estimator, `make preflight`, CI workflows, the account-bootstrap template, and the kill-switch and sentinel code.
- **CORE** (the ADR-001 port) comes next. It also needs no AWS.
- **M0b** (cloud) runs as soon as Session 1 is done. After it, M1 to M8 follow PED section 16.

The ledger always picks the next unblocked task, so a task waiting on you never stops the rest of the work.

### ADR-004: Language map
- **TypeScript on Node** (arm64, bundled as a zip with esbuild) for every Lambda except OCR:
  - bff, identity, ingestion, extraction, catalog-matching, playlist-orchestration;
  - provider-connection, the provider adapters, notification, config, kill-switch, usage-sentinel.

  These share the core's normalizer and the zod contracts, and use one toolchain with CDK, the app, and the PWA.
- **Python 3.13** (arm64, zip) only for these:
  - `ocr-svc`, because the ONNX OCR tooling (RapidOCR) is Python-first. It returns raw lines and contains no grammar.
  - `packages/etl`, which must stay Glue-compatible.
  - The temporary oracle.
- **Tooling:**
  - Powertools for AWS Lambda (TypeScript) for logging, tracing, metrics, idempotency and parameters.
  - Vitest, fast-check and aws-sdk-client-mock for TypeScript tests.
  - Stryker mutation score of at least 70% on `packages/core` and 65% elsewhere.
  - pytest, Hypothesis and mutmut (at least 70%) for the Python parts.
  - Contracts are zod-first in `packages/contracts`, and JSON Schema is generated from them for Python consumers.
- **If `ocr-svc` exceeds 240 MB unzipped**, replace OpenCV with Pillow and numpy, or shrink the models. Never switch to container images, because ECR storage is billed.

### ADR-005: Credentials, branches, and who deploys
- **No local cloud credentials.** Claude Code never holds AWS credentials or provider secrets. Every AWS action runs in GitHub Actions through OIDC. To look at deployed state, Claude Code dispatches the read-only `diagnostics` workflow and reads its output.
- **Branches.**
  - Claude Code pushes `task/*` branches, and CI runs on each one.
  - When CI is green, Claude Code fast-forwards `develop`.
  - `develop` deploys to dev automatically, then the same artifact to stage.
  - Only you merge `develop` -> `main`. `main` deploys to prod the artifact that passed stage, built from the pull request's head commit rather than rebuilt.
  - Claude Code never merges pull requests and never pushes to `main`. Auto mode blocks an agent from merging an unreviewed pull request anyway.
- **Secrets.**
  - You type them into hidden prompts from `scripts/hitl/*.sh`, which store them as GitHub environment secrets.
  - CI copies them into SSM SecureString.
  - Never paste a secret into the Claude chat.
- **Public repo hygiene.**
  - No account IDs, ARNs, emails or personal data go into commits, issues or pull requests. They live in GitHub secrets and variables.
  - CDK reads the account from the CI session.
  - Redirect URIs and domains appear in deploy job summaries, not in committed files.
- **Only free APIs in automation.**
  - Banned: Cost Explorer, CloudWatch `GetMetricData`, and CloudWatch Logs Insights queries.
  - Use instead: `GetMetricStatistics`, Describe/List calls, and the kill switch's own alert record as evidence of a $0 bill.
  - Before adding any other AWS API call, check its pricing page and cite it in the commit.

### ADR-006: Test data Claude Code can trust
Claude Code must never grade its own work.
- **Seed catalog.** About 2,000 recordings, pulled once from MusicBrainz into `golden/seed/recordings.jsonl` and committed.
  - Rules: MusicBrainz core data is CC0; stay at 1 request/s; send a User-Agent that carries the repo URL.
  - Fields: title, artist credit, ISRCs, duration and MBIDs.
  - Coverage: live, remaster and feat. variants, plus non-Latin names.
- **Text golden set.** Generated from the seed, truth first, so expected outputs come from the seed and never from the parser. It covers these formats:
  - numbered and bulleted lists, "by", CSV and timestamps;
  - both dash orders for each source kind;
  - chat and Reddit-style prose;
  - typos, emoji, odd casing and multilingual text.
- **OCR golden set.** Rendered from the seed, not committed; CI generates it with deterministic seeds.
  - Sources: handwriting fonts (OFL or Apache licensed, for example through @fontsource), printed posters and flyers, and chat screenshots rendered with Playwright.
  - Augmentations: rotation up to 7 degrees, perspective, blur, glare, JPEG noise, ruled paper and crossed-out lines.
- **Real handwriting.** In Session 3 you copy 15 lists that Claude Code generated, so the ground truth is known in advance.
  - The photos are encrypted with `age` into `golden/private/`.
  - The key is a GitHub secret.
  - Decryption happens only in CI runs on `develop` and `main`.
- **Gates.** The synthetic sets gate every push. The real set gates M2, M7 and M8. Synthetic handwriting is cleaner than real handwriting, so only the real set can pass the handwriting targets.
- **Changing expected outputs.** Only through an ADR, the way ADR-002's allowlist works.

---

## 2. Operating protocol (for Claude Code)

### 2.1 The loop (`/autopilot`)
1. **Sync.**
   - Run `git fetch`, switch to `develop`, and pull.
   - Read `docs/plan/STATE.md`, `docs/plan/TASKS.yaml` and any new ADRs.
   - For each closed `human-needed` issue, unblock its tasks.
2. **Pick.** Take the first task that meets all of these; if none does, go to section 2.7.
   - status is `todo`;
   - every dependency is `done`;
   - it isn't blocked;
   - its `not_before` date, if any, has passed.
3. **Branch.** Create `task/<id>-<slug>` and set the status to `doing`.
4. **Build.** Write failing tests from `done_when` first, then the code. Use subagents for independent parts.
5. **Verify.** Run `make verify` plus the task's `verify` command until both are green. Never weaken a gate to get there.
6. **Review.** Run the `reviewer` subagent on `git diff develop...HEAD` and fix every blocking finding.
7. **Commit.** Use Conventional Commits. Set the task to `done`, with evidence, in the same commit. Push the task branch.
8. **Integrate.**
   - Poll CI with short calls (`gh run list --branch <branch> --limit 1 --json status,conclusion`), and start the next independent task while you wait.
   - When CI is green, run `git switch develop && git merge --ff-only task/<id> && git push`. If the fast-forward fails, rebase the task branch on `develop` and let CI run again.
   - When CI is red, fix it. After three failed attempts, follow section 2.5.
   - Until Session 1 creates the GitHub remote, skip pushing. Fast-forward the local `develop` after `make verify` passes, and push everything once the remote exists.
9. **Record.** Update `STATE.md` (one screen at most), then go back to step 1.

### 2.2 Definition of done (every task)
- **Proof.** Every `done_when` item is proven by a test or check that runs in CI, and coverage and mutation floors hold for the touched packages. For `packages/core` the mutation floor is the [ADR-010](../adr/0010-mutation-floor-ratchet.md) ratchet: the score may not fall below the last measured value, and 70% remains the target that CORE-04b closes.
- **Checks.**
  - `make verify` is green.
  - Infrastructure changes also pass `make preflight ENV=dev`: the nag pack passes, KICS finds zero HIGH issues, and the estimator stays at or under 70%.
- **Docs.** The package README is updated, plus an ADR if a decision was made.
- **Clean diff.** 2MS finds nothing, and the diff contains no identifiers or personal data.
- **Integrated.** CI is green on the task branch, `develop` is fast-forwarded, and the ledger and `STATE.md` are updated. Per [ADR-011](../adr/0011-dependency-policy.md) the CI jobs are required status checks on `develop`, so the fast-forward only succeeds for a commit that already carries them — which is the normal case, since the task branch is what ran them.
- **A gate that fails is reported, never edited.** If a `done_when` item cannot be met, say so in the ledger with the measured number. The one thing that is never done is moving the threshold to meet the result.

### 2.3 Decide; don't ask
Settle design questions yourself. Write an ADR in `docs/adr/` (context, options, decision, consequences) and keep going. Precedence:
1. The $0 rules (PED sections 5 and 12) and ADR-005 always win.
2. This file and the ADRs, then the PED, then the PRD. Amend the losing spec in the same change.
3. After that, prefer offline and on-device behavior, then the simplest reversible option, then the option you would have recommended.

Don't use AskUserQuestion for design questions. It stops the loop, and this file already says how to decide.

#### Build the product, not the scaffolding
Work the critical path in order: **CORE, then M1, M2, M3, M4.** The hygiene tasks in the `HYG` block come first because they are finite and they sit in front of that path; after them, the next task is the next product task.

This **overrides file order** in §2.1's "first unblocked task". The ledger is grouped by milestone, so M0A-05 and M0A-06 sit physically above CORE without being ahead of it. Selection order is: `HYG`, then CORE → M1 → M2 → M3 → M4, and the remaining M0a/M0b infrastructure whenever it is a dependency of the next product task or the critical path is blocked. M0A-05 and M0A-06 are unblocked and wanted — see the ADR-008 note below — but they are not ahead of CORE-05.

**Don't add a CI check or a tool unless a task's `done_when` needs it, or an incident proved it necessary.** Both exceptions are real and both have been used — `tools/check_lockfile_maturity.js` exists because dependency updates silently stopped for two days, and the `dependabot.yml` assertions exist because a configured cooldown was found acting on nothing. Neither was added because it seemed prudent. A check with no incident behind it and no `done_when` asking for it is work that looks like progress and is not.

#### Decide more, escalate less
Three patterns that previously stopped the loop, and what to do instead:

- **A dependency major** is a planned task with `done_when` items, never a surprise PR and never a blocker. Dependabot no longer proposes them ([ADR-011](../adr/0011-dependency-policy.md)); when one is wanted, write the task. `TS-6` is the worked example.
- **A threshold that cannot be met yet** becomes a **ratchet plus a deadline task**: set the gate to the current measured value so it can only improve, and create the task that reaches the target, with a dependency that stops the milestone it actually endangers. It is neither a blocker nor a relaxation. [ADR-010](../adr/0010-mutation-floor-ratchet.md) is the worked example; note that a fixed floor far above the current score detects nothing at all, so the ratchet is also the stricter choice.
- **A frozen artifact with a real defect** may be fixed under [ADR-009](../adr/0009-oracle-bug-fixes.md)'s conditions — both implementations in one change, and a corpus that does not move. Reproducing a defect is only correct while it is indistinguishable from a porting bug.

Only §2.4 stop-rule items go to the human. If a decision is reversible, costs nothing, and does not relax a gate, it is yours.

#### ADR-008 is open; build around it
[ADR-008](../adr/0008-free-tier-gate-vs-ped-volumes.md) stays open and stays the human's call. It is not a reason to stop:
- keep the undecided numbers in **exactly one config entry each**, so the decision lands as a one-line change and nothing else moves;
- finish every part of **M0A-05 and M0A-06** that does not depend on the outcome — which is all of it except the estimator's verdict on seven rows;
- leave `make estimate` exiting 1 and say so. The failing gate is the accurate state and is reported, not edited.

### 2.4 Stop rules: these go to the human
When any of the cases below applies:
- open a `human-needed` issue assigned to `@me`, with exact steps and no identifiers or secrets;
- mark the task `blocked`;
- carry on with other work.

The cases:
- An action costs money, upgrades a plan, or accepts third-party terms.
- An account, app, OAuth client or key has to be created, or a secret entered.
- Something would be relaxed: a cost, quality or security gate; the kill switch, a budget or an IAM guardrail; or a PED target. Attach an ADR proposal with evidence.
- A high or critical finding would be suppressed beyond the PED suppression rules.
- Anything would touch prod, or the prod kill switch needs a reset. Only your `develop` -> `main` merge deploys prod.
- Auto mode blocks the same action repeatedly. Also log it in `docs/hitl/QUEUE.md`.

End the session only when every remaining task is blocked or waiting on a date.

### 2.5 When things go wrong
- **CI red three times on one task:**
  - reset the branch and write a short analysis in the task's notes;
  - then either try another approach under a new ADR, or mark the task `needs-rethink` and move on.
- **Flaky test:**
  - quarantine it with an issue that expires within 14 days;
  - never delete or weaken assertions;
  - security-relevant tests can't be quarantined.
- **Provider API change or exhausted quota:** switch the affected tests to recorded fixtures or the simulator, open an issue, and continue.
- **Kill switch or billing alert:**
  - stop all deploy tasks, run diagnostics, and write `docs/reports/incident-<date>.md`;
  - drill workflows may reset dev and stage; only you reset prod.
- **Usage limit or crash:** nothing special; the ledger is the memory. Commit small and often.

### 2.6 Never block on long waits
Tool calls time out, and long waits waste the session.
- Keep local `make` targets under about two minutes.
- Run long suites in CI: emulators, mutation testing, OCR evaluations.
- Poll instead of watching.
- `make verify` must work without Docker. Docker-backed integration tests run in CI, and locally only when Docker is present.

### 2.7 Milestone close and reporting
- **Gate.** When every task in a milestone is `done`, run `make gate M=<id>` and write `docs/reports/<id>.md` with each exit condition and its evidence.
- **Release.** For M0, M4, M7 and M8, open the `develop` -> `main` release pull request with the report, plus a `human-needed` issue asking for the merge.
- **Autopilot log.** Keep one pinned issue called "Autopilot log". Comment on it for each finished milestone and whenever the session stops: what shipped, what is blocked, what's next. It doubles as your email digest.
- **Date-based resumes.** The nightly workflow checks `not_before` dates and soak metrics. When waiting work becomes runnable, it opens a `human-needed` issue that says "Resume: type /autopilot".

---

## 3. Ledger format

`docs/plan/TASKS.yaml` has one entry per task in section 5:
```yaml
- id: M0A-03
  milestone: M0
  title: SetlistZeroCostPack (cdk-nag)
  deps: [M0A-02]
  status: todo            # todo | doing | blocked | done | needs-rethink
  blocked_on: null        # e.g. H1 or "issue #12"
  not_before: null        # ISO date for soak/observation tasks
  done_when:
    - one rule per never-use item in PED section 12, each with a failing and a passing fixture
    - make preflight ENV=dev rejects tests/fixtures/nat-stack with rule SZC-NAT
  verify: make preflight ENV=dev
  evidence: []            # commit SHAs, CI run URLs, metric values
```

`docs/plan/STATE.md` is overwritten each time, never appended:
```markdown
# Autopilot state
Milestone: M0 | Last done: M0A-02 | Next: M0A-03 | Blocked: M0B-* on H1 (issue #3)
Metrics: coverage 91% | text F1 0.94 (synthetic) | free-tier max 41% (Lambda GB-s, prod) | quarantined tests 0
Notes: (5 lines at most)
```

---

## 4. Bootstrap (first session only)
- **B1. Inventory.** Map what already exists to task IDs, and mark a task `done` only with evidence. Create `develop` from the current main branch.
- **B2. ADRs.** Write ADR-001 to ADR-006 from section 1 into `docs/adr/`.
- **B3. Spec edits.**
  - Amend PRD FR-002 and PED sections 9, 10.3, 14, E4 and 18.
  - In the CLAUDE.md block, replace "Before ANY deploy: make preflight" with "Deploys run only in CI; run make preflight before pushing infrastructure changes."
- **B4. Planning files.** Create:
  - `docs/plan/TASKS.yaml`, from section 5, with complete `done_when` for every task;
  - `STATE.md`;
  - `docs/hitl/SESSION-1.md` to `SESSION-4.md`, click by click, without identifiers;
  - `docs/hitl/QUEUE.md`.
- **B5. Claude Code configuration.**
  - Install the files in sections 7.2 to 7.5, plus the four one-line subagents listed after 7.5.
  - Trim `CLAUDE.md` to conventions, commands, the cost-guardrail block and a pointer to this file.
  - Use no git hooks: `.husky` and `.pre-commit-config.yaml` are protected paths, so `make` and CI do the checking.
- **B6. Secret scan.** Scan the full git history with 2MS, because the repo is about to become public. If anything turns up, rewriting history is a `human-needed` item.
- **B7. Your scripts.** Write `scripts/hitl/github-setup.sh`, `session1-finish.sh` and `set-provider-secrets.sh`. Each must pass shellcheck and have a `--dry-run` mode.
- **B8. Hand off.** Tell the human three things:
  - Session 1 is in `docs/hitl/SESSION-1.md` and can be done any time;
  - you'll keep working locally in the meantime;
  - restart Claude Code and type `/autopilot`.

---

## 5. Task graph

`H1` to `H4` are your sessions in section 6. Every milestone gate includes the PED Free-Tier Gate (FTG):
- projected usage at or under 70% of every always-free limit, across all environments;
- $0.00 actual spend;
- nag pack and KICS green.

### HYG: hygiene from ADR-009, ADR-010 and ADR-011 (no AWS, taken first)
Finite, and all of it sits in front of the critical path. After HYG-06 the next task is a product task.

| ID | Task | Deps | Done when |
|---|---|---|---|
| HYG-01 | Stryker `break` becomes the ADR-010 ratchet: set to the last measured score, raised only | none | `make mutate-ts` passes at the current score and fails when the score drops |
| HYG-02 | `normalize_document` made idempotent in both implementations, under ADR-009 | none | one commit, both languages; the U+00B4 U+001F U+1A7F witness a permanent explicit example in both property suites; the property kept; zero corpus outputs move |
| HYG-03 | `dependabot.yml`: ignore all majors, group minor+patch per ecosystem including github-actions, keep the 7-day cooldown | none | `check_workflows.js` asserts each property and fails when one is removed |
| HYG-04 | Auto-merge re-runs on every PR update and disarms anything not patch or minor | HYG-03 | the disarm path provably calls the API; the job is named stably so it can be required |
| HYG-05 | CI jobs become required status checks for PRs into `develop` | HYG-04 | a red build cannot merge by approval alone, **and** a fast-forward push of an already-green commit still succeeds |
| HYG-06 | Lockfile-age check runs on `pnpm-lock.yaml` change and nightly, caches publish dates, retries transient registry errors | none | both must-fail directions still fail; a 5xx-then-success run goes green; unknown age still fails closed |

### M0a: foundations that need no AWS
| ID | Task | Deps | Done when |
|---|---|---|---|
| M0A-01 | Toolchain: pnpm workspaces, uv for the Python parts, strict tsconfig, ESLint/Prettier, ruff/mypy. Makefile targets `verify`, `verify-fast`, `preflight`, `gate`, `golden` | none | `make verify` covers every package in under 5 min without Docker; CI mirrors it |
| M0A-02 | CDK app: `profile` context (zero/enterprise), ProfileAwareFactory, dev/stage/prod configs with the PED section 11 shares. No context lookups; the account comes from the CI session | M0A-01 | `cdk synth` runs offline for both profiles and all three envs |
| M0A-03 | SetlistZeroCostPack (cdk-nag): one rule per never-use item in PED section 12 | M0A-02 | every rule has a failing and a passing fixture; the platform stack passes |
| M0A-04 | KICS zero-cost Rego queries mirroring M0A-03, plus the default KICS catalog on `cdk.out` and the workflows | M0A-02 | positive and negative tests per query; zero HIGH findings on the platform stack |
| M0A-05 | `tools/free-tier-estimate` with `budget.yaml` and `usage-model.yaml`, from PED sections 6, 10.8 and 11 | M0A-02 | fails when any share exceeds 70%; tests reproduce the PED arithmetic (for example, 800 units per 15-song playlist); writes a PR-comment table |
| M0A-06 | Platform and guardrail stacks: provisioned DynamoDB per env, SNS topics, Cognito (free tiers only), CloudFront + Function URL OAC scaffold, SSM parameters, log retention, 7 alarms at most in total. Kill-switch and usage-sentinel Lambdas | M0A-03, M0A-04, M0A-05 | preflight green for every env. Tests prove the kill switch sets concurrency to 0, disables event source mappings and schedules, disables the dev/stage distributions, and records the event |
| M0A-07 | `infra/bootstrap/account-bootstrap.yaml`, CloudFormation you upload in the console. It contains: the GitHub OIDC provider; per-env deploy roles scoped to `environment:<env>`; read-only diagnostics roles; a CloudFormation execution policy and permission boundary that deny the never-use actions; zero-spend and forecast budgets; an IAM-deny budget action on the deploy roles; a billing SNS topic with email; a Cost Anomaly monitor | M0A-03 | cfn-lint and KICS clean; a test asserts the deny list matches PED section 12; every parameter documented |
| M0A-08 | Workflows: `ci` (all branches); `deploy` (develop -> dev -> stage, main -> prod with the tested artifact); `nightly` (2MS on full history, mutation tests, drift, contract canaries, date-based resume issues); `diagnostics`; `sync-secrets`; `kill-switch-drill` (dev/stage); Dependabot auto-merge into develop. Actions pinned to SHAs. KICS and 2MS as blocking gates, Checkmarx One behind `CX_ENABLED`, plus CodeQL, Semgrep, OSV-Scanner and Trivy | M0A-01 | actionlint and KICS clean; every workflow does nothing, safely, while the AWS secrets are absent |
| M0A-09 | `scripts/hitl/*.sh` and `docs/hitl/SESSION-1.md` | M0A-07, M0A-08 | shellcheck clean; `--dry-run` prints every call without running it |
| M0A-10 | Canary fixtures: a NAT-gateway stack and an on-demand DynamoDB stack | M0A-03 | preflight rejects both with named rule IDs |

### CORE: the TypeScript core (ADR-001, ADR-002, ADR-006)
| ID | Task | Deps | Done when |
|---|---|---|---|
| CORE-01 | Freeze the Python core as `tools/oracle-py`, with a CLI | none | reproduces the current golden outputs byte for byte |
| CORE-02 | Seed catalog builder (MusicBrainz, 1 request/s, resumable) | none | about 2,000 rows; ISRCs on at least 80%; variants and non-Latin names present |
| CORE-03 | Truth-first text generator and golden text set (at least 300 cases) | CORE-02 | expected outputs derived only from the seed; deterministic |
| CORE-04 | TS core: zod schemas, normalization, deterministic grammar, span grounding, confidence, dedupe; ESLint purity rule | CORE-01 | matches the oracle on 100% of golden cases and at least 10k generated inputs, except allowlisted differences |
| CORE-04b | `packages/core` mutation score to 70% (ADR-010) | CORE-04 | survivors killed by tests, or excluded with a reason the reviewer agrees is behaviour-equivalent; the ratchet raised to match |
| CORE-05 | Parser side of ADR-002; `sourceKind` added to the contracts | CORE-04 | parser-only orientation at least 90% on bare-dash lines; the 8 original cases unchanged |
| CORE-06 | Conformance on Node and Chromium (Hermes comes in M1-04) | CORE-04 | identical outputs for the full golden set |
| CORE-07 | Retire the oracle | CORE-04b, CORE-05, CORE-06, M1-04 | oracle deleted; frozen fixtures kept; CI green. CORE-04b is a dependency because the TS suite has to be shown to catch regressions *before* the thing currently catching them is deleted |

### M0b: cloud foundations (after H1)
| ID | Task | Deps | Done when |
|---|---|---|---|
| M0B-01 | Verify the bootstrap stack through the diagnostics workflow | H1 | roles, budgets, topic and anomaly monitor all reported |
| M0B-02 | Run `cdk bootstrap` from CI with the custom execution policy | M0B-01 | the execution role carries only the Setlist policy |
| M0B-03 | Deploy platform and guardrails to dev and stage | M0B-02, M0A-06 | smoke tests green |
| M0B-04 | Kill-switch drill in dev (a synthetic billing alert), then reset | M0B-03 | every tagged function reaches concurrency 0 in under 5 min; the reset works |
| M0B-05 | Canary pull request with a NAT gateway | M0A-10, M0B-02 | CI fails with an SZC rule ID; PR closed |
| M0B-06 | Gate M0 and release PR. Prod receives only the guardrails | all M0 | PED M0 exit conditions and FTG pass; you merge |

### M1: app shell and sign-in
| ID | Task | Deps | Done when |
|---|---|---|---|
| M1-01 | Expo app (TypeScript) with the three variants from PED section 9; CI builds three APKs on Linux | CORE-04 | all three install side by side on the CI emulator (Maestro) |
| M1-02 | identity: Cognito sign-in (hosted UI + PKCE), tokens in the secure store | M0B-03 | E2E sign-in against the dev pool, with a test user CI creates |
| M1-03 | bff: Function URL behind CloudFront OAC, JWT verification with cached JWKS, OpenAPI, Schemathesis fuzzing against dev | M0B-03 | no 5xx under fuzzing; unauthenticated calls get 401 |
| M1-04 | Hermes self-test screen (dev variant only) that runs the core conformance suite | M1-01, CORE-06 | Maestro sees ALL PASS on the emulator |
| M1-05 | MobSF static scan of the APK in CI | M1-01 | no high findings |
| M1-06 | Gate M1 | all M1 | PED M1 exit conditions and FTG pass |
| M1-07 | Offline "paste text -> parsed song list" screen in the dev app, running the core on Hermes. No AWS, no sign-in, no OCR | M1-01, CORE-05 | Maestro drives it on the emulator with a fixed input; every item grounded in its span; works in airplane mode |
| TS-6 | TypeScript 6.x, once the pinned Expo SDK supports it (ADR-011) | M1-06 | `tsc --build` clean with no new suppressions; the major-ignore in `dependabot.yml` stays |

### M2: capture and OCR
| ID | Task | Deps | Done when |
|---|---|---|---|
| M2-01 | OCR golden generator (ADR-006) | CORE-02 | at least 600 images across handwriting, print and screenshots, each with ground truth |
| M2-02 | Capture: ML Kit Document Scanner (Android), gallery import, PWA camera, quality checks, EXIF strip and downscale. Includes a dev-only image-injection seam so tests can skip system UI | M1-01 | PED section 14 payload and privacy tests pass |
| M2-03 | On-device OCR: ML Kit v2 on Android (bundled model in CI), Apple Vision on iOS (built on a macOS runner), Tesseract.js in the PWA | M2-02 | each returns lines, boxes and confidence on golden images in CI |
| M2-04 | `ocr-svc`: Python, RapidOCR/ONNX, arm64 zip of 240 MB at most, in memory only, max concurrency 2. Includes payload, bomb and polyglot tests | M0B-03 | p95 under 8 s on 4 MB images in dev; `/tmp` empty after each call; at most 12 GB-s per page |
| M2-05 | OCR evaluation harness producing CER/WER and song-level F1 through the core. Runs on Linux (RapidOCR, Tesseract.js), a macOS runner (Apple Vision through a Swift CLI) and the Android emulator (ML Kit) | M2-01, M2-03, M2-04 | nightly `docs/reports/ocr-eval.md` by engine and image class |
| M2-06 | Real handwriting set encrypted and wired into CI | H3 | decrypts only in CI runs on develop and main |
| M2-07 | Gate M2 | all M2 | PED M2 exit conditions pass: CER at most 5% printed and 20% handwriting on the real set, at most 12 GB-s per page. FTG passes |

### M3: extraction and matching
| ID | Task | Deps | Done when |
|---|---|---|---|
| M3-01 | `packages/contracts`: CloudEvents envelope, versioned zod event schemas, golden samples, generated JSON Schema | CORE-04 | consumer verification tests for every producer |
| M3-02 | extraction service (Node; SNS in and out; idempotent) | M3-01, M0B-03 | no ungrounded songs; replays are idempotent |
| M3-03 | catalog-matching: ISRC first through MusicBrainz (1 request/s token bucket), Deezer fallback, the core normalizer, a DynamoDB cache with TTL | M3-01 | PED match targets on the golden set; the rate limit is never exceeded in tests |
| M3-04 | Orientation resolution (ADR-002 step 5) | M3-03, CORE-05 | post-matching orientation at least 98%; no YouTube units spent on it |
| M3-05 | YouTube provider simulator and recorded fixtures | M3-01 | unit costs identical to the PED (search 100, insert 50) |
| M3-06 | Gate M3 | all M3 | PED M3 exit conditions and FTG pass |

### M4: autonomous YouTube playlists
| ID | Task | Deps | Done when |
|---|---|---|---|
| M4-01 | provider-connection: backend-mediated OAuth; AES-GCM vault with its data key in SSM | H2 | tokens never reach the device; the key-rotation test passes |
| M4-02 | yt-adapter: per-env unit bucket, deferral to 00:05 PT, create/insert/delete | M4-01, M3-05 | never exceeds its share in a simulator soak; defers correctly |
| M4-03 | playlist-orchestration saga: DynamoDB state, compensation, DLQs, redrive | M3-02, M4-02 | exactly one playlist per job under injected faults |
| M4-04 | Autonomous mode end to end | M4-03, M2-03 | stage E2E: an injected scan becomes a private playlist on the test account, is verified, then deleted |
| M4-05 | CodeDeploy canary and rollback drill, in stage with the same config as prod (at most 5 prod alarms) | M4-03 | the rollback fires on the injected fault |
| M4-06 | Gate M4 and release PR | all M4 | PED M4 exit conditions (wrong-song rate under 3%) and FTG pass. The 30-day $0 clock starts; the plan upgrade is a separate decision. You merge |

### M5: offline, push, share
| ID | Task | Deps | Done when |
|---|---|---|---|
| M5-01 | Offline queue (SQLite, UUIDv7 keys) and sync | M1-01 | 10 offline scans produce exactly 10 jobs |
| M5-02 | notification: Expo push through FCM plus an in-app inbox; no song names in payloads | H2, M4-03 | push p95 under 60 s in stage |
| M5-03 | Share intents on Android, and Web Share Target in the PWA on Android. iOS Safari isn't known to support Web Share Target: verify this. If it's absent, iOS PWA users import through the file picker (amend PED US-3) | M2-02 | shared text skips OCR; shared images go through OCR |
| M5-04 | Gate M5 | all M5 | PED M5 exit conditions and FTG pass |

### M6: batch and PWA
| ID | Task | Deps | Done when |
|---|---|---|---|
| M6-01 | `packages/etl` (Python, Glue-compatible) running as a scheduled Lambda. Glue Catalog definitions only; Glue jobs behind the flag | M3-01 | ETL tests pass on DynamoDB Local; no Glue job resources under `profile=zero` |
| M6-02 | Weekly re-match on Step Functions Standard | M3-03 | the estimator shows at most 2,000 transitions per month |
| M6-03 | PWA paste and scan flows (Tesseract.js plus the server fallback) and Web Push. Playwright on Chromium and WebKit | M2-03, M3-02 | green on both engines |
| M6-04 | Gate M6 | all M6 | PED M6 exit conditions and FTG pass |

### M7 (beta) and M8 (GA)
| ID | Task | Deps | Done when |
|---|---|---|---|
| M7-01 | MASVS L1 evidence, MobSF, OWASP ZAP baseline against stage | M6-04 | no high findings |
| M7-02 | Full golden runs including the real set; 14-day soak in stage (`not_before`) | M6-04 | PED section 15 targets met |
| M7-03 | Beta release PR and tester onboarding | H4 | you merge; testers onboarded |
| M7-04 | Gate M7 | all M7 | PED M7 exit conditions pass |
| M8-01 | v1.0.0: APK on GitHub Releases, PWA in prod, release notes, release PR | M7-04 | you merge |
| M8-02 | 30-day observation and final report (`not_before`) | M8-01 | success at least 95%, $0.00 spend, at least 30% headroom |
| SPOT-01 | Spotify adapter, only if H2 records that you have Spotify Premium | M4-03 | the YouTube E2E passes on Spotify with at most 5 users |

---

## 6. Your sessions in full
Before each session is due, Claude Code turns it into `docs/hitl/SESSION-n.md` and a `human-needed` issue.
- Run the scripts in an ordinary terminal in the repo folder, not in the Claude chat.
- After each session, close its issue and type `/autopilot` in Claude Code.

**Session 1: before any cloud work (about 40 min)**
1. **Tools.** Install whatever is missing: git, the GitHub CLI (then run `gh auth login`), Node LTS and uv. Docker is optional.
2. **GitHub.** Run `bash scripts/hitl/github-setup.sh`. It:
   - creates the public repo, or adopts an existing one, and pushes;
   - adds rulesets: `main` requires a pull request and forbids force pushes, and `develop` forbids force pushes;
   - creates the dev, stage and prod environments, with prod limited to `main`;
   - adds the labels, Dependabot auto-merge into develop, and the Actions settings.

   Then restart Claude Code, because auto mode doesn't trust a remote added mid-session.
3. **AWS account.** Create an AWS account on the Free plan, work in us-east-1, and turn on MFA for the root user.
4. **Bootstrap stack.** In the CloudFormation console:
   - Create stack, then upload `infra/bootstrap/account-bootstrap.yaml`;
   - fill in GitHubOwner, GitHubRepo and AlertEmail;
   - acknowledge IAM, then Create;
   - confirm the SNS subscription email.
5. **Alerts.** In Billing -> Preferences, turn on Free Tier usage alerts.
6. **Account ID.** Run `bash scripts/hitl/session1-finish.sh` and paste the account ID. It's stored as a GitHub secret, not in the repo.
7. **Expo.** Create an Expo account and an access token, then run `bash scripts/hitl/set-provider-secrets.sh expo`.

**Session 2: after the first dev deploy (about 45 min)**
1. **Google Cloud** (no billing account needed):
   - create a project and enable YouTube Data API v3;
   - configure the OAuth consent screen: External, scope `youtube.force-ssl`;
   - add yourself and a test account as test users;
   - create three Web OAuth clients using the redirect URIs from the latest deploy job summary.

   Before this session, Claude Code checks Google's current rules on refresh-token expiry in Testing mode and on unverified apps in production. `SESSION-2.md` tells you which publishing status to pick.
2. **Test account.** Create a free Google account for E2E tests, create its YouTube channel, and open the one-time consent link from the stage deploy summary.
3. **Firebase** (free Spark plan):
   - add three Android apps, using the package names in PED section 9;
   - upload the FCM v1 service-account key in Expo, under Project -> Credentials -> Android.
4. **Secrets.** Run `bash scripts/hitl/set-provider-secrets.sh google`. Add `spotify` only if you have Spotify Premium and want Spotify.
5. **Android signing.** Claude Code tries Expo-managed credentials first. If a step needs you, the issue gives you one command; save the keystore and its password in your password manager.
6. **CloudFront plan.** Only if Claude Code couldn't automate it: enroll the prod CloudFront distribution in the flat-rate Free plan (about 2 minutes in the console).

**Session 3: during M2 (about 25 min)**
1. Open `golden/handwriting/ASSIGNMENTS.md`, which has 15 short lists.
2. Copy each list by hand. Mix pens and paper, and cross out the lines marked for crossing out.
3. Photograph each page twice, once in good light and once dim or at an angle.
4. Put the photos in `golden/private/incoming/` (git-ignored) and tell Claude Code. It encrypts them and deletes the plaintext.
5. Optional: two or three friends doing five lists each makes the handwriting numbers more trustworthy.

**Session 4: at beta (about 15 min)**
1. Add tester emails as test users on the Google consent screen, if it's still in Testing. If Spotify is on, add them there too (5 at most).
2. Send the invite Claude Code drafted, with the APK link and the PWA link.

**Releases.** Merge the release pull request when asked: M0, M4, M7 and M8.

**Plan upgrade (new AWS accounts only).** Around month 4-5, Claude Code posts 30 days of $0 evidence. Then switch the account to the Paid plan in the Billing console so it isn't closed at month 6. The always-free limits keep the bill at $0, and the budgets and kill switch stay armed.

---

## 7. Files

### 7.1 `~/.claude/settings.json`: add this `autoMode` block yourself (recommended)
Merge it into whatever is already there. Keep every `"$defaults"` entry: without it, you replace Anthropic's built-in safety rules for that section.

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Organization: personal open-source project Setlist. Primary use: software development.",
      "Repository visibility: the Setlist repository in the working directory is public on GitHub. Its own code and docs are public by design; secrets, credentials, account identifiers and personal data never go into its commits, issues or pull requests.",
      "Cloud provider(s): AWS, reached only through GitHub Actions with OIDC. This machine has no AWS credentials.",
      "CI/CD deploy targets: pushes to develop deploy to the dev and stage environments, which are disposable and zero-cost. Prod deploys only when the human merges develop into main."
    ],
    "allow": [
      "$defaults",
      "Pushing task/* branches and fast-forwarding develop in the Setlist repository is routine, even though CI then deploys develop to dev and stage.",
      "Triggering the Setlist repository's own workflows with gh workflow run against the dev or stage environments (diagnostics, drills, evaluations) is routine.",
      "Creating, labeling, commenting on and closing issues and pull requests in the Setlist repository to report progress or ask the human for help is routine when the text contains no secrets, credentials or account identifiers."
    ],
    "soft_deny": [
      "$defaults",
      "Never make the Setlist zero-cost guardrails more permissive (infra/nag, security/kics-queries, infra/free-tier, the kill switch, budgets, IAM boundaries) and never lower a test, coverage, accuracy or cost threshold unless the user names that specific change.",
      "Never merge pull requests into main or deploy to prod in the Setlist repository: only the human does that."
    ]
  }
}
```

### 7.2 `.claude/settings.json` (project; Claude Code installs it)
Deny rules block these commands in every mode. The hook in 7.3 catches the same commands when they're phrased in ways prefix rules miss.

```json
{
  "permissions": {
    "deny": [
      "Bash(aws *)",
      "Bash(sam deploy *)",
      "Bash(cdk deploy *)",
      "Bash(cdk destroy *)",
      "Bash(npx cdk deploy *)",
      "Bash(npx cdk destroy *)",
      "Bash(pnpm cdk deploy *)",
      "Bash(pnpm exec cdk deploy *)",
      "Bash(git push --force *)",
      "Bash(git push -f *)",
      "Bash(git push --force-with-lease *)",
      "Bash(gh pr merge *)",
      "Bash(gh secret *)",
      "Bash(gh repo delete *)",
      "Bash(gh repo edit *)",
      "Bash(gh release delete *)",
      "Read(./secrets/**)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'root=\"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}\"; exec bash \"$root/.claude/hooks/guard-bash.sh\"'"
          }
        ]
      }
    ]
  }
}
```

### 7.3 `.claude/hooks/guard-bash.sh`
Exit code 2 blocks the call and sends the reason to Claude. An occasional false positive is fine; for example, a commit message that mentions "cdk deploy" gets blocked, so just rephrase.

```bash
#!/usr/bin/env bash
# Autopilot guard for the Bash tool (PreToolUse). Exit 2 blocks; stderr goes to Claude.
input="$(cat)"
if command -v node >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).tool_input||{}).command||""))}catch(e){}})')"
else
  cmd="$(printf '%s' "$input" | python3 -c 'import json,sys
try: sys.stdout.write(str(json.load(sys.stdin).get("tool_input",{}).get("command","")))
except Exception: pass')"
fi

block() { echo "Blocked by the autopilot guard: $1. See docs/plan/AUTOPILOT.md, ADR-005." >&2; exit 2; }
check() { if [[ $cmd =~ $1 ]]; then block "$2"; fi; }

sep='(^|[;&|(`]|\$\()[[:space:]]*'
push='git([[:space:]]+-[cC][[:space:]]+[^[:space:]]+)*[[:space:]]+push'

check "${sep}aws[[:space:]]"                                        "AWS is reached only from CI through OIDC"
check '(cdk|sam)[[:space:]]+(deploy|destroy)'                      "deploys run only in CI"
check "${sep}make[[:space:]][^;&|]*(deploy|destroy)"                "deploys run only in CI"
check "${push}[^;&|]*[[:space:]](-f|--force|\+)"                    "no force pushes"
check "${push}[^;&|]*[[:space:]:](main|master)([[:space:]]|\$)"     "only the human changes main"
check 'gh[[:space:]]+pr[[:space:]]+merge'                           "only the human merges pull requests"
check 'gh[[:space:]]+secret'                                        "secrets are entered only by the human"
check 'gh[[:space:]]+api[^;&|]*(-X|--method)[[:space:]]*DELETE'     "no destructive GitHub API calls"
exit 0
```

### 7.4 `.claude/skills/autopilot/SKILL.md`
```markdown
---
name: autopilot
description: Run the Setlist task ledger unattended until every remaining task is done, blocked, or waiting on a date. Only when the user types /autopilot.
disable-model-invocation: true
---

Follow docs/plan/AUTOPILOT.md section 2 exactly. In short:

1. Sync develop. Read docs/plan/STATE.md, docs/plan/TASKS.yaml and any new ADRs. Unblock tasks whose human-needed issue is closed.
2. Take the first todo task whose deps are all done and whose not_before date has passed. Branch task/<id>-<slug>.
3. Write tests first from done_when, then code. Decide design questions yourself and record an ADR (section 2.3). Don't ask me.
4. Run make verify plus the task's verify until green; never weaken a gate. Run the reviewer subagent and fix its blocking findings.
5. Commit with the ledger update and push the branch. Poll CI in short calls while you start independent work. When green, fast-forward develop and push it.
6. If a stop rule applies (section 2.4), open a human-needed issue assigned to @me with exact steps and no identifiers or secrets, mark the task blocked, and continue.
7. When a milestone's tasks are done, run make gate M=<id> and write docs/reports/<id>.md. For M0, M4, M7 and M8, open the develop -> main release pull request and a human-needed issue asking me to merge.
8. Keep STATE.md to one screen. When nothing is selectable, comment a summary on the pinned "Autopilot log" issue and stop.
```

### 7.5 `.claude/agents/reviewer.md`
```markdown
---
name: reviewer
description: Independent pre-integration reviewer for Setlist task branches. Use before fast-forwarding develop.
tools: Read, Grep, Glob, Bash
---

Review `git diff develop...HEAD` for the task named in docs/plan/STATE.md. Report only blocking issues, each with file:line and a concrete fix. End with APPROVE or CHANGES.

Check that:
1. Every done_when item of the task is proven by a test or check that actually runs in CI.
2. No assertion was deleted or weakened; no threshold, coverage floor, nag/KICS rule or estimator limit was relaxed; no test was skipped without a quarantine issue.
3. Nothing from the never-use list (PED section 12) or any billable API call (ADR-005) was added, and profile=zero is untouched unless the task says otherwise.
4. The diff contains no secrets, account IDs, ARNs, emails, personal data or real user content in code, fixtures, logs or docs. The repo is public.
5. New endpoints validate input, images are never stored server-side, and EXIF/GPS data is stripped.
6. Contract changes are versioned (PED section 10.4) and consumer tests are updated.
7. The change stays within the task; unrelated edits become new tasks.
```

Also create four single-purpose subagents:
- **`cost-auditor`** runs the estimator and checks new resources against PED section 6.
- **`ocr-evaluator`** runs the harness and flags regressions against the last report.
- **`contract-keeper`** checks schema versioning and consumer tests.
- **`mobile-builder`** handles Expo variants, native modules and Maestro flows.
