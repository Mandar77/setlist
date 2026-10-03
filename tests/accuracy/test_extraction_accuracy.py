"""Golden-set accuracy gate for extraction (PRD S10, PED M3).

This is a release gate, not a report. A PR that drops F1 below the threshold fails.

Scoring deliberately compares *normalized* (title, artist) pairs rather than exact
strings: the extractor is allowed to move "(Live)" into `Hints` or transliterate an
accent, and asserting on raw strings would turn every legitimate improvement into a
failing test. A tolerance band on the aggregate score absorbs that without hiding a
real regression, which is the same reasoning the PRD gives for gating an LLM-backed
extractor at temperature 0.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import NotRequired, TypedDict, cast

import pytest

from setlist_core.normalize import fold
from setlist_core.pipeline import extract_deterministic

pytestmark = pytest.mark.accuracy

GOLDEN_DIR = Path(__file__).resolve().parents[2] / "golden" / "extraction"

# PED M3 exit criteria for printed sources. The base PRD's eventual target is F1 >=0.92
# once the Bedrock residual pass exists; the deterministic-only pass is held to the
# phase gate it is actually responsible for.
MIN_PRECISION = 0.95
MIN_RECALL = 0.90
MIN_F1 = 0.92


class ExpectedSong(TypedDict):
    """One song the golden set says must be extracted."""

    title: str
    artist: NotRequired[str]


class GoldenCase(TypedDict):
    """One golden-set document and its expected extraction."""

    id: str
    source: str
    kind: str
    text: str
    expected: list[ExpectedSong]
    comment: NotRequired[str]
    tier: NotRequired[str]


@dataclass(frozen=True)
class Score:
    """Aggregate precision/recall/F1 over a corpus."""

    true_positives: int
    false_positives: int
    false_negatives: int

    @property
    def precision(self) -> float:
        predicted = self.true_positives + self.false_positives
        return self.true_positives / predicted if predicted else 1.0

    @property
    def recall(self) -> float:
        actual = self.true_positives + self.false_negatives
        return self.true_positives / actual if actual else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0


def _key(title: str, artist: str | None) -> tuple[str, str]:
    """Normalized comparison key for one expected or extracted song."""
    return fold(title), fold(artist or "")


def _load(name: str) -> list[GoldenCase]:
    """Read a golden-set file."""
    payload = json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))
    return cast("list[GoldenCase]", payload["cases"])


PRINTED_CASES = _load("printed.json")

#: The generated corpus (CORE-03), built from golden/seed/recordings.jsonl by
#: tools/golden-gen. Two tiers, and they are gated differently on purpose.
#:
#: `clean` is layout the deterministic pass is responsible for, and it carries the real
#: gate. `noisy` is chat prose, heavy typos, reversed columns with nothing to
#: disambiguate them, and two recorded extractor gaps — none of which the deterministic
#: pass claims to resolve, because that is what the residual and the LLM pass are for
#: (PRD S7.9.3). Scoring recall on those would be demanding the parser guess.
#:
#: What every tier is held to is grounding: G2 says no hallucinated songs, and that
#: promise does not weaken on input the parser cannot read.
GENERATED_CASES = _load("generated.json")
CLEAN_CASES = [c for c in GENERATED_CASES if c.get("tier") == "clean"]
NOISY_CASES = [c for c in GENERATED_CASES if c.get("tier") == "noisy"]


def _score_case(
    case: GoldenCase,
) -> tuple[Score, set[tuple[str, str]], set[tuple[str, str]]]:
    """Score one golden case, returning the score and the two symmetric differences."""
    result = extract_deterministic(case["text"])
    got = {_key(item.title, item.artist) for item in result.items}
    want = {_key(entry["title"], entry.get("artist")) for entry in case["expected"]}

    return (
        Score(
            true_positives=len(got & want),
            false_positives=len(got - want),
            false_negatives=len(want - got),
        ),
        got - want,
        want - got,
    )


@pytest.mark.parametrize("case", PRINTED_CASES, ids=lambda c: c["id"])
def test_case_extracts_exactly_the_expected_songs(case: GoldenCase) -> None:
    """Every golden case must be extracted exactly - no misses, no inventions."""
    score, spurious, missed = _score_case(case)
    assert not spurious, f"{case['id']}: extracted songs not in the golden set: {sorted(spurious)}"
    assert not missed, f"{case['id']}: golden songs not extracted: {sorted(missed)}"
    assert score.false_positives == 0


def test_corpus_meets_the_accuracy_gate() -> None:
    """Aggregate precision, recall and F1 across the whole printed corpus."""
    total = Score(0, 0, 0)
    for case in PRINTED_CASES:
        score, _, _ = _score_case(case)
        total = Score(
            total.true_positives + score.true_positives,
            total.false_positives + score.false_positives,
            total.false_negatives + score.false_negatives,
        )

    report = (
        f"precision={total.precision:.3f} recall={total.recall:.3f} f1={total.f1:.3f} "
        f"(tp={total.true_positives} fp={total.false_positives} fn={total.false_negatives})"
    )
    assert total.precision >= MIN_PRECISION, f"precision gate: {report}"
    assert total.recall >= MIN_RECALL, f"recall gate: {report}"
    assert total.f1 >= MIN_F1, f"F1 gate: {report}"


def _aggregate(cases: list[GoldenCase]) -> Score:
    """Sum the per-case scores across a corpus."""
    total = Score(0, 0, 0)
    for case in cases:
        score, _, _ = _score_case(case)
        total = Score(
            total.true_positives + score.true_positives,
            total.false_positives + score.false_positives,
            total.false_negatives + score.false_negatives,
        )
    return total


def test_generated_clean_corpus_meets_the_accuracy_gate() -> None:
    """The generated corpus, on the shapes the deterministic pass owns.

    This is the gate CORE-03 exists to make possible. Eight hand-written cases cannot
    tell you whether the extractor handles Cyrillic titles, fullwidth punctuation,
    ragged whitespace from a PDF or a Reddit post with three distractor lines in it;
    a few hundred generated ones can, and their expected answers come from the seed
    rather than from what the parser said last time.
    """
    total = _aggregate(CLEAN_CASES)
    report = (
        f"precision={total.precision:.3f} recall={total.recall:.3f} f1={total.f1:.3f} "
        f"(tp={total.true_positives} fp={total.false_positives} fn={total.false_negatives})"
    )
    assert total.precision >= MIN_PRECISION, f"generated precision gate: {report}"
    assert total.recall >= MIN_RECALL, f"generated recall gate: {report}"
    assert total.f1 >= MIN_F1, f"generated F1 gate: {report}"


def test_no_extracted_song_is_ungrounded() -> None:
    """PED FR-M-007 / E4: zero ungrounded songs across the corpus.

    Grounding is enforced inside the pipeline, so this asserts the end-to-end promise
    rather than the unit behaviour: nothing reaches a preview that the source text
    does not support.

    Every tier, including the noisy one. A parser that cannot read a chat message is
    allowed to return nothing; it is never allowed to return something that is not
    there.
    """
    for case in [*PRINTED_CASES, *GENERATED_CASES]:
        result = extract_deterministic(case["text"])
        for item in result.items:
            covered = fold(item.span.slice(result.document.text))
            claimed = fold(item.title).split()
            present = sum(1 for token in claimed if token in covered.split())
            assert present / len(claimed) >= 0.7, f"{case['id']}: ungrounded item {item.title!r}"


def test_golden_set_is_not_empty() -> None:
    """Guard against the gate silently passing because the corpus failed to load."""
    assert len(PRINTED_CASES) >= 8
    assert sum(len(case["expected"]) for case in PRINTED_CASES) >= 25
    # CORE-03 asks for at least 300 generated cases. The assertion is here rather than
    # only in the generator's own tests because this is the file that would quietly pass
    # on an empty corpus.
    assert len(GENERATED_CASES) >= 300
    assert len(CLEAN_CASES) >= 200
    assert len(NOISY_CASES) >= 50
    assert sum(len(case["expected"]) for case in GENERATED_CASES) >= 1500
