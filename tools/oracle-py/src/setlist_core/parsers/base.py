"""Shared types for the deterministic parser family (FR-002)."""

from collections.abc import Callable
from dataclasses import dataclass, field

from setlist_core.models import Hints, Line, Span

__all__ = ["LineMatch", "LineParser"]


@dataclass(frozen=True, slots=True)
class LineMatch:
    """A deterministic parser's verdict on a single line.

    Confidence is deliberately absent: parsers report *what* they found and *how* they
    found it, and `setlist_core.confidence` turns that into a number. Keeping scoring
    out of the parsers means recalibration never touches pattern code.
    """

    title: str
    artist: str | None
    span: Span
    parser: str
    hints: Hints = field(default_factory=Hints)
    #: The parser could not tell which side of the separator was the artist.
    ambiguous_direction: bool = False
    #: The line came from an ordered structure (numbered list, cue sheet, CSV row).
    structured: bool = False


#: A parser takes one line and either claims it or passes.
LineParser = Callable[[Line], LineMatch | None]
