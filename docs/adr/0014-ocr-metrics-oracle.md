# ADR-014 — The OCR harness is TypeScript; jiwer is its oracle, not its implementation

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decided by:** Claude Code, under [AUTOPILOT §2.3](../plan/AUTOPILOT.md#23-decide-dont-ask)
- **Amends:** [ADR-004](0004-language-map.md)'s Python map, by one location
- **Context:** M2-05a has to compute CER/WER, and the PED names a Python library

## Context

PED §670 says *"CER/WER measured with `jiwer`"*. `jiwer` is Python.
[ADR-004](0004-language-map.md) allows Python in exactly three places — `services/ocr`
(RapidOCR is Python-first), `packages/etl` (Glue compatibility) and `tools/oracle-py` (the
frozen reference) — and the uv workspace members are precisely that list.

So the harness cannot be written the obvious way without widening the language map, and
the obvious way is not clearly right either. M2-05a has to produce two different numbers
from the same inputs:

- **CER and WER**, character and word error rates against each line's drawn text;
- **song-level F1**, which runs the extractor over the OCR output and compares what it
  returns against `songTruth` — and the extractor is `packages/core`, TypeScript.

A Python harness would therefore have to cross a process boundary to score half its own
report. A TypeScript harness has to implement two string metrics.

## Decision

**The harness is TypeScript, in `tools/ocr-eval`. `jiwer` is kept as the oracle for its
two metrics, in `tools/ocr-eval/oracle-py`, which becomes the fourth Python location.**

This is the CORE-01/CORE-04 arrangement again, and deliberately so: a reference
implementation whose job is to be trusted, a working implementation that has to match it
byte for byte, and a differential in CI. That pattern has already paid for itself once
here — the port reproduced the oracle exactly, and the differential caught four defects
that no unit test would have.

Why not the other way round:

- **The metric is the easy half to get wrong silently.** CER is a Levenshtein ratio and
  every detail is a judgement call: what counts as a word, whether the denominator is the
  reference length or the alignment length, how an empty reference is handled. A
  hand-rolled version does not fail — it returns a plausible number, and an accuracy gate
  built on a plausible number is worse than no gate. Pinning it to `jiwer`'s answers makes
  the judgement calls somebody else's, and checkable.
- **The extractor is the easy half to get wrong loudly.** Calling `packages/core` from
  Python means a subprocess, a JSON contract and a second place for the span offsets to
  drift. In TypeScript it is a function call.
- **`tools/oracle-py` is frozen and cannot take this.** [ADR-009](0009-oracle-bug-fixes.md)
  allows it bug fixes and no features; a new metric module is a feature.

### The fourth Python location is narrow on purpose

`tools/ocr-eval/oracle-py` may contain the jiwer differential and nothing else. It is not
a general Python escape hatch, and it does not make `tools/` a Python-friendly directory:
it exists because one specific library is the reference for one specific pair of numbers.
If the differential is ever deleted, so is the location.

ADR-004's map is amended to four entries, with that scope stated.

### M2-05b inherits this rather than re-opening it

M2-05b adds RapidOCR, which *is* Python and lives in `services/ocr`. The temptation then
is to move scoring to Python "since it is already there". It should not move: the engine
and the scorer are different jobs, every engine already reports through a JSON contract
because three of them are in three different languages, and a fourth that bypassed it
would make its numbers incomparable with the rest.

## Consequences

- One scorer, in one language, for every engine. Apple Vision (Swift), ML Kit (Kotlin),
  Tesseract.js (Node) and later RapidOCR (Python) all hand it the same JSON.
- The CER/WER numbers in `docs/reports/ocr-eval.md` are pinned to a published
  implementation, so a regression in them is a regression in the engine rather than
  possibly a regression in our arithmetic.
- One more uv workspace member, one more thing for the dependency cooldown to cover.
- Risk accepted: `jiwer` could change its definitions across a major version and move the
  oracle. That is the same risk `tools/oracle-py` carries and is handled the same way — a
  pinned version, and a differential that fails loudly rather than drifting.
