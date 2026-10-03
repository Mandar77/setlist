"""Whole-document CSV/TSV parsing (FR-002, "CSV columns").

This parser claims the entire document or none of it, because column meaning is a
document-level fact: one row of ``Daft Punk,One More Time`` is ambiguous, but a
hundred consistent rows under a ``artist,title`` header are not.

Rows are parsed one line at a time rather than by streaming `csv.reader` over the
whole file. That costs support for newlines inside quoted fields - vanishingly rare in
song lists - and buys exact character offsets for every row, which FR-003 spans
require.
"""

import csv
import io
import re
from dataclasses import dataclass

from setlist_core.models import Hints, Line
from setlist_core.normalize import (
    fold,
    normalize_isrc,
    parse_duration,
    split_artist_credits,
    strip_qualifiers,
)
from setlist_core.parsers.base import LineMatch
from setlist_core.parsers.noise import looks_like_noise

__all__ = ["TableSpec", "detect_table", "parse_table"]

_DELIMITERS = (",", "\t", ";", "|")
#: A table needs at least this many content rows before the shape means anything.
_MIN_ROWS = 2
#: Recognized header labels needed to accept a row as a header.
_MIN_HEADER_MATCHES = 2
_MAX_COLUMNS = 24
#: Values at or above this, when the column is numeric, are milliseconds not seconds.
_MS_THRESHOLD = 1000

_COLUMN_ALIASES: dict[str, frozenset[str]] = {
    "title": frozenset(
        {
            "title",
            "track",
            "song",
            "name",
            "track name",
            "song title",
            "track title",
            "song name",
            "titel",
        }
    ),
    "artist": frozenset(
        {"artist", "artists", "performer", "band", "artist name", "album artist", "artiste", "by"}
    ),
    "album": frozenset({"album", "release", "album name"}),
    "isrc": frozenset({"isrc", "isrc code"}),
    "duration": frozenset(
        {"duration", "length", "time", "runtime", "duration ms", "duration s", "track duration"}
    ),
    "year": frozenset({"year", "released", "release year", "release date", "date"}),
}

_YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2}|21\d{2})\b")
_ISRC_CELL_RE = re.compile(r"^[A-Za-z]{2}[A-Za-z0-9]{3}[-\s]?\d{2}[-\s]?\d{5}$")
_CLOCK_CELL_RE = re.compile(r"^(?:\d{1,2}:)?\d{1,2}:[0-5]\d$")
_YEAR_CELL_RE = re.compile(r"^(?:1[89]\d{2}|20\d{2}|21\d{2})$")

#: Rows needed before repeat-rate inference of the artist column is trustworthy.
_MIN_ROWS_FOR_INFERENCE = 5
#: How much more repetitive the artist column must be than the title column.
_REPEAT_MARGIN = 0.2
#: Fraction of cells in a column that must match a pattern to type the column by it.
_COLUMN_TYPE_RATIO = 0.8
#: Untyped columns needed before an artist/title split is even possible.
_MIN_PAIR_COLUMNS = 2


@dataclass(frozen=True, slots=True)
class TableSpec:
    """How to read a document that has been recognized as a table."""

    delimiter: str
    header_row: int | None
    #: Logical field name -> zero-based column index.
    columns: dict[str, int]
    #: True when column roles were guessed rather than read from a header, and the
    #: guess could not be corroborated from the data.
    ambiguous: bool = False

    @property
    def has_header(self) -> bool:
        """Whether a header row was found and should be skipped."""
        return self.header_row is not None

    @property
    def parser_name(self) -> str:
        """Confidence bucket this table's rows score against."""
        return "csv" if self.has_header or not self.ambiguous else "csv_headerless"


def _split_row(text: str, delimiter: str) -> list[str]:
    """Split one physical line with csv quoting rules applied."""
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, skipinitialspace=True)
    for row in reader:
        return [cell.strip() for cell in row]
    return []


def _match_header(cells: list[str]) -> dict[str, int]:
    """Map recognized header labels to column indices."""
    mapping: dict[str, int] = {}
    for index, cell in enumerate(cells):
        label = fold(cell)
        for field, aliases in _COLUMN_ALIASES.items():
            if label in aliases and field not in mapping:
                mapping[field] = index
    return mapping


def detect_table(lines: list[Line]) -> TableSpec | None:
    """Decide whether the document is a delimited table, and how to read it.

    Returns:
        A `TableSpec`, or ``None`` when the document is not consistently delimited.
        A header is not required: a headerless table with a stable column count is
        read as ``artist, title`` - the same convention the dash parser uses - and its
        rows are flagged ambiguous so they surface in review.
    """
    content = [line for line in lines if not looks_like_noise(line.text)]
    if len(content) < _MIN_ROWS:
        return None

    for delimiter in _DELIMITERS:
        rows = [_split_row(line.text, delimiter) for line in content]
        widths = {len(row) for row in rows}
        if len(widths) != 1:
            continue
        width = widths.pop()
        if not _MIN_PAIR_COLUMNS <= width <= _MAX_COLUMNS:
            continue

        columns = _match_header(rows[0])
        if "title" in columns or ("artist" in columns and len(columns) >= _MIN_HEADER_MATCHES):
            return TableSpec(delimiter=delimiter, header_row=0, columns=columns)
        return _infer_spec(delimiter, rows, width)
    return None


def _column(rows: list[list[str]], index: int) -> list[str]:
    """Return the non-empty cells of one column."""
    return [row[index].strip() for row in rows if index < len(row) and row[index].strip()]


