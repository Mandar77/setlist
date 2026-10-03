"""The anti-hallucination gate (FR-003, PRD S7.9.4).

Every item - deterministic or LLM-produced - must prove that the text it claims to
have come from actually says so. An item whose span does not contain its own title is
rejected, which is what makes "no hallucinated songs" (G2) a structural property
rather than a hope about model behaviour.

The check is token coverage rather than substring equality, because legitimate
extraction normalizes: ``"Jay-Z & Kanye"`` may be reported as ``"Jay-Z and Kanye"``,
and a title may lose a bracketed qualifier that the parser moved into `Hints`.
"""

from setlist_core.enums import RejectReason
from setlist_core.models import MAX_TITLE_LENGTH, RejectedItem, SourceDocument, Span
from setlist_core.normalize import tokens

__all__ = [
    "ARTIST_COVERAGE",
    "MAX_GROUNDING_SPAN",
    "TITLE_COVERAGE",
    "coverage",
    "ground",
]

#: An item's span may not exceed this many characters. Without a cap, a span covering
#: the whole document would trivially "contain" any title an attacker or a confused
#: model cared to invent.
MAX_GROUNDING_SPAN = 400
#: Fraction of title tokens that must appear in the span text.
TITLE_COVERAGE = 0.7
#: Artists tolerate more drift - collaborator lists get reordered and abbreviated.
ARTIST_COVERAGE = 0.6


def coverage(claim: tuple[str, ...], source: frozenset[str]) -> float:
    """Fraction of ``claim`` tokens present in ``source``.

    An empty claim is fully covered: nothing was asserted, so nothing is unsupported.
    """
    if not claim:
        return 1.0
    return sum(1 for token in claim if token in source) / len(claim)


def ground(  # noqa: PLR0911 - one early return per rejection reason reads better
    document: SourceDocument,
    *,
    title: str,
    artist: str | None,
    span: Span,
    parser: str,
) -> RejectedItem | None:
    """Verify that ``span`` supports the claimed title and artist.

    Args:
        document: The normalized document the span indexes into.
        title: The claimed track title.
        artist: The claimed artist, if any.
        span: The source span the item cites.
        parser: Producing rule, recorded on any rejection for auditability.

    Returns:
        ``None`` when the item is grounded, otherwise a `RejectedItem` explaining
        which check failed. Callers must drop any item that gets a rejection back.
    """
    if not title.strip():
        return RejectedItem(
            title=title, artist=artist, reason=RejectReason.EMPTY_TITLE, parser=parser
        )
    if len(title) > MAX_TITLE_LENGTH:
        return RejectedItem(
            title=title[:MAX_TITLE_LENGTH],
            artist=artist,
            reason=RejectReason.TITLE_TOO_LONG,
            detail=f"{len(title)} characters",
            span=span,
            parser=parser,
        )
    if not span.within(document.text):
        return RejectedItem(
            title=title,
            artist=artist,
            reason=RejectReason.SPAN_OUT_OF_RANGE,
            detail=f"span ends at {span.end}, document is {len(document.text)} characters",
            parser=parser,
        )
    if span.end - span.start > MAX_GROUNDING_SPAN:
        return RejectedItem(
            title=title,
            artist=artist,
            reason=RejectReason.SPAN_OUT_OF_RANGE,
            detail=f"span covers {span.end - span.start} characters, limit {MAX_GROUNDING_SPAN}",
            span=span,
            parser=parser,
        )

    source = frozenset(tokens(span.slice(document.text)))
    title_score = coverage(tokens(title), source)
    if title_score < TITLE_COVERAGE:
        return RejectedItem(
            title=title,
            artist=artist,
            reason=RejectReason.SPAN_TEXT_MISMATCH,
            detail=f"title token coverage {title_score:.2f} < {TITLE_COVERAGE}",
            span=span,
            parser=parser,
        )

    if artist:
        artist_score = coverage(tokens(artist), source)
        if artist_score < ARTIST_COVERAGE:
            return RejectedItem(
                title=title,
                artist=artist,
                reason=RejectReason.SPAN_TEXT_MISMATCH,
                detail=f"artist token coverage {artist_score:.2f} < {ARTIST_COVERAGE}",
                span=span,
                parser=parser,
            )
    return None
