# Spec amendment changelog

Precedence is [`plan/AUTOPILOT.md`](plan/AUTOPILOT.md) and [`adr/`](adr/) > [PED](PED.md) > [PRD](PRD.md).
When a decision overrides a spec, the losing spec is amended in the same change.

**Every amendment listed here is already applied inline** in [`PRD.md`](PRD.md) and
[`PED.md`](PED.md), marked at its own section with a callout naming the authorising
ADR. This file is the index of what changed and when — not a queue of pending edits.

To add an amendment: change the spec inline, add a callout there, then add a row here.

## Applied 2026-09-29 — PREP-01

| # | Spec | Section | Change | Authority |
|---|---|---|---|---|
| 1 | PRD | FR-002 | Line orientation is **inferred, not fixed**. Explicit cues, then document convention, then a source-kind prior (`scan_*`/`screenshot` → title first; `paste`/`file` → artist first); below 0.8 the parser emits an `alternate`. Adds orientation-accuracy acceptance criteria (≥90% parser-only, ≥98% post-matching). | [ADR-002](adr/0002-line-orientation.md) |
| 2 | PRD | §1 Executive summary | Bedrock off by default; one AWS account rather than Organizations; Node/TypeScript rather than Python for Lambdas. | [PED](PED.md) D9/D15, [ADR-004](adr/0004-language-map.md) |
| 2a | PRD | §4 Assumptions | Three assumptions superseded where the list reads as settled and would otherwise be acted on: AWS Organizations → one account; Python Lambdas → Node/TypeScript except `services/ocr` and `packages/etl`; Bedrock in the default extraction path → behind a flag. CDK, GitHub Actions + OIDC and the per-environment provider apps are unchanged. | [PED](PED.md) D9/D15, [ADR-004](adr/0004-language-map.md) |
| 3 | PRD | §2 Non-goals | NG4 reversed — image/screenshot OCR is the PED's headline use case, not a later phase. | [PED](PED.md) §2–4 |
| 4 | PRD | §4 Platform constraints | Apple Music and Amazon Music out of scope at $0; Spotify conditional on owner Premium. Capability data retained. | [PED](PED.md) §2, D17–18 |
| 5 | PRD | §5 FR-003 / FR-012 / FR-015 | Bedrock and Glue moved behind flags; OCR promoted to Must. **Span grounding unchanged** and reinforced. | [PED](PED.md) D8/D9, [ADR-007](adr/0007-deterministic-core-and-span-grounding.md) |
| 6 | PRD | §6 NFR-003/004/007 | Availability 99.9% → 99.5%; KMS CMK → SSM SecureString; standalone WAF → CloudFront flat-rate Free plan; cost target $0.02 → **$0.00**. | [PED](PED.md) D2/D7, §8 |
| 7 | PRD | §7 System architecture | §7.1–7.6 and §7.12 marked superseded by [PED §10](PED.md#10-microservices-architecture) (the enterprise-profile design). §7.7–7.11 explicitly retained as current: data model, adapter contract, extraction, matching, rate limiting. | [PED](PED.md) §10 |
| 7a | PRD | §7.7 Data model | The single-table design, key layout, GSIs and TTLs stand. Two storage choices change: the table becomes **provisioned** (≤17 WCU/RCU account-wide) with a per-service `LeadingKeys` prefix, and the KMS CMK becomes an AES-256-GCM data key in an SSM SecureString. The argument against per-user Secrets Manager secrets is unchanged and now stronger. | [PED](PED.md) D6, D7 |
| 8 | PRD | §7.8 | Adapter interface is TypeScript, not a Python `Protocol`. Contract and verified capability values unchanged. | [ADR-004](adr/0004-language-map.md) |
| 9 | PRD | §7.9 | Algorithm unchanged; home moves to `packages/core` (TypeScript + zod). Two refinements made explicit: spans index **normalized** text, and the grounding gate needs a **span-size cap** as well as token coverage. | [ADR-001](adr/0001-parser-home-typescript-core.md), [ADR-007](adr/0007-deterministic-core-and-span-grounding.md) |
| 10 | PRD | §7.10 | Adds orientation resolution against free catalogs before any provider call, costing zero YouTube quota. MusicBrainz rate limiting becomes load-bearing for correctness. | [ADR-002](adr/0002-line-orientation.md) |
| 11 | PRD | §8 Environments | One account, per-env stacks — joining an Organization expires Free Tier credits. LocalStack → moto + DynamoDB Local + ElasticMQ. | [PED](PED.md) D15/D19, §11 |
| 12 | PRD | §9 CI/CD | AppConfig → SSM; synthetic canaries dropped; CodeDeploy canary prod-only. Branch policy fixed: agents push `task/*` and fast-forward `develop`; only the human merges `main`. | [PED](PED.md) §13, [ADR-005](adr/0005-credentials-branches-deploys.md) |
| 13 | PRD | §10 Testing | Vitest/fast-check/aws-sdk-client-mock for TS, pytest/Hypothesis for the Python exceptions. Mutation targets raised. FIS → flag-based faults. Golden sets generated truth-first. **Regression-gating reasoning retained verbatim.** | [ADR-004](adr/0004-language-map.md), [ADR-006](adr/0006-test-data.md) |
| 14 | PRD | §11 Metrics | Availability 99.5%, cost/playlist $0.00, MTTR <4 h. Extraction and matching targets retained — they are what the accuracy gate enforces. | [PED](PED.md) §15 |
| 14a | PRD | §11 Testing/quality | Mutation floor raised from ≥60% core to **Stryker ≥70% core / ≥65% elsewhere, mutmut ≥70%**, matching the floors CLAUDE.md actually enforces. | [PED](PED.md) §14, [ADR-004](adr/0004-language-map.md) |
| 15 | PRD | §12 Phases | Phase 0–9 replaced by M0–M8 with a Free-Tier Gate at every exit; M0 split at the credential boundary. Apple and Amazon phases cut. | [PED](PED.md) §16, [ADR-003](adr/0003-build-order-m0-first.md) |
| 16 | PRD | §13 Risks | R2 (YouTube quota) becomes the binding constraint on the whole product; its mitigation is load-bearing rather than an optimisation. | [PED](PED.md) §17 |
| 17 | PRD | §14 Security | WAF/KMS/Secrets Manager substitutions. **Every provider compliance obligation unchanged.** Adds: no server-side image retention, EXIF/GPS stripped twice, identifiers-only event payloads. | [PED](PED.md) D2/D7/D10–11, §10.6 |
| 18 | PRD | §15 Implementation guide | Layout expanded; `packages/core` is TypeScript; the hook is a **blocking guard**, not a formatter or preflight wrapper; secrets to SSM. **Guardrail list unchanged and still in force.** | [PED](PED.md) §18, [ADR-005](adr/0005-credentials-branches-deploys.md) |
| 19 | PRD | §16 Open questions | Amazon/Apple resolved (out of scope); region resolved (us-east-1); Bedrock moot while flagged off. Threshold calibration still open. | [PED](PED.md) §11 |
| 20 | PED | §4 US-3 | Flagged pending verification: iOS Safari Web Share Target support is unconfirmed; if absent, iOS PWA users import via the file picker. | [ADR-003](adr/0003-build-order-m0-first.md), task M5-03 |
| 21 | PED | §7 FR-M-007/008 | The parser is `packages/core` (TypeScript + zod), one grammar for device, PWA and Node Lambdas. FR-M-008's substring rule is subsumed by the stronger grounding gate. FR-M-011 additionally requires a resolved orientation. | [ADR-001](adr/0001-parser-home-typescript-core.md), [ADR-002](adr/0002-line-orientation.md) |
| 22 | PED | §9 | `packages/core` is also imported by `services/extraction` and `services/catalog-matching` as Node Lambdas. Hermes parity proven by the M1-04 self-test screen. | [ADR-001](adr/0001-parser-home-typescript-core.md) |
| 23 | PED | §10.3 | Runtime language made explicit: Node/TypeScript default; Python only for `ocr` and `packages/etl`. `extraction` and `catalog-matching` import the core rather than reimplementing it. | [ADR-004](adr/0004-language-map.md), [ADR-001](adr/0001-parser-home-typescript-core.md) |
| 24 | PED | §10.4 | Contracts are zod-first; JSON Schema generated from them for Python consumers. | [ADR-004](adr/0004-language-map.md) |
| 25 | PED | §10.6 | CloudWatch `GetMetricData` and Logs Insights banned alongside Cost Explorer — billed per call, so a monitoring loop would break the guarantee it watches. | [ADR-005](adr/0005-credentials-branches-deploys.md) |
| 26 | PED | §13 | 2MS additionally runs locally over full history in `github-setup.sh` before the first push, failing closed. `check_no_secrets.py` is an additional CI check, not a substitute. | [ADR-005](adr/0005-credentials-branches-deploys.md), task PREP-03 |
| 27 | PED | §14 | Test stack follows the language map; Stryker ≥70% core / ≥65% elsewhere; golden sets generated truth-first from a MusicBrainz seed. | [ADR-004](adr/0004-language-map.md), [ADR-006](adr/0006-test-data.md) |
| 28 | PED | §15 | Adds orientation targets: ≥90% parser-only, ≥98% post-matching, zero YouTube units spent. | [ADR-002](adr/0002-line-orientation.md) |
| 29 | PED | §16 | M0 split into M0a / CORE / M0b at the credential boundary. | [ADR-003](adr/0003-build-order-m0-first.md) |
| 30 | PED | §18 E4 | The `1. Wonderwall – Oasis` example gains an explicit `sourceKind`, plus a second case showing the paste path resolving through MusicBrainz. | [ADR-002](adr/0002-line-orientation.md) |
| 31 | PED | §18 CLAUDE.md block | "Before ANY deploy: `make preflight`" → "Deploys run only in CI; run `make preflight` before pushing infrastructure changes." | [ADR-005](adr/0005-credentials-branches-deploys.md) |
| 32 | PED | §18 Tooling | The `PreToolUse` hook is `guard-bash.sh`, which blocks outright rather than wrapping preflight. Adds the `reviewer` subagent and the `/autopilot` and `/run-accuracy` skills. Adds `tools/test-guard-hook.sh` to `make verify`. | [ADR-005](adr/0005-credentials-branches-deploys.md) |

| 33 | PED | §10.8 arithmetic | **"CloudFront Free plan: 700,000 requests ÷ 20 per session ≈ 35,000 scans"** counts scans only. Review sessions cost 15 CloudFront requests each and fallback OCR pages 2, so the three together bind well before 35,000 scans — at the modelled ratios the ceiling is ~28,700 scans, and the planned volume is 28,000. The 700,000 figure itself is unchanged and correct: it is 70% of the flat-rate plan's 1,000,000. | [ADR-008](adr/0008-free-tier-gate-vs-ped-volumes.md) |
| 34 | PED | §11 volumes | Planned monthly playlists cut from prod 250 / stage 50 / dev 30 to **236 / 50 / 16**, each being the largest value that keeps every row it feeds under its threshold. prod 250 was 95.2% of the YouTube quota against a 90% provider gate; dev 30 was 160%, which also made dev unable to create a playlist at all. | [ADR-008](adr/0008-free-tier-gate-vs-ped-volumes.md) |

## Provenance

Neither spec was authored in this repository. Both were transcribed on 2026-09-29 from
the sources supplied on 2026-09-28 — the PRD from its PDF, the PED from its markdown.
Each file says so at the top. If a cleaner original exists, replace the file wholesale:
nothing is generated from either document, and the amendment callouts are the only
content that would need reapplying.
