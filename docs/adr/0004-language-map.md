# ADR-004 — Language map

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1
- **Related:** [ADR-001](0001-parser-home-typescript-core.md)

## Context

[ADR-001](0001-parser-home-typescript-core.md) puts the grammar in TypeScript, which
would leave `extraction` and `catalog-matching` as Node islands in the Python fleet
the PED describes. Two runtimes across seventeen services means two build pipelines,
two dependency-scanning setups, two Powertools configurations and two idioms for the
same idempotency and logging patterns — for no benefit, since the services that
matter most already have to be Node.

## Decision

**Node/TypeScript is the default; Python is the exception, and only where a library
forces it.**

### TypeScript on Node (arm64, esbuild zip)

`bff`, `identity`, `ingestion`, `extraction`, `catalog-matching`,
`playlist-orchestration`, `provider-connection`, every provider adapter,
`notification`, `config`, `kill-switch`, `usage-sentinel`.

These share the core's normalizer and the zod contracts, and use one toolchain with
CDK, the Expo app and the PWA.

### Python 3.13 (arm64, zip) — three exceptions only

| Where | Why |
| --- | --- |
| `services/ocr` | The ONNX OCR tooling (RapidOCR) is Python-first. It returns raw lines and contains **no grammar**, so it cannot drift from the core. |
| `packages/etl` | Must stay Glue-compatible for the enterprise profile (PED D8). |
| `tools/oracle-py` | Temporary; deleted at CORE-07. |

### Tooling

| Concern | TypeScript | Python |
| --- | --- | --- |
| Lambda runtime helpers | Powertools for AWS Lambda (TypeScript) — logging, tracing, metrics, idempotency, parameters | Powertools (Python) |
| Unit tests | Vitest, fast-check, aws-sdk-client-mock | pytest, Hypothesis |
| Mutation | Stryker — ≥70% on `packages/core`, ≥65% elsewhere | mutmut ≥70% |
| Contracts | zod-first in `packages/contracts` | JSON Schema generated from the zod schemas |

Contracts are generated in one direction only. A hand-maintained Python mirror of a
zod schema is the same drift problem this ADR exists to avoid.

## Consequences

- One dependency graph, one SCA configuration, one bundler for almost everything.
- `services/ocr` is the only service needing a Python build in CI, and it is also the
  only one with a size problem to manage.
- **Size ceiling for `services/ocr`: 240 MB unzipped.** If it exceeds that, replace
  OpenCV with Pillow + numpy, or shrink the models. **Never** switch to container
  images — ECR storage is billed and is on the never-use list.
- The Python work already written at M0 (`packages/core`) becomes `tools/oracle-py`
  and is retired, not extended.
