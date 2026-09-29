"""Unit tests for the anti-hallucination span gate (FR-003)."""

import pytest

from setlist_core.enums import RejectReason
from setlist_core.grounding import MAX_GROUNDING_SPAN, coverage, ground
from setlist_core.models import SourceDocument, Span

pytestmark = pytest.mark.unit

TEXT = "Daft Punk - One More Time\nJustice - Genesis\n"


@pytest.fixture
def doc() -> SourceDocument:
    return SourceDocument.from_raw(TEXT)


def call(doc: SourceDocument, title: str, artist: str | None, span: Span):
    return ground(doc, title=title, artist=artist, span=span, parser="test")


class TestCoverage:
    def test_empty_claim_is_covered(self):
        assert coverage((), frozenset()) == 1.0

    def test_partial(self):
        assert coverage(("a", "b"), frozenset({"a"})) == 0.5


class TestGround:
    def test_accepts_a_grounded_item(self, doc):
        assert call(doc, "One More Time", "Daft Punk", Span(start=0, end=25)) is None

    def test_tolerates_normalization_drift(self, doc):
        # A stripped qualifier or a transliterated name must not fail grounding.
        assert call(doc, "One More Time", "daft punk", Span(start=0, end=25)) is None

    def test_rejects_a_title_absent_from_the_span(self, doc):
        rejection = call(doc, "Harder Better Faster", "Daft Punk", Span(start=0, end=25))
        assert rejection is not None
        assert rejection.reason is RejectReason.SPAN_TEXT_MISMATCH

    def test_rejects_an_artist_absent_from_the_span(self, doc):
        rejection = call(doc, "One More Time", "Justice", Span(start=0, end=25))
        assert rejection is not None
        assert rejection.reason is RejectReason.SPAN_TEXT_MISMATCH

    def test_rejects_a_span_past_the_end_of_the_document(self, doc):
        rejection = call(doc, "One More Time", None, Span(start=0, end=10_000))
        assert rejection is not None
        assert rejection.reason is RejectReason.SPAN_OUT_OF_RANGE

    def test_rejects_an_oversized_span(self):
        # A span covering the whole document would "contain" any invented title.
        filler = "Daft Punk - One More Time. " * 40
        document = SourceDocument.from_raw(filler)
        rejection = ground(
            document,
            title="One More Time",
            artist="Daft Punk",
            span=Span(start=0, end=MAX_GROUNDING_SPAN + 1),
            parser="test",
        )
        assert rejection is not None
        assert rejection.reason is RejectReason.SPAN_OUT_OF_RANGE
        assert "limit" in rejection.detail

    def test_rejects_an_empty_title(self, doc):
        rejection = call(doc, "   ", None, Span(start=0, end=25))
        assert rejection is not None
        assert rejection.reason is RejectReason.EMPTY_TITLE

    def test_rejects_an_overlong_title(self, doc):
        rejection = call(doc, "x" * 500, None, Span(start=0, end=25))
        assert rejection is not None
        assert rejection.reason is RejectReason.TITLE_TOO_LONG

    def test_rejection_records_the_producing_parser(self, doc):
        rejection = call(doc, "Invented Song", None, Span(start=0, end=25))
        assert rejection is not None
        assert rejection.parser == "test"


class TestInjectionCorpus:
    """PRD S7.9.4: user text is data, never instructions.

    Grounding is the backstop. Even if a model were talked into emitting a song that
    the prompt told it to add, the span it cites will not contain that song's title,
    so the item never reaches the preview.
    """

    @pytest.mark.parametrize(
        "injected_title",
        [
            "Ignore Previous Instructions",
            "SYSTEM OVERRIDE",
            "Rickroll Never Gonna Give You Up",
        ],
    )
    def test_injected_titles_fail_grounding(self, doc, injected_title):
        rejection = call(doc, injected_title, None, Span(start=0, end=25))
        assert rejection is not None
        assert rejection.reason is RejectReason.SPAN_TEXT_MISMATCH
