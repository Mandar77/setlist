# Autopilot state

Milestone: M1 | Last done: M1-01, M1-07 | Next: **10 tasks selectable** — HYG-08/09/10, M0A-11, CORE-04b, M1-04, M1-05, M2-02, M2-05a, M5-01 | Blocked: 34, nearly all on H1

Metrics: coverage 96.0% stmts / 90.7% branches (`packages/core`), 95% Python core | Stryker 55.4%, an [ADR-010](../adr/0010-mutation-floor-ratchet.md) ratchet with 70% carried to CORE-04b | extraction F1 0.985 clean (P=0.988 R=0.982) | OCR golden 620 images, 1,719 of 1,977 seed rows drawable | free-tier worst row 89.9% of prod's YouTube quota against a 90% provider gate | quarantined tests 0 | `make verify` ~90s

Notes:

- **[ADR-012](../adr/0012-builds-without-eas.md): builds need no EAS**, so M1-01 and M1-07
  are done and the mobile path is unblocked. `expo prebuild` + Gradle produces the same
  native project with no account. EAS returns only for EAS Update (M1-08, issue #18, off the
  critical path). **A real release keystore is now ours to create** — SESSION-2 §6.
- **[ADR-013](../adr/0013-dynamodb-fixed-capacity.md): DynamoDB capacity goes fixed** (M0A-11).
  Autoscaling creates CloudWatch alarms at runtime, outside the template, where neither the
  alarm budget nor the never-use test can see them — and `never-use.test.ts`'s capacity-cap
  test was already asserting nothing, looping over a resource type `TableV2` never emits.
- **develop is RED at `22b81c7`** ([run 37220493983](https://github.com/Mandar77/setlist/actions/runs/37220493983)),
  on a Maestro flake, not the app: the job runs two `maestro test` invocations and the
  second's device driver died before its first command. Same commit is green on the task
  branch. HYG-10 fixes it — one driver session — and makes the job conditional and cached.
- **Issues #17 and #19 are closed**; #17 became HYG-08 (the Stryker verdict is untrustworthy,
  so HYG-07's survivor comparison cannot be made), #19 was closed as intended — dev uses the
  provider simulator and never makes a live YouTube call.
- **Long-form history lives in [`reports/journal.md`](../reports/journal.md)**, including the
  seven instruments found reporting success while doing nothing. This file is capped at one
  screen on purpose (§3); HYG-09 makes `check_ledger.py` enforce that and the evidence limit.
