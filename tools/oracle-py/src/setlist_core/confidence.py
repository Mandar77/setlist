"""Confidence calibration for extracted items (FR-004).

Every number that influences a confidence score lives in this module. PRD Open
Question #4 defers final thresholds to the first golden-set calibration, so keeping the
constants in one file means recalibration is a single diff plus an accuracy-gate rerun,
not an archaeology exercise across the parser family.

Precedence is fixed by PRD S7.9.5: deterministic > LLM-grounded > LLM-ungrounded, and
the last of those never produces an item at all.
"""

from collections.abc import Iterable

from setlist_core.enums import ExtractionMethod
from setlist_core.models import Hints

__all__ = [
    "AUTO_ACCEPT_THRESHOLD",
    "BASE_CONFIDENCE",
    "NOT_FOUND_THRESHOLD",
    "REVIEW_THRESHOLD",
    "clamp",
    "deterministic_confidence",
    "method_ceiling",
]

# --------------------------------------------------------------------- thresholds
# FR-007: items below this go to the human-in-the-loop review queue.
REVIEW_THRESHOLD = 0.8
# PRD S7.10.4 match confidence bands.
AUTO_ACCEPT_THRESHOLD = 0.8
NOT_FOUND_THRESHOLD = 0.5

# --------------------------------------------------------- parser base confidence
# A deterministic parser's base score reflects how unambiguous its pattern is, not how
# often it fires. "dash" is common but genuinely ambiguous about which side is the
# artist; "quoted" is rarer but self-labelling, so it scores higher.
BASE_CONFIDENCE: dict[str, float] = {
    "csv": 0.97,
    # A headerless table whose column order could not be corroborated from the data.
    # Scored so that the ambiguity penalty lands it under review rather than
    # auto-accepting a coin flip about which column held the artist.
    "csv_headerless": 0.80,
    "quoted": 0.95,
    "by": 0.92,
    "dash": 0.90,
    "tab": 0.93,
    # A bare line with no separator: a title with no artist. Parsed, but always sent to
    # review - FR-007 exists precisely for this case.
    "bare": 0.55,
}

# ------------------------------------------------------------------- adjustments
#: The separator could not disambiguate artist from title (e.g. neither side is quoted
#: and both look like plausible names).
PENALTY_AMBIGUOUS_DIRECTION = -0.12
#: No artist was recovered; matching has only a title to work with.
PENALTY_NO_ARTIST = -0.25
#: A single-token title is a weak signal ("Home", "Alive" match thousands of tracks).
PENALTY_SHORT_TITLE = -0.05
#: The title has no alphanumeric content at all - a mis-split, not a song. Numeric and
#: symbolic titles are deliberately *not* penalized here: "1979", "99 Problems" and
#: "10%" are all real tracks.
PENALTY_DEGENERATE_TITLE = -0.35
#: An ISRC in the source is the canonical key; matching becomes near-exact.
BONUS_ISRC = 0.03
#: A duration lets the matcher reject wrong-length recordings.
BONUS_DURATION = 0.02
#: The line came from an ordered structure (numbered list, CSV row, cue sheet), which
#: corroborates that it is a track entry rather than prose.
BONUS_STRUCTURED = 0.02

#: Ceiling applied per extraction method so an LLM item can never outrank a
#: deterministic one on identical evidence.
_METHOD_CEILING: dict[ExtractionMethod, float] = {
    ExtractionMethod.DETERMINISTIC: 1.0,
    ExtractionMethod.HYBRID: 1.0,
    ExtractionMethod.LLM_GROUNDED: 0.85,
    ExtractionMethod.LLM_UNGROUNDED: 0.0,
}


def clamp(value: float) -> float:
    """Constrain a score to the ``[0, 1]`` interval required by FR-004."""
    return min(1.0, max(0.0, value))


def method_ceiling(method: ExtractionMethod) -> float:
    """Return the maximum confidence an item produced by ``method`` may carry."""
    return _METHOD_CEILING[method]


def deterministic_confidence(
    parser: str,
    title: str,
    artist: str | None,
    hints: Hints,
    *,
    ambiguous_direction: bool = False,
    structured: bool = False,
) -> float:
    """Score a deterministically parsed item.

    Args:
        parser: Name of the rule that produced the item; keys `BASE_CONFIDENCE`.
        title: The parsed title, after qualifier stripping.
        artist: The parsed artist, if one was recovered.
        hints: Structured side information already attached to the item.
        ambiguous_direction: The parser could not tell artist from title.
        structured: The item came from an ordered list, CSV row, or cue sheet.

    Returns:
        A confidence in ``[0, 1]``.
    """
    adjustments: list[float] = []
    if ambiguous_direction:
        adjustments.append(PENALTY_AMBIGUOUS_DIRECTION)
    if not artist:
        adjustments.append(PENALTY_NO_ARTIST)
    if len(title.split()) == 1:
        adjustments.append(PENALTY_SHORT_TITLE)
    if not any(ch.isalnum() for ch in title):
        adjustments.append(PENALTY_DEGENERATE_TITLE)
    if hints.isrc:
        adjustments.append(BONUS_ISRC)
    if hints.duration_s:
        adjustments.append(BONUS_DURATION)
    if structured:
        adjustments.append(BONUS_STRUCTURED)

    base = BASE_CONFIDENCE.get(parser, BASE_CONFIDENCE["bare"])
    return _apply(base, adjustments, ExtractionMethod.DETERMINISTIC)


def _apply(base: float, adjustments: Iterable[float], method: ExtractionMethod) -> float:
    """Sum adjustments onto ``base`` and clamp to the method ceiling."""
    return min(clamp(base + sum(adjustments)), method_ceiling(method))
