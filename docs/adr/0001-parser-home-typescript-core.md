# ADR-001 — Parser home is one TypeScript core

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1
- **Related:** [ADR-004](0004-language-map.md) (language map),
  [ADR-007](0007-deterministic-core-and-span-grounding.md) (the design being ported)

## Context

The PED requires the song grammar in two places at once. PED §9 has the mobile app
sharing `packages/core` — "zod schemas, parser, API client" — with the React web app,
and requires parsing to work offline so scan-to-preview meets NFR-M-003 (p95 < 4 s).
PED §10.3 also lists an `extraction` Lambda that parses and grounds, and §14 specifies
pytest for service tests.

Read literally that is two implementations of one grammar. They would drift, and they
would drift **silently**: device and server would disagree about what a document
contains while both reported high confidence, which also breaks the offline queue's
idempotency guarantee (FR-M-012) since the device's parse must be reproducible
server-side.

## Decision

**`packages/core` is TypeScript + zod.** One grammar, three consumers:

| Consumer | How |
| --- | --- |
| `mobile/` | Imported directly; runs on Hermes, offline, straight after on-device OCR |
| `web/` | Imported directly by the PWA |
| `services/extraction`, `services/catalog-matching` | Node Lambdas importing the same package |

### Migration, not rewrite

1. **Freeze the Python core** as `tools/oracle-py/` with a CLI that reads text on stdin
   plus a `sourceKind` and prints JSON. It receives no new features.
2. **Port under a differential test.** TypeScript output must equal the oracle's on
   every golden case and on ≥10,000 generated inputs. Permitted differences live in
   `golden/diff-allowlist.yaml`, and only ADR-002 orientation changes may be listed.
3. **Keep the core pure.** No Node, DOM or React Native APIs; an ESLint rule enforces it.
4. **Prove parity on all three engines** the core actually runs on — Node (Vitest),
   Chromium (Playwright), and Hermes via a dev-only self-test screen Maestro drives in
   CI (M1-04). Check NFKC and regex Unicode property escapes on Hermes first and
   polyfill whatever differs; this is the most likely source of a real divergence.
5. **Retire the oracle** once parity holds on all three, keeping its outputs as frozen
   fixtures (CORE-07).

## Consequences

- No device/server drift, and a device parse the server reproduces exactly.
- `services/extraction` and `services/catalog-matching` are Node in an otherwise
  Python-light fleet — see [ADR-004](0004-language-map.md), which resolves this by
  making Node the default and Python the exception.
- The accuracy gate moves to Vitest over the same `golden/extraction/*.json` files. The
  corpus format is language-neutral by design and does not change.
- Mutation testing moves from mutmut to Stryker (≥70% on the core).
- zod replaces the pydantic models at the boundary. ADR-007's frozen-model discipline
  carries over as `readonly` types plus `Object.freeze` on results.
- The differential test is the real deliverable: it converts a rewrite, which would
  silently lose hard-won behaviour, into a verified migration.

## Porting notes — behaviour that is easy to lose

- Spans index **normalized** text; normalization is not length-preserving.
- The grounding gate needs the span-size cap, not only token coverage.
- Confidence lives in one module, separate from the parsers.
- `_should_rescue_with_bare_titles`: bare titles rescue documents the pair parsers
  mostly **failed** on; they never supplement a document that mostly parsed.
- Port the regression tests before the code — the zero-ordinal crash and both
  precision bugs found at M0 are all in the suite.

## Spec edits

PED §9, §10.3 (extraction runs on Node), §14 (TypeScript test stack). Recorded in
`docs/spec-amendments.md`.
