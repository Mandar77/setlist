# ADR-015 — How the OCR numbers decide anything

- **Status:** Accepted
- **Date:** 2026-10-07
- **Decided by:** the human
- **Context:** M2-05a is about to produce its first engine comparison
- **Related:** [ADR-014](0014-ocr-metrics-oracle.md) (how the metrics are computed), M2-07 (the real-set gate)

## Context

The harness is built and no engine has run through it yet. That ordering is the point of
writing this now.

A decision rule chosen after seeing the numbers is not a rule, it is a description. Once
the table exists, every threshold argues for whichever engine the table already favours,
and "0.78 was always the floor" becomes unfalsifiable. So the rule goes down first, while
it still costs nothing to be wrong about.

## Decision

### 1. Song-level F1 is the headline. CER and WER are diagnostics.

Per engine and per image class.

CER and WER measure characters and words. The product does not ship characters — it ships
a list of songs, and an engine whose errors fall on characters the grammar ignores is the
better engine here even with a worse CER. Song-level F1 runs the OCR output back through
`packages/core`, so it measures the pair that actually faces a user.

CER and WER stay in the report because they say *where* an engine is failing, which is
what you need to fix it. They do not decide anything on their own. A proposal to switch
engines on a CER improvement that F1 does not corroborate is a proposal to optimise the
diagnostic.

### 2. Synthetic handwriting is a best case. The table says so.

The corpus draws handwriting with 14 webfonts. A font is consistent: the same letter is
the same shape every time, the baseline is straight, the stroke width does not vary with
how tired the writer was. Real handwriting is none of those things.

So the handwriting column is an **upper bound**, and the report labels it that way rather
than leaving the reader to supply the caveat. An engine that cannot read synthetic
handwriting will not read real handwriting; an engine that can has proven only that it
clears the easy case.

M2-06 brings the real set and M2-07 is the gate that matters.

### 3. If synthetic handwriting F1 < 0.78, handwriting scans default to the server engine.

0.78 is the M3 handwriting floor, so the test is whether the best on-device engine clears
the number the product will eventually be held to — on the easy case.

Below it, the on-device path is not good enough for handwriting and handwriting scans go
to `ocr-svc` by default. That is a routing default, not a verdict on the engine: print and
screenshots stay on-device, and the default is revisited at **M2-07 against the real set**,
which is the only measurement that can settle it.

Above it, nothing changes yet — clearing a best case is not evidence about the real one.

This interacts with the free-tier budget and that is deliberate: routing handwriting to the
server moves load onto `server_ocr_page`, which is metered and which `make estimate` gates.
If the routing change breaches a budget row, the routing change is what gets argued about,
with numbers, rather than the budget.

## Consequences

- The report's shape is fixed by this: F1 first, per class, with handwriting labelled as a
  best case, and CER/WER alongside as diagnostics.
- A single number — best on-device handwriting F1 against 0.78 — decides the routing
  default, and it was chosen before it could be measured.
- The decision is explicitly provisional. M2-07 re-runs it against real photographs, and
  the expectation is that the real number is *worse*; anything else would mean the
  synthetic corpus was harder than reality, which would itself need explaining.
- Risk accepted: 0.78 is the M3 floor rather than a number derived from this corpus. It is
  a borrowed threshold, and a borrowed threshold can be the wrong shape for what it is
  applied to. The alternative — deriving one from the results — is the thing this ADR
  exists to prevent.
