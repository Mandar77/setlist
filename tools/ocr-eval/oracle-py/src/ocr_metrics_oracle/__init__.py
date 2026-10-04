"""jiwer as the reference for CER and WER.

This package exists for one reason and has one job (ADR-014). PED §670 names `jiwer` as
the implementation those two metrics are measured with; the harness that needs them is
TypeScript, because song-level F1 runs `packages/core`. So jiwer stays as the ORACLE: it
computes the expected values for a fixture corpus, those values are committed, and the
TypeScript test diffs against them.

The arrangement is CORE-01/CORE-04 again, and for the same reason. A hand-written
Levenshtein ratio does not fail when it is wrong - it returns a plausible number, and the
M2 exit gate ("CER at most 5% printed, at most 20% handwriting") is written in terms of
that number. Every definition involved is a judgement call: what a word is, whether the
denominator is the reference length or the alignment length, what an empty reference
means. Pinning them to a published implementation makes the judgement calls somebody
else's, and checkable.

Nothing else may live here. It is not a general Python escape hatch; it is one library
computing one pair of numbers, and it is deleted if the differential is.
"""

from .metrics import CASES_PATH, EXPECTED_PATH, MetricCase, expected_for, load_cases

__all__ = ["CASES_PATH", "EXPECTED_PATH", "MetricCase", "expected_for", "load_cases"]
