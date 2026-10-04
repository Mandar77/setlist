# ADR-008 — The 70% CI gate and the PED's own volume targets contradict each other

- **Status:** **Proposed** — needs a human decision (AUTOPILOT §2.4)
- **Date:** 2026-09-30
- **Context:** PED §10.8, §11; `infra/free-tier/budget.yaml`; `infra/free-tier/usage-model.yaml`; task M0A-05
- **Raised by:** the first run of `tools/free-tier-estimate`, which is the tool M0A-05 asked for

## Context

`make estimate` projects the usage model against the budget and fails above
`gate_pct: 70`. Its first run fails on seven rows. None of them is a tool defect — the
arithmetic reproduces the PED's own stated figures — so the conflict is between two
numbers the project already holds, and resolving it is not a change I can make.

`budget.yaml` states both of these, twelve lines apart:

> `gate_pct: 70 # CI fails above this share of any allowance`

> `A 15-song playlist costs 50 + 15*50 = 800 units, so prod's 7000/day is ~8
> playlists/day (~250/month). This is the binding constraint on the whole system.`

The second sentence sizes prod at 250 playlists a month. That is 200,000 units a month,
6,667 a day — **95.2% of prod's 7,000/day share**. The volume target and the gate cannot
both stand.

## The evidence

Measured, not estimated — `make estimate` on the committed data:

| Limit | Env | Projected | Share | Used | Where it comes from |
| --- | --- | --- | ---: | ---: | --- |
| `youtube_units_per_day` | dev | 800 | 500 | **160.0%** | 30 playlists/mo × 800 units ÷ 30 d |
| `youtube_units_per_day` | prod | 6,667 | 7,000 | **95.2%** | 250 playlists/mo, the PED's own target |
| `youtube_units_per_day` | stage | 1,333 | 1,500 | **88.9%** | 50 playlists/mo |
| `cloudwatch_logs_gb` | stage | 0.50 | 0.60 | **83.3%** | `baseline.stage`, declared not derived |
| `cloudwatch_logs_gb` | prod | 2.0 | 2.50 | **80.0%** | `baseline.prod`, declared not derived |
| `cloudwatch_logs_gb` | dev | 0.30 | 0.40 | **75.0%** | `baseline.dev`, declared not derived |
| `cloudfront_requests` | prod | 732,000 | 1,000,000 | **73.2%** | 30k scans × 20 + 8k reviews × 15 + 6k OCR × 2 |

Three distinct problems are tangled together here.

### 1. dev cannot create a single playlist — the one real bug

dev is allotted 500 YouTube units a day. One 15-song playlist costs 800. **A developer
cannot create one playlist in a day without exceeding dev's share**, and the first
symptom would be a `quotaExceeded` from YouTube that looks like a code defect.

This one is not a gate-tuning question. 500 is below the cost of the smallest unit of
work the product does, so it is wrong at any gate percentage. stage, at 1,500/day, buys
one playlist a day and change.

### 2. prod is deliberately sized at 95% of a quota that cannot be bought

This is a real decision, not an oversight: PED §11 chose 250 playlists/month *because*
that is what 7,000 units/day buys. The reserve (1,000 units/day) exists for exactly this
pressure. But a CI gate at 70% of the share then fails every build, which means either
the gate never applies to provider quotas, or the volume target is aspirational rather
than budgeted.

Worth stating plainly: YouTube's quota cannot be purchased, and the default allocation
is 10,000 units/day for the whole project. 250 playlists a month is the product's
ceiling until a quota increase is granted. That is a product fact, not a config value.

### 3. `cloudwatch_logs_gb` and CloudFront are forecast-versus-budget mismatches

`baseline` declares prod 2.0 GB of log ingest against a 2.5 GB share — 80% consumed by
standing overhead before any traffic. And `cloudfront.prod.planned_requests` says
350,000 while the usage model implies 732,000; one of the two was written down and never
revisited. The estimator reports both as drift rather than picking the friendlier one.

## Options

Not mutually exclusive — (A) is needed regardless.

