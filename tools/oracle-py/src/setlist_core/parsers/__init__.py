"""Deterministic parser registry (FR-002).

The registry is ordered by how explicitly each pattern labels its own structure. A tab
is a column boundary, quotes name the title outright, ``by`` says it in words, and a
dash only implies it by convention - so they are tried in that order and the first
claim wins.
"""

from dataclasses import replace

from setlist_core.models import Line
from setlist_core.parsers.affixes import strip_prefixes, strip_suffixes
from setlist_core.parsers.base import LineMatch, LineParser
from setlist_core.parsers.csv_table import TableSpec, detect_table, parse_table
from setlist_core.parsers.noise import is_list_shaped, looks_like_noise, looks_like_prose
from setlist_core.parsers.pair import parse_bare, parse_by, parse_dash, parse_quoted, parse_tab

__all__ = [
    "LINE_PARSERS",
    "LineMatch",
    "LineParser",
    "TableSpec",
    "detect_table",
    "is_list_shaped",
    "looks_like_noise",
    "looks_like_prose",
    "parse_line",
    "parse_table",
    "split_lines",
]

#: Tried in order; the first parser to claim the line wins.
LINE_PARSERS: tuple[LineParser, ...] = (parse_tab, parse_quoted, parse_by, parse_dash)


def split_lines(text: str) -> list[Line]:
    """Split normalized document text into lines carrying absolute offsets.

    Offsets are exact: line ``n`` starts at the sum of all preceding line lengths plus
    one newline each. Anything downstream that builds a `Span` depends on this.
    """
    lines: list[Line] = []
    offset = 0
    for raw in text.split("\n"):
        lines.append(Line(raw, offset))
        offset += len(raw) + 1
    return lines


def parse_line(line: Line, *, allow_bare: bool = False) -> LineMatch | None:
    """Run the deterministic parsers against a single line.

    Args:
        line: A line in document coordinates.
        allow_bare: Permit a separator-less line to parse as a title with no artist.
            Only pass ``True`` when `is_list_shaped` has approved the document.

    Returns:
        The winning `LineMatch`, or ``None`` if no parser claimed the line - in which
        case the caller routes it to the residual LLM pass.
    """
    if looks_like_noise(line.text):
        return None

    core, prefix_hints = strip_prefixes(line)
    core, suffix_hints = strip_suffixes(core)
    if not core.text.strip():
        return None

    affix_hints = prefix_hints.merge(suffix_hints)
    structured = affix_hints.position is not None or affix_hints.timestamp_s is not None

    match = _first_match(core, allow_bare=allow_bare)
    if match is None:
        return None
    return replace(
        match,
        hints=match.hints.merge(affix_hints),
        structured=match.structured or structured,
    )


def _first_match(core: Line, *, allow_bare: bool) -> LineMatch | None:
    """Return the first parser verdict for an affix-stripped line."""
    for parser in LINE_PARSERS:
        match = parser(core)
        if match is not None:
            return match
    return parse_bare(core) if allow_bare else None
