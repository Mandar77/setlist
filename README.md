# Setlist

Turn a photo of a handwritten setlist, a festival flyer, a screenshot or a pasted
Reddit thread into a playlist — without typing anything.

Android-first (Expo) plus a PWA for iOS, on a serverless backend that runs on a
**single AWS account at a hard $0/month**.

> **Status: M0 (foundations).** The extraction core is built, tested and gated. The
> AWS infrastructure, the 13 microservices, the mobile app and the PWA are not yet
> implemented — see [Roadmap](#roadmap).

## What works today

`packages/core` — the deterministic extraction engine, offline and dependency-light:

```python
from setlist_core import extract_deterministic

result = extract_deterministic("""
1. Daft Punk - One More Time
2. Justice – Genesis (Extended Mix)
3. "Midnight City" by M83
[00:14] Fred again.. - Delilah (pull me out of this)
""")

for item in result.items:
    print(f"{item.confidence:.2f}  {item.artist} — {item.title}")
```

```
0.92  Daft Punk — One More Time
0.87  Justice — Genesis          (qualifiers: extended)
0.97  M83 — Midnight City
0.92  Fred again.. — Delilah (pull me out of this)   (timestamp: 14s)
```

It handles numbered and bulleted lists, DJ cue sheets, CSV/TSV and markdown tables,
quoted titles, `Title by Artist`, featured-artist credits, version qualifiers, ISRCs,
run times, Unicode normalization and transliteration — and deduplicates repeats.

**Every item is span-grounded.** An extracted song carries a character range into the
source text, and anything whose span does not actually support it is rejected rather
than shown. That is what makes "no hallucinated songs" a property of the system rather
than a hope about a model, and it applies equally to LLM output when that path is
enabled.

Whatever the rules cannot read becomes `result.residual` — the only text an LLM ever
sees.

## Getting started

Requires Node 20+, Docker (for the security scanners) and nothing else — `uv` fetches
the pinned Python 3.13 itself.

```bash
pip install uv          # one time
make setup              # Python 3.13 + all workspace packages
make verify             # the full local gate: lint, types, 233 tests, accuracy, hygiene
```

> **Windows note.** `make` is not on this machine's PATH, but GNU Make is present as
> `mingw32-make` (`C:/MinGW/bin`). Either add an alias once —
> `echo "alias make=mingw32-make" >> ~/.bashrc` — or substitute `mingw32-make` in the
> commands below. CI runs on Linux with real `make`, so the Makefile is the single
> definition either way.


## Layout

| Path | Contents |
| --- | --- |
| `packages/core/` | Extraction domain core — pure, offline, no AWS |
| `packages/{contracts,etl,api-client}/` | Event schemas, ETL job bodies, typed client |
| `services/` | 17 deployable Lambda microservices (one directory each) |
| `infra/` | CDK, the `SetlistZeroCostPack` nag pack, free-tier budget data |
| `mobile/`, `web/` | Expo app and the React PWA |
| `tools/`, `security/` | Free-tier estimator, provider simulator, KICS queries |
| `golden/` | Accuracy corpora (**pointers only** — this repo is public) |

## The $0 constraint

This is a design constraint, not an aspiration. Accounts opened after 2025-07-15 get
time-limited credits — not a perpetual free tier — on API Gateway, S3, EventBridge
custom buses, Step Functions Express, Glue, Athena, Textract, Bedrock, standalone WAF
and Secrets Manager. So the architecture routes around all of them: Lambda Function
URLs behind CloudFront, SNS as the event bus, provisioned DynamoDB, SSM for secrets,
on-device OCR, and a deterministic parser in place of Bedrock.

Four layers keep it there: a CI policy gate (cdk-nag + KICS) that fails `synth`, no
idle-billing resources by construction, runtime concurrency caps, and a zero-spend
budget wired to a kill switch. `infra/free-tier/budget.yaml` is the single source of
truth that both the CI estimator and the runtime sentinel read.

The binding constraint is not AWS — it is YouTube's 10,000 units/day, which works out
to roughly 250 playlists/month in production.

## Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| M0 | Foundations: CI gates, free-tier model, extraction core | core done; CDK + estimator pending |
| M1 | Expo shell, 3 variants, `bff` + `identity` | not started |
| M2 | Capture + OCR (on-device, server fallback) | not started |
| M3 | Extraction + matching services, event contracts | core done |
| M4 | Autonomous YouTube playlist creation | not started |
| M5 | Offline queue, push, share intents | not started |
| M6 | Batch ETL, weekly re-match, PWA | not started |
| M7–M8 | Beta, GA | not started |

Apple Music, Amazon Music and native iOS are out of scope at $0. Spotify is
conditional on the owner holding Premium (dev mode caps the app at 5 users).

See [`CLAUDE.md`](CLAUDE.md) for conventions and the non-negotiable cost guardrails,
and [`docs/hitl/`](docs/hitl/) for the manual steps no agent can do.
