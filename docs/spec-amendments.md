# Spec amendments

Precedence is `docs/plan/AUTOPILOT.md` and `docs/adr/` > PED > PRD. When a decision
overrides a spec, the losing spec is amended in the same change.

**The PRD and PED are not yet in the repository** (see `docs/README.md`). Until they
are, this file holds the exact replacement text. When the specs land, apply each
amendment below in place, leave a pointer back to its ADR, and reduce this file to an
index.

---

## PRD

### FR-002 — deterministic parsing patterns

**Authority:** [ADR-002](adr/0002-line-orientation.md)

> **Was:** "Deterministic parsing of common patterns: *Artist – Title*, *Title by
> Artist*, numbered/bulleted lists, CSV columns, timestamped DJ tracklists, setlists.
> AC: golden-set precision ≥0.95 on deterministic-friendly inputs."

> **Now:** "Deterministic parsing of common patterns: separator-delimited
> artist/title pairs, *Title by Artist*, numbered/bulleted lists, CSV columns,
> timestamped DJ tracklists, setlists. **Orientation of a separator-delimited line is
> inferred, not fixed**: explicit cues first, then the document's own convention, then
> a source-kind prior (`scan_*` and `screenshot` → title first; `paste` and `file` →
> artist first). Where confidence is below 0.8 the parser emits the swapped reading as
> `alternate`, and matching resolves it against free catalogs before any provider
> quota is spent. AC: golden-set precision ≥0.95 on deterministic-friendly inputs;
> parser-only orientation accuracy ≥90% on bare-dash lines and ≥98% after matching."

### §7.9 / §7.10 — extraction and matching implementation language

**Authority:** [ADR-001](adr/0001-parser-home-typescript-core.md),
[ADR-004](adr/0004-language-map.md)

The algorithm specs stand unchanged. Replace every implication that they run in
Python with TypeScript: the grammar lives in `packages/core` (TypeScript + zod) and
executes on the device, in the browser and in Node Lambdas.

---

## PED

### §9 — mobile app architecture

**Authority:** [ADR-001](adr/0001-parser-home-typescript-core.md)

Confirms rather than contradicts: `packages/core` **is** the shared TypeScript
package. Add that the same package is imported by `services/extraction` and
`services/catalog-matching` as Node Lambdas, so there is exactly one grammar, and that
Hermes parity is proven by the M1-04 self-test screen, with NFKC and regex Unicode
property escapes checked and polyfilled where they differ.

### §10.3 — service catalog

**Authority:** [ADR-001](adr/0001-parser-home-typescript-core.md),
[ADR-004](adr/0004-language-map.md)

> **Was:** an implied Python fleet, with `extraction` doing "parse + grounding".

> **Now:** Node/TypeScript is the default runtime for every service. Python 3.13
> remains only for `ocr` (RapidOCR is Python-first; it returns raw lines and contains
> no grammar) and `packages/etl` (Glue compatibility). `extraction` and
> `catalog-matching` are Node and import `packages/core` directly.

### §14 — testing strategy

**Authority:** [ADR-004](adr/0004-language-map.md),
[ADR-006](adr/0006-test-data.md)

> **Was:** "Unit: pytest + moto + Hypothesis; Jest + RNTL. Coverage ≥85% (core ≥90%)
> … mutmut ≥70%, Stryker ≥65%."

> **Now:** "Unit: Vitest + fast-check + aws-sdk-client-mock for TypeScript; pytest +
> Hypothesis for the Python exceptions (`services/ocr`, `packages/etl`). Coverage
> ≥85% (core ≥90%). Mutation: Stryker ≥70% on `packages/core` and ≥65% elsewhere;
> mutmut ≥70% for the Python parts."

Add [ADR-006](adr/0006-test-data.md): golden sets are generated truth-first from a
MusicBrainz seed catalog. Expected outputs are never derived from parser output, and
changing one requires an ADR.

### Epic E4 — extraction

**Authority:** [ADR-002](adr/0002-line-orientation.md)

> **Was:** "*Given* `1. Wonderwall – Oasis`, *then* the result is {Wonderwall, Oasis}
> with spans."

> **Now:** "*Given* `1. Wonderwall – Oasis` **with `sourceKind: scan_handwriting`**,
> *then* the result is `{title: Wonderwall, artist: Oasis}` with spans.
> *Given* the same line with `sourceKind: paste`, *then* the parser emits
> `{title: Oasis, artist: Wonderwall}` on the artist-first prior **plus an
> `alternate`**, and matching resolves it to `{title: Wonderwall, artist: Oasis}`
> against MusicBrainz without spending YouTube quota."

### §18 — implementation addendum

**Authority:** [ADR-003](adr/0003-build-order-m0-first.md),
[ADR-005](adr/0005-credentials-branches-deploys.md)

- M0 is split into **M0a** (no AWS) and **M0b** (after Session 1); see ADR-003.
- The CLAUDE.md cost-guardrail block changes its deploy line — deploys run only in CI
  (ADR-005), so the local rule is to run `make preflight` before *pushing*
  infrastructure changes, not before deploying.
- The `PreToolUse` hook is no longer a preflight wrapper on deploy commands. It is
  `guard-bash.sh`, which blocks `aws`, `cdk/sam deploy|destroy`, force pushes, pushes
  to `main`, `gh pr merge`, `gh secret` and destructive `gh api` calls outright.
- Add the subagents `reviewer`, `cost-auditor`, `ocr-evaluator`, `contract-keeper`
  and `mobile-builder`, and the `/autopilot` skill.
