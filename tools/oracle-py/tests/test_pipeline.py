"""End-to-end tests for the deterministic extraction pipeline."""

import pytest

from setlist_core import REVIEW_THRESHOLD
from setlist_core.enums import ExtractionMethod, Qualifier
from setlist_core.models import SourceDocument
from setlist_core.pipeline import (
    DEFAULT_MAX_INPUT_BYTES,
    InputTooLargeError,
    extract_deterministic,
)

pytestmark = pytest.mark.unit

REDDIT_THREAD = """\
# Best tracks of the summer

1. Daft Punk - One More Time
2. Justice – Genesis (Extended Mix)
3. "Midnight City" by M83

Honestly the rest of this thread is people arguing about the festival lineup again.

- Kaytranada - 10% (feat. Kali Uchis)
[00:14] Fred again.. - Delilah (pull me out of this)
Daft Punk - One More Time
"""


@pytest.fixture
def result():
    return extract_deterministic(REDDIT_THREAD)


class TestRedditThread:
    def test_extracts_every_listed_track(self, result):
        assert [(i.artist, i.title) for i in result.items] == [
            ("Daft Punk", "One More Time"),
            ("Justice", "Genesis"),
            ("M83", "Midnight City"),
            ("Kaytranada", "10%"),
            ("Fred again..", "Delilah (pull me out of this)"),
        ]

    def test_repeated_track_collapses(self, result):
        assert result.items[0].occurrence_count == 2

    def test_prose_becomes_residual_not_an_item(self, result):
        residual = result.residual_text()
        assert "arguing about the festival lineup" in residual
        assert len(result.residual) == 1

    def test_markdown_heading_is_dropped_entirely(self, result):
        assert "Best tracks" not in result.residual_text()

    def test_hints_are_captured(self, result):
        assert result.items[1].hints.qualifiers == {Qualifier.EXTENDED}
        assert result.items[3].hints.featured_artists == ("Kali Uchis",)
        assert result.items[4].hints.timestamp_s == 14

    def test_every_item_is_span_grounded(self, result):
        for entry in result.items:
            covered = entry.span.slice(result.document.text)
            assert entry.title.split()[0].lower() in covered.lower()

    def test_nothing_was_rejected(self, result):
        assert result.rejected == ()

    def test_stats_are_consistent(self, result):
        stats = result.stats
        assert stats.items_before_dedupe == 6
        assert stats.items_after_dedupe == 5
        assert stats.lines_residual == 1
        assert 0.0 <= stats.deterministic_coverage <= 1.0


class TestConfidence:
    def test_all_items_carry_a_valid_confidence(self, result):
        assert all(0.0 <= entry.confidence <= 1.0 for entry in result.items)

    def test_quoted_outranks_dash(self, result):
        quoted = next(entry for entry in result.items if entry.parser == "quoted")
        dashed = next(entry for entry in result.items if entry.parser == "dash")
        assert quoted.confidence > dashed.confidence

    def test_review_queue_uses_the_threshold(self, result):
        flagged = result.below(REVIEW_THRESHOLD)
        assert all(entry.confidence < REVIEW_THRESHOLD for entry in flagged)


class TestDjSetlist:
    def test_timestamped_cue_sheet(self):
        text = "\n".join(
            [
                "00:00 Bicep - Glue",
                "04:12 Overmono - So U Kno",
                "09:30 Four Tet – Baby",
            ]
        )
        result = extract_deterministic(text)
        assert [entry.hints.timestamp_s for entry in result.items] == [0, 252, 570]
        assert [entry.artist for entry in result.items] == ["Bicep", "Overmono", "Four Tet"]


class TestCsvImport:
    def test_header_csv(self):
        text = "Artist,Title,ISRC\nDaft Punk,Da Funk,USRC17607839\nJustice,Genesis,FRUM71200001"
        result = extract_deterministic(text)
        assert [entry.title for entry in result.items] == ["Da Funk", "Genesis"]
        assert result.items[0].hints.isrc == "USRC17607839"
        assert result.items[0].parser == "csv"
        assert result.residual == ()

    def test_ambiguous_headerless_csv_goes_to_review(self):
        result = extract_deterministic("Daft Punk,Da Funk\nJustice,Genesis")
        assert all(entry.confidence < REVIEW_THRESHOLD for entry in result.items)


class TestBareTitleList:
    def test_list_shaped_document_allows_bare_titles(self):
        result = extract_deterministic(
            "Bohemian Rhapsody\nStairway to Heaven\nHotel California\nImagine"
        )
        assert len(result.items) == 4
        assert all(entry.artist is None for entry in result.items)
        # Titles with no artist are weak queries and must reach the review flow.
        assert all(entry.confidence < REVIEW_THRESHOLD for entry in result.items)

    def test_article_does_not_produce_bare_titles(self):
        article = (
            "The festival opened on a warm Friday evening with a very long set.\n"
            "Later the headliner arrived and the crowd finally woke up again.\n"
            "By midnight the field was completely full and nobody wanted to leave."
        )
        result = extract_deterministic(article)
        assert result.items == ()
        assert len(result.residual) == 3


class TestSpanContract:
    def test_spans_index_normalized_text(self):
        # Zero-width characters are removed by normalization, so a span taken against
        # the raw input would drift. Everything must index document.text.
        result = extract_deterministic("Daft\u200b Punk - One More Time")
        item = result.items[0]
        assert item.span.slice(result.document.text) == "Daft Punk - One More Time"

    def test_document_can_be_passed_pre_normalized(self):
        document = SourceDocument.from_raw("Daft Punk - Da Funk")
        result = extract_deterministic(document)
        assert result.document is document
        assert result.items[0].title == "Da Funk"

    def test_digest_is_stable(self):
        assert SourceDocument.from_raw("a\r\nb").digest == SourceDocument.from_raw("a\nb").digest


class TestLimits:
    def test_oversized_input_is_rejected(self):
        with pytest.raises(InputTooLargeError) as excinfo:
            extract_deterministic("x" * (DEFAULT_MAX_INPUT_BYTES + 1))
        assert excinfo.value.limit == DEFAULT_MAX_INPUT_BYTES

    def test_limit_is_configurable(self):
        with pytest.raises(InputTooLargeError):
            extract_deterministic("Daft Punk - Da Funk", max_input_bytes=5)

    def test_limit_counts_utf8_bytes_not_characters(self):
        # A multi-byte document under the character count can still bust a byte cap.
        with pytest.raises(InputTooLargeError):
            extract_deterministic("世" * 10, max_input_bytes=20)


class TestEmptyAndDegenerateInput:
    @pytest.mark.parametrize("text", ["", "   ", "\n\n\n", "---\n***\n"])
    def test_no_items_and_no_crash(self, text):
        result = extract_deterministic(text)
        assert result.items == ()
        assert result.residual == ()

    def test_every_item_reports_its_method(self, result):
        assert all(entry.method is ExtractionMethod.DETERMINISTIC for entry in result.items)
