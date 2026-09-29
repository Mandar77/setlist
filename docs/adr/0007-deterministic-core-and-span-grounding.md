# ADR-007 — A pure deterministic core, with grounding as a structural gate

- **Status:** Accepted (written as 0001; renumbered so ADR-001..006 match
  `docs/plan/AUTOPILOT.md` S1, which is authoritative)
- **Date:** 2026-09-28
- **Context:** PRD §7.9, FR-002/003/004; PED D9, FR-M-007, epic E4

## Context

The base PRD specified a hybrid extractor: deterministic parsers first, Bedrock Claude
for residual prose. The PED removes Bedrock from the default path (D9) because it has
no free tier, and pushes the parser onto the device so that scanning works offline.

Both documents agree on the part that carries the product's main claim — "no
hallucinated songs" (PRD G2, PED FR-M-007) — and both express it the same way: every
extracted item must cite a character span, and an item whose span does not support it
is rejected.

> **Language note.** Written against the Python implementation.
> [ADR-001](0001-parser-home-typescript-core.md) moves the core to TypeScript; every
> design decision below carries over unchanged and serves as the porting spec.

## Decision

1. **`packages/core` is pure.** No AWS SDK, no HTTP, no provider clients. Extraction is
   a pipeline of total functions over immutable models.
2. **Spans index normalized text, not raw input.** `SourceDocument.text` is the single
   coordinate system. NFKC and zero-width stripping both change string length, so
   offsets taken against the raw bytes drift; the document is normalized exactly once,
   at ingest, and travels with the result.
3. **Grounding is a gate, not a score.** `grounding.ground()` rejects any item whose
   span is out of range, oversized, or whose title tokens are not actually present in
   the cited text. Rejections are retained with a reason so the decision is auditable.
4. **The deterministic pass emits its own residual.** `ExtractionResult.residual` is
   exactly the set of lines no rule could read. That, and nothing else, is what an LLM
   ever sees — on device or in Bedrock under the enterprise profile.
5. **Confidence lives in one module.** Parsers report *what* they found and *how*;
   `confidence.py` turns that into a number. Recalibration is one diff plus a rerun of
   the accuracy gate.

## Consequences

- The same core answers FR-002/003/004 and FR-M-007 without modification, and it is
  testable offline, which is why the accuracy gate can run on every PR with no
  credentials and no spend.
- Grounding also covers the on-device LLM path the PED adds (FR-M-008 requires model
  output to be a substring of the OCR text) — the existing gate is strictly stronger,
  since it works on token coverage and also caps span size.
- A span cap (400 characters) is required, not optional: without it a span covering the
  whole document trivially "contains" any invented title.
- Cost: normalization is not length-preserving, so any consumer that wants to highlight
  a span in the original paste must use `document.text`, which the API returns.

## Notes for later phases

- The `ExtractionMethod` ceiling in `confidence.py` already encodes
  `deterministic > llm_grounded > llm_ungrounded`, so wiring an LLM pass does not
  require touching the scoring model.
- `ParsedItem.duplicates` records every other occurrence of a song, which the review UI
  needs to show "appeared 3 times" and to cite each mention.
