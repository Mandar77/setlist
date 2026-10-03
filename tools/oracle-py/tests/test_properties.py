"""Property-based tests for extraction invariants.

Examples prove that known inputs work. These prove that the invariants FR-003 and
FR-004 rest on hold across inputs nobody thought to write down - which is the only
honest way to claim "no hallucinated songs" about a system fed arbitrary internet text.
"""

import bisect

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from setlist_core.dedupe import dedupe
from setlist_core.models import SourceDocument
from setlist_core.normalize import (
    ISRC_RE,
    fold,
    normalize_document,
    normalize_isrc,
    strip_qualifiers,
)
from setlist_core.parsers import split_lines
from setlist_core.pipeline import extract_deterministic

pytestmark = pytest.mark.unit

# Deliberately nasty: control characters, zero-width joiners, bidi overrides, RTL,
# CJK, emoji and lone punctuation all appear in real pasted threads. Fragments of
# genuine list syntax are interleaved so the generator reaches the parsers instead of
# producing noise the triage layer discards before anything interesting happens.
_INVISIBLE_SAMPLES = [
    "\u200b",  # zero-width space
    "\u202e",  # right-to-left override
    "\u2066",  # left-to-right isolate
    "\ufeff",  # BOM
    "\u00ad",  # soft hyphen
    "\U0001f3b5",  # musical note emoji
    "م",  # Arabic meem (RTL)
    "世",  # CJK
]
_CHAOS = st.text(
    alphabet=st.one_of(
        st.characters(min_codepoint=1, max_codepoint=0x2FFF),
        st.sampled_from(_INVISIBLE_SAMPLES),
    ),
    max_size=40,
)
_FRAGMENTS = st.sampled_from(
    [
        " - ",
        " – ",
        " by ",
        '"',
        "\t",
        "\n",
        ",",
        "1. ",
        "- ",
        "[00:14] ",
        "(Live)",
        "(Extended Mix)",
        "feat. ",
        "Daft Punk",
        "One More Time",
        "M83",
        "USRC17607839",
        "## Heading",
        "https://example.com",
        "|",
        ";",
    ]
)
NASTY_TEXT = st.lists(st.one_of(_CHAOS, _FRAGMENTS), max_size=24).map("".join)

SLOW = settings(
    max_examples=200,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)


class TestNormalizationProperties:
    @given(NASTY_TEXT)
    @SLOW
    def test_normalization_is_idempotent(self, raw):
        once = normalize_document(raw)
        assert normalize_document(once) == once

    @given(NASTY_TEXT)
    @SLOW
    def test_normalized_text_has_no_carriage_returns_or_invisibles(self, raw):
        text = normalize_document(raw)
        assert "\r" not in text
        for invisible in ("\u200b", "\ufeff", "\u202e", "\u00ad"):
            assert invisible not in text

    @given(st.text(max_size=100))
    @SLOW
    def test_fold_is_idempotent(self, raw):
        once = fold(raw)
        assert fold(once) == once

    @given(st.text(max_size=100))
    @SLOW
    def test_strip_qualifiers_never_lengthens_the_title(self, raw):
        base, _, _, _ = strip_qualifiers(raw)
        assert len(base) <= len(raw.strip())


class TestSpanProperties:
    @given(NASTY_TEXT)
    @SLOW
    def test_line_offsets_reconstruct_the_document(self, raw):
        text = normalize_document(raw)
        for line in split_lines(text):
            assert text[line.offset : line.offset + len(line.text)] == line.text

    @given(NASTY_TEXT)
    @SLOW
    def test_every_span_lies_inside_the_document(self, raw):
        result = extract_deterministic(raw)
        length = len(result.document.text)
        for item in result.items:
            assert 0 <= item.span.start < item.span.end <= length
            for duplicate in item.duplicates:
                assert 0 <= duplicate.start < duplicate.end <= length
        for span in result.residual:
            assert 0 <= span.start < span.end <= length

    @given(NASTY_TEXT)
    @SLOW
    def test_every_item_is_grounded_in_its_span(self, raw):
        """FR-003: an item's span must actually contain the title it claims.

        This is the invariant that makes hallucinated songs structurally impossible,
        so it is asserted over arbitrary input rather than a fixed corpus.
        """
        result = extract_deterministic(raw)
        for item in result.items:
            source = frozenset(fold(item.span.slice(result.document.text)).split())
            claimed = fold(item.title).split()
            if not claimed:
                continue
            present = sum(1 for token in claimed if token in source)
            assert present / len(claimed) >= 0.7


class TestPipelineProperties:
    @given(NASTY_TEXT)
    @SLOW
    def test_extraction_never_raises(self, raw):
        extract_deterministic(raw)

    @given(NASTY_TEXT)
    @SLOW
    def test_confidence_is_always_in_range(self, raw):
        result = extract_deterministic(raw)
        assert all(0.0 <= item.confidence <= 1.0 for item in result.items)

    @given(NASTY_TEXT)
    @SLOW
    def test_dedup_keys_are_unique_in_the_result(self, raw):
        result = extract_deterministic(raw)
        keys = [item.key for item in result.items]
        assert len(keys) == len(set(keys))

    @given(NASTY_TEXT)
    @SLOW
    def test_items_and_residual_never_cover_the_same_line(self, raw):
        result = extract_deterministic(raw)
        text = result.document.text
        starts = [line.offset for line in split_lines(text)]
        item_lines = {_line_of(starts, item.span.start) for item in result.items}
        residual_lines = {_line_of(starts, span.start) for span in result.residual}
        assert not (item_lines & residual_lines)

    @given(NASTY_TEXT)
    @SLOW
    def test_extraction_is_deterministic(self, raw):
        first = extract_deterministic(raw)
        second = extract_deterministic(raw)
        assert [(i.title, i.artist, i.confidence) for i in first.items] == [
            (i.title, i.artist, i.confidence) for i in second.items
        ]

    @given(NASTY_TEXT)
    @SLOW
    def test_digest_matches_normalized_content(self, raw):
        result = extract_deterministic(raw)
        assert result.document.digest == SourceDocument.from_raw(raw).digest


class TestDedupeProperties:
    @given(NASTY_TEXT)
    @SLOW
    def test_dedupe_is_idempotent(self, raw):
        items = extract_deterministic(raw).items
        assert dedupe(items) == items

    @given(NASTY_TEXT)
    @SLOW
    def test_occurrence_counts_are_conserved(self, raw):
        result = extract_deterministic(raw)
        total = sum(item.occurrence_count for item in result.items)
        assert total == result.stats.items_before_dedupe


class TestIsrcProperties:
    @given(
        st.from_regex(r"\A[A-Z]{2}[A-Z0-9]{3}[0-9]{7}\Z", fullmatch=True),
    )
    @SLOW
    def test_wellformed_isrcs_round_trip(self, isrc):
        assert normalize_isrc(isrc) == isrc
        assert normalize_isrc(isrc.lower()) == isrc

    @given(st.text(max_size=20))
    @SLOW
    def test_isrc_output_is_always_valid_or_none(self, raw):
        """`normalize_isrc` fails closed: it returns a valid ISRC or nothing."""
        result = normalize_isrc(raw)
        if result is not None:
            assert ISRC_RE.match(result)


def _line_of(starts: list[int], offset: int) -> int:
    """Index of the line containing ``offset``."""
    return bisect.bisect_right(starts, offset) - 1
