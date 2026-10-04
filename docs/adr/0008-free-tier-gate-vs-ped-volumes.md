# ADR-008 — The 70% CI gate and the PED's own volume targets contradict each other

- **Status:** **Accepted** — decided 2026-10-03, applied in full 2026-10-04
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

## 2026-10-04: applied in full — `make estimate` exits 0

The decision above reached three of the seven rows. This is what closed the other four,
and one of them needed more than the bookkeeping the previous section expected.

**The provider threshold is now a field, not a special case.** `budget.yaml` gains
`provider_gate_pct: 90` beside `gate_pct: 70`, and the estimator picks between them on a
row's existing `scope`. This is option (C) narrowed: a threshold per *kind* of limit
rather than per limit, so it has to be argued once and then applies to every provider
quota including ones added later — a per-row override would let any inconvenient limit be
moved one at a time. `estimate.test.ts` checks the containment as well as the behaviour:
an AWS row at 89% still fails, and so does a provider row at 95%.

**Volumes, as decided:** prod 250 → **236**, stage 50 (unchanged), dev 30 → **16**.

**`cloudwatch_logs_gb`, option (E) as written:** each share now covers its own declared
baseline with 30% headroom — prod 2.5 → 2.9, stage 0.6 → 0.75, dev 0.4 → 0.45, reserve
1.5 → 0.9. No product change; the reserve absorbs it.

**prod `cloudfront_requests` needed more than reconciliation, and this is the correction
to the section above.** That section said the remaining work was to "reconcile
`cloudfront.planned_requests` with the model". Reconciling the *declared forecast* removes
the drift warning but not the breach: the row was 732,000 of 1,000,000, and 1,000,000 is
the flat-rate plan's own inclusion rather than a share this project allocates, so no
re-cut can move it.

What moved it was the same rule the decision states — planned volumes follow from the
gate — applied to the volumes that actually feed the row. They are not the playlist
volumes, which is why the earlier pass missed them: scans cost 20 CloudFront requests
each, review sessions 15 and fallback OCR pages 2.

> 28,000 × 20 + 7,400 × 15 + 5,600 × 2 = **682,200**, which is 68.2% of 1,000,000.

The exact ceiling at those ratios is 28,688 scans (699,984, or 69.9998%). Round numbers a
little under it are taken deliberately: every operation feeding this row is
`confidence: estimated` and is due to be measured at M4, and sizing to four significant
figures of an unmeasured number would turn the first real measurement into a gate failure.

This contradicts **PED §10.8**, which derives "about 35,000 scans" from the same 700,000
by counting scans alone. The PED is amended inline and logged as amendments 33 and 34 in
`docs/spec-amendments.md`. Its 700,000 figure is itself unchanged and was always right —
it is 70% of 1,000,000, which is this gate applied to this plan.

### Still open, and deliberately not fixed here

**Option (A) — dev cannot burst a single playlist — is untouched.** dev's share is still
500 YouTube units a day and one 15-song playlist still costs 800. The gate passes because
16 playlists a month averages 427 units a day, and an average is not what a developer
hits when they press the button once. The decision recorded above was about volumes and
did not re-split the quota, and re-splitting it is a cost decision rather than arithmetic,
so it is raised as a `human-needed` issue instead of being taken here. The ADR's own
recommendation that "(A) is needed regardless" still stands.

## Consequences

- `make estimate` exits 0, so `make preflight` can run and M0A-06 is unblocked.
- The gate still binds: prod is at 89.9% of the YouTube quota, and a single extra
  playlist a month puts it over.
- The product is smaller than the PED described — 236 playlists and 28,000 scans a month
  in prod rather than 250 and 35,000. That is the gate doing its job rather than a
  regression, and it is now written down in both specs.
- Two thresholds exist where there was one. The risk is that "provider" becomes a place
  to put inconvenient limits, which is why the scope is derived from the budget's own
  sections and a test pins CloudFront — the nearest neighbour — to the AWS gate.