def _typed_column(rows: list[list[str]], width: int, pattern: re.Pattern[str]) -> int | None:
    """Find the first column whose cells overwhelmingly match ``pattern``."""
    for index in range(width):
        cells = _column(rows, index)
        if not cells:
            continue
        hits = sum(1 for cell in cells if pattern.match(cell))
        if hits / len(cells) >= _COLUMN_TYPE_RATIO:
            return index
    return None


def _infer_spec(delimiter: str, rows: list[list[str]], width: int) -> TableSpec:
    """Assign column roles for a headerless table from cell content.

    ISRC, clock and year columns are recognized by shape. The artist/title split uses
    repetition: across a real tracklist, artists recur and titles do not, so the less
    distinct of the two candidate columns is the artist. When the margin is too thin
    to call - or the table is too short to measure - the spec is marked ambiguous and
    its rows land in review rather than being auto-accepted on a coin flip.
    """
    columns: dict[str, int] = {}
    typed: set[int] = set()
    for field, pattern in (
        ("isrc", _ISRC_CELL_RE),
        ("duration", _CLOCK_CELL_RE),
        ("year", _YEAR_CELL_RE),
    ):
        index = _typed_column(rows, width, pattern)
        if index is not None and index not in typed:
            columns[field] = index
            typed.add(index)

    remaining = [index for index in range(width) if index not in typed]
    if len(remaining) < _MIN_PAIR_COLUMNS:  # nothing to split artist from title
        columns["title"] = remaining[0] if remaining else 0
        return TableSpec(delimiter=delimiter, header_row=None, columns=columns, ambiguous=True)

    first, second = remaining[0], remaining[1]
    artist_index, title_index, ambiguous = _infer_direction(rows, first, second)
    columns["artist"] = artist_index
    columns["title"] = title_index
    if len(remaining) > _MIN_PAIR_COLUMNS and "album" not in columns:
        columns["album"] = remaining[2]
    return TableSpec(delimiter=delimiter, header_row=None, columns=columns, ambiguous=ambiguous)


def _infer_direction(rows: list[list[str]], first: int, second: int) -> tuple[int, int, bool]:
    """Pick the artist column of two candidates by comparing repeat rates."""
    left, right = _column(rows, first), _column(rows, second)
    if min(len(left), len(right)) < _MIN_ROWS_FOR_INFERENCE:
        return first, second, True

    left_distinct = len({fold(cell) for cell in left}) / len(left)
    right_distinct = len({fold(cell) for cell in right}) / len(right)
    if left_distinct + _REPEAT_MARGIN < right_distinct:
        return first, second, False
    if right_distinct + _REPEAT_MARGIN < left_distinct:
        return second, first, False
    # Both equally distinct: fall back to the dominant export order, artist first.
    return first, second, True


def _cell(cells: list[str], spec: TableSpec, field: str) -> str | None:
    """Read one logical field from a row, if the table has that column."""
    index = spec.columns.get(field)
    if index is None or index >= len(cells):
        return None
    value = cells[index].strip()
    return value or None


def _duration_seconds(raw: str) -> float | None:
    """Interpret a duration cell as ``mm:ss``, milliseconds, or seconds."""
    clock = parse_duration(raw)
    if clock is not None:
        return clock
    try:
        number = float(raw)
    except ValueError:
        return None
    if number <= 0:
        return None
    return number / 1000.0 if number >= _MS_THRESHOLD else number


def parse_table(lines: list[Line], spec: TableSpec) -> list[LineMatch]:
    """Parse every data row of a recognized table into matches."""
    matches: list[LineMatch] = []

    for index, line in enumerate(lines):
        if looks_like_noise(line.text):
            continue
        if (
            spec.header_row is not None
            and not matches
            and _match_header(_split_row(line.text, spec.delimiter))
        ):
            # Skip the header itself; guarded on `not matches` so a data row that
            # happens to contain the word "title" later in the file is still parsed.
            continue

        cells = _split_row(line.text, spec.delimiter)
        raw_title = _cell(cells, spec, "title")
        if not raw_title:
            continue

        title, qualifiers, featured, version_label = strip_qualifiers(raw_title)
        if not title:
            continue

        artist: str | None = None
        credited: tuple[str, ...] = ()
        raw_artist = _cell(cells, spec, "artist")
        if raw_artist:
            artist, credited = split_artist_credits(raw_artist)
            artist = artist or None

        span = line.span
        if span is None:
            continue

        matches.append(
            LineMatch(
                title=title,
                artist=artist,
                span=span,
                parser=spec.parser_name,
                hints=Hints(
                    album=_cell(cells, spec, "album"),
                    year=_parse_year(_cell(cells, spec, "year")),
                    isrc=_parse_isrc(_cell(cells, spec, "isrc")),
                    duration_s=_parse_duration_cell(_cell(cells, spec, "duration")),
                    featured_artists=tuple(dict.fromkeys(featured + credited)),
                    qualifiers=qualifiers,
                    version_label=version_label,
                    position=index + 1,
                ),
                ambiguous_direction=spec.ambiguous,
                structured=True,
            )
        )
    return matches


def _parse_year(raw: str | None) -> int | None:
    """Pull a four-digit year out of a year or release-date cell."""
    if not raw:
        return None
    match = _YEAR_RE.search(raw)
    return int(match.group(1)) if match else None


def _parse_isrc(raw: str | None) -> str | None:
    """Validate an ISRC cell, discarding malformed values."""
    return normalize_isrc(raw) if raw else None


def _parse_duration_cell(raw: str | None) -> float | None:
    """Interpret a duration cell, discarding unparseable values."""
    return _duration_seconds(raw) if raw else None