| | Change | Effect | Cost |
| --- | --- | --- | --- |
| **A** | Raise dev's YouTube share to ≥ 800/day (say 1,600, two playlists), taking it from `reserve` | dev can do its job | Reserve drops from 1,000 to ~200/day unless prod or stage give some back |
| **B** | Exempt `provider_limits` from `gate_pct`, gating them at `trip_pct` (85%) or not at all | The gate stops failing on the constraint the PED deliberately sized to | Weakens the gate on the limit that binds first — the opposite of where it is wanted |
| **C** | Add a per-limit `gate_pct` override in `budget.yaml`, so YouTube can gate at 97% while AWS stays at 70% | Keeps a real gate everywhere, acknowledges that a hard quota is budgeted differently from an elastic allowance | A second number per limit to maintain |
| **D** | Cut the prod volume target to ~180 playlists/month (70% of 7,000/day) | The gate stands as written | Caps the product below the PED's stated capability |
| **E** | Re-cut the `cloudwatch_logs_gb` split and `cloudfront.planned_requests` to match the model | Removes rows 4–7 | Reserve absorbs it; no product change |

**My recommendation: A + C + E.** (A) is a straight bug fix. (C) keeps the gate
meaningful rather than switching it off for the one quota that actually binds — a hard
daily quota with a reserve behind it is genuinely a different thing from an elastic
monthly allowance, and saying so in one field is better than pretending they are alike.
(E) is bookkeeping that should happen either way. (D) is a real option but it trades
away product capability to satisfy a threshold that was never chosen with provider
quotas in mind, and (B) removes the gate exactly where it is most needed.

## 2026-10-03: the decided rule, computed — and the four rows it does not reach

The human's decision was: **planned volumes follow from the gate.** Set each of the three
contested volumes to the largest value that keeps every row it feeds at or under 70% of
its free-tier share; compute it, do not round up. Provider-quota rows cannot produce a
bill, so judge those at 90% instead, enforced at runtime by the unit bucket. Then
`make estimate` must exit 0 — and if a row still fails after that, stop rather than guess.

Computed, with the arithmetic cross-checked against the estimator itself (at the
committed volumes it reproduces 95.2% / 88.9% / 160.0% exactly, so the model below is the
same model the gate uses):

| Env | Largest volume | Exact | Bound by |
| --- | ---: | ---: | --- |
| prod | **236** | 236.25 | `youtube_units` at 90% |
| stage | **50** | 50.63 | `youtube_units` at 90% |
| dev | **16** | 16.88 | `youtube_units` at 90% |

All three are bound by the YouTube unit quota at the 90% provider threshold, which is
what the exception anticipated. Every AWS row these volumes feed — Lambda, DynamoDB, SNS,
X-Ray — stays far below 70% at those numbers.

**`make estimate` would still exit 1, on four rows, and none of them is fed by a playlist
volume:**

| Row | Share | Fed by |
| --- | ---: | --- |
| prod `cloudwatch_logs_gb` | 80.0% | `baseline.prod`, a declared constant |
| stage `cloudwatch_logs_gb` | 83.3% | `baseline.stage`, a declared constant |
| dev `cloudwatch_logs_gb` | 75.0% | `baseline.dev`, a declared constant |
| prod `cloudfront_requests` | 73.2% | `on_device_scan` × 20, `review_session` × 15, `server_ocr_page` × 2 |

`playlist_job_15_songs` emits eight metrics and neither `cloudwatch_logs_gb` nor
`cloudfront_requests` is among them. The three log rows are fixed monthly overheads that
exist before any traffic at all; the CloudFront row is driven by scans and review
sessions. **No value of the three contested volumes — including zero — moves any of these
four rows.** They are option (E) in the table above, which is bookkeeping rather than a
volume decision, and it was never folded into the rule.

So the rule is applied as far as it reaches and no further. Per the instruction, this is
shown rather than guessed at: adopting 236 / 50 / 16 would take the failures from seven
to four and `make estimate` would still exit 1, so the stated success condition cannot be
met by this rule alone.

**What is still needed, and it is small.** Option (E): re-cut `cloudwatch_logs_gb` in
`budget.yaml` so each environment's share covers its own declared baseline with headroom,
and reconcile `cloudfront.planned_requests` with the model — the estimator already
reports that drift separately (prod declares 350,000 against a modelled 732,000). Both
are numbers in `budget.yaml`, neither changes the product, and together they are the
difference between four failing rows and zero.

## What I did not do

I did not edit `budget.yaml` or `usage-model.yaml` to make the gate pass. Per
CLAUDE.md, relaxing a cost gate or a PED target is a `human-needed` issue with an ADR
proposal — never a quiet edit. The estimator is finished and its tests pass; M0A-05 is
`blocked` on this decision rather than `done`, and `make estimate` correctly exits 1
until it is made.

## Consequences

- Until this is decided, `make preflight` fails, so no infrastructure change can be
  pushed. That is the gate working, but it does block M0A-06 onward.
- Whichever option is chosen, the numbers change in `budget.yaml` only. The estimator
  reads them; it has none of its own.
