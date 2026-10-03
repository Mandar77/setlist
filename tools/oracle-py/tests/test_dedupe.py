"""Unit tests for deduplication (FR-004)."""

import pytest

from setlist_core.dedupe import dedupe
from setlist_core.enums import ExtractionMethod, Qualifier
from setlist_core.models import Hints, ParsedItem, Span

pytestmark = pytest.mark.unit


def item(
    title: str,
    artist: str | None = "Daft Punk",
    *,
    start: int = 0,
    confidence: float = 0.9,
    hints: Hints | None = None,
) -> ParsedItem:
    return ParsedItem(
        title=title,
        artist=artist,
        hints=hints or Hints(),
        span=Span(start=start, end=start + 10),
        confidence=confidence,
        method=ExtractionMethod.DETERMINISTIC,
        parser="dash",
    )


class TestDedupe:
    def test_identical_items_collapse(self):
        result = dedupe([item("One More Time", start=0), item("One More Time", start=50)])
        assert len(result) == 1
        assert result[0].occurrence_count == 2

    def test_collapse_is_case_and_punctuation_insensitive(self):
        result = dedupe([item("One More Time"), item("one more time!", start=50)])
        assert len(result) == 1

    def test_highest_confidence_occurrence_wins(self):
        result = dedupe(
            [
                item("Song", start=0, confidence=0.6),
                item("Song", start=50, confidence=0.95),
            ]
        )
        assert result[0].confidence == 0.95
        assert result[0].span.start == 50

    def test_ties_go_to_the_earliest_mention(self):
        result = dedupe([item("Song", start=70), item("Song", start=10)])
        assert result[0].span.start == 10

    def test_qualifiers_keep_recordings_separate(self):
        live = item("Song", start=50, hints=Hints(qualifiers=frozenset({Qualifier.LIVE})))
        result = dedupe([item("Song"), live])
        assert len(result) == 2

    def test_different_artists_stay_separate(self):
        result = dedupe([item("Song", "Daft Punk"), item("Song", "Justice", start=50)])
        assert len(result) == 2

    def test_hints_are_merged_across_occurrences(self):
        first = item("Song", hints=Hints(position=1))
        second = item("Song", start=50, hints=Hints(isrc="USRC17607839", duration_s=225.0))
        merged = dedupe([first, second])[0]
        assert merged.hints.position == 1
        assert merged.hints.isrc == "USRC17607839"
        assert merged.hints.duration_s == 225.0

    def test_duplicate_spans_are_recorded_in_document_order(self):
        result = dedupe([item("Song", start=0), item("Song", start=90), item("Song", start=40)])
        assert [span.start for span in result[0].duplicates] == [40, 90]

    def test_order_of_first_appearance_is_preserved(self):
        result = dedupe([item("B", start=0), item("A", start=20), item("B", start=40)])
        assert [entry.title for entry in result] == ["B", "A"]


class TestArtistAbsorption:
    def test_artistless_mention_folds_into_the_attributed_one(self):
        result = dedupe(
            [
                item("One More Time", "Daft Punk", start=0),
                item("One More Time", None, start=50),
            ]
        )
        assert len(result) == 1
        assert result[0].artist == "Daft Punk"
        assert result[0].occurrence_count == 2

    def test_ambiguous_title_is_not_absorbed(self):
        # Two different artists claim "Home", so the artistless mention stays its own
        # item rather than being attributed by a guess.
        result = dedupe(
            [
                item("Home", "Artist A", start=0),
                item("Home", "Artist B", start=30),
                item("Home", None, start=60),
            ]
        )
        assert len(result) == 3

    def test_absorption_merges_hints(self):
        result = dedupe(
            [
                item("Song", "Daft Punk", start=0),
                item("Song", None, start=50, hints=Hints(isrc="USRC17607839")),
            ]
        )
        assert result[0].hints.isrc == "USRC17607839"

    def test_no_attributed_match_leaves_the_item_alone(self):
        result = dedupe([item("Orphan", None, start=0)])
        assert len(result) == 1
        assert result[0].artist is None


def test_empty_input():
    assert dedupe([]) == ()
