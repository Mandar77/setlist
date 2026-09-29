# Documentation

**Precedence: [`plan/AUTOPILOT.md`](plan/AUTOPILOT.md) and [`adr/`](adr/) > [PED](PED.md) > [PRD](PRD.md).**
When they conflict, the losing spec is amended in the same change and the amendment is
logged in [`spec-amendments.md`](spec-amendments.md).

| File | Purpose |
| --- | --- |
| [`PRD.md`](PRD.md) | Base product requirements (v1.0, 2026-09-23). Largely superseded on architecture; §7.7–7.11 remain the current behavioural spec |
| [`PED.md`](PED.md) | Zero-budget + mobile expansion (v1.0, 2026-09-28). **Outranks the PRD** |
| [`spec-amendments.md`](spec-amendments.md) | Changelog of what was amended, where, and under which ADR |
| [`plan/AUTOPILOT.md`](plan/AUTOPILOT.md) | How work is chosen and done |
| [`plan/TASKS.yaml`](plan/TASKS.yaml) | The ledger — the authoritative task decomposition |
| [`plan/STATE.md`](plan/STATE.md) | Where the loop currently is |
| [`hitl/`](hitl/) | The four human sessions, click by click, plus the durable queue |
| [`adr/`](adr/) | Architecture decision records |
| `reports/` | Milestone gate evidence, written at each `make gate M=<id>` |

## Reading order

New to the project: [`../README.md`](../README.md) → [`PED.md`](PED.md) §2 and §5 →
[`adr/`](adr/) in order → [`plan/TASKS.yaml`](plan/TASKS.yaml).

The PRD is worth reading for §7.7–7.11 — the data model, the provider adapter contract
and its verified capability table, and the extraction, matching and idempotency
algorithms. Those are behaviour rather than service selection, so the PED does not
restate them and they are still what gets built.

## Provenance

Both specs were transcribed into this repository on 2026-09-29 from the sources
supplied a day earlier — the PRD from its PDF, the PED from its markdown. Neither is
generated from anything, so if a cleaner original exists it can replace the file
wholesale; only the inline amendment callouts would need reapplying.

## Open questions carried from the specs

Tracked here so they are not lost; each gets an ADR as it is answered.

1. Does the owner hold Spotify Premium? (Gates the Spotify adapter entirely — asked in [Session 2](hitl/SESSION-2.md).)
2. Is the AWS account new (post-2025-07-15, credits) or legacy (perpetual free tier)? (Asked in [Session 1](hitl/SESSION-1.md).)
3. Are sub-cent S3 charges invoiced once credits run out?
4. Is Google verification required for the `youtube` scope, and how long does it take?
5. Is published handwriting OCR accuracy representative of our golden set? (Measured at M2.)
6. Should dev move to a second Region for more DynamoDB headroom?
7. Will Checkmarx offer a trial or OSS licence?
8. Is the MusicBrainz 1 req/s limit still current?
9. Final confidence thresholds after the first golden-set calibration. (PRD §16; the values live in one module so recalibration is a single diff.)
