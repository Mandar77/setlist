"""Pattern parsers that split a line into (artist, title) - FR-002.

Each parser receives a line that affix stripping has already reduced to its payload,
and returns a `LineMatch` or passes. They are tried in descending order of how
self-labelling the pattern is: a quoted title states which side it is, ``by`` states
it in words, and a bare dash only implies it by convention.
"""

import re

from setlist_core.models import Hints, Line
from setlist_core.normalize import (
    has_version_annotation,
    normalize_artist,
    split_artist_credits,
    strip_qualifiers,
)
from setlist_core.parsers.base import LineMatch
from setlist_core.parsers.noise import BARE_TITLE_WORD_LIMIT, looks_like_prose

__all__ = ["parse_bare", "parse_by", "parse_dash", "parse_quoted", "parse_tab"]

# Double quotes only. Apostrophes are far too common inside real titles
# ("Sweet Child o' Mine") to treat as delimiters.
_OPEN = '"“«'
_CLOSE = '"”»'
_Q = f"[{_OPEN}]"
_QC = f"[{_CLOSE}]"

_QUOTED_RIGHT_RE = re.compile(rf"^(?P<artist>.+?)\s*[-:–—]\s*{_Q}(?P<title>[^{_CLOSE}]+){_QC}\s*$")
_QUOTED_LEFT_RE = re.compile(
    rf"^{_Q}(?P<title>[^{_CLOSE}]+){_QC}\s*(?:[-–—]|\bby\b)\s*(?P<artist>.+)$",
    re.IGNORECASE,
)
_BY_RE = re.compile(r"^(?P<title>.+?)\s+by\s+(?P<artist>.+)$", re.IGNORECASE)
# " - " needs surrounding space so hyphenated names survive; en/em dashes do not,
# because they effectively never appear inside an artist or title token.
_SEPARATOR_RE = re.compile(r"\s+[-~|/•·]\s+|\s*[–—―]\s*")
_TAB_RE = re.compile(r"^(?P<left>[^\t]+?)\t+(?P<right>[^\t]+)$")

#: An artist credit longer than this is a sentence clause, not a name. Six covers
#: "Nick Cave and the Bad Seeds" and "Crosby, Stills, Nash & Young".
_MAX_ARTIST_WORDS = 6
#: A title longer than this is a mis-split rather than a track name.
_MAX_TITLE_WORDS = 12
#: A credit starting with one of these is a noun phrase, not an artist. Bands do
#: begin with "The", which is why that is absent.
_DETERMINERS = frozenset(
    {
        "a",
        "an",
        "my",
        "our",
        "your",
        "their",
        "his",
        "her",
        "its",
        "this",
        "that",
        "these",
        "those",
        "some",
        "any",
        "every",
    }
)
#: Participles that turn "X by Y" into a credit rather than a song. Checked against
#: the word immediately before "by", which is what distinguishes
#: "Our picks, compiled by the editors" from "Midnight City by M83".
_CREDIT_PARTICIPLES = frozenset(
    {
        "written",
        "produced",
        "mixed",
        "mastered",
        "composed",
        "arranged",
        "compiled",
        "curated",
        "edited",
        "published",
        "released",
        "uploaded",
        "posted",
        "submitted",
        "recorded",
        "directed",
        "assembled",
        "selected",
        "chosen",
        "picked",
        "ranked",
        "presented",
        "sourced",
        "sponsored",
        "inspired",
        "brought",
        "made",
        "created",
        "reviewed",
    }
)
#: Production-credit lines look exactly like "Title by Artist" but name no song.
_CREDIT_PREFIX_RE = re.compile(
    r"^(?:written|produced|mixed|mastered|composed|arranged|compiled|curated|edited"
    r"|published|released|uploaded|posted|submitted|recorded|directed|photo|photos"
    r"|images?|artwork|inspired)\b",
    re.IGNORECASE,
)


def _build(
    line: Line,
    title_raw: str,
    artist_raw: str | None,
    parser: str,
    *,
    ambiguous_direction: bool = False,
) -> LineMatch | None:
    """Normalize a raw (title, artist) split into a `LineMatch`, or reject it."""
    title, qualifiers, featured, version_label = strip_qualifiers(title_raw)
    if not title or len(title.split()) > _MAX_TITLE_WORDS:
        return None

    artist: str | None = None
    credited: tuple[str, ...] = ()
    if artist_raw:
        artist, credited = split_artist_credits(artist_raw)
        artist = artist or None

    span = line.span
    if span is None:
        return None

    merged = tuple(dict.fromkeys(featured + credited))
    return LineMatch(
        title=title,
        artist=artist,
        span=span,
        parser=parser,
        hints=Hints(
            featured_artists=merged,
            qualifiers=qualifiers,
            version_label=version_label,
        ),
        ambiguous_direction=ambiguous_direction,
    )


def parse_quoted(line: Line) -> LineMatch | None:
    """Parse lines where quotation marks identify the title.

    Handles both ``Artist - "Title"`` and ``"Title" - Artist`` / ``"Title" by Artist``.
    """
    right = _QUOTED_RIGHT_RE.match(line.text)
    if right:
        return _build(line, right.group("title"), right.group("artist"), "quoted")
    left = _QUOTED_LEFT_RE.match(line.text)
    if left:
        return _build(line, left.group("title"), left.group("artist"), "quoted")
    return None


def parse_by(line: Line) -> LineMatch | None:  # noqa: PLR0911 - one guard, one return
    """Parse ``Title by Artist``.

    The artist side is length-capped: without that, a sentence such as "This list was
    compiled by our editors" parses as a song.
    """
    if _CREDIT_PREFIX_RE.match(line.text):
        return None
    match = _BY_RE.match(line.text)
    if not match:
        return None
    title_side = match.group("title").strip()
    trailing = title_side.split()
    if trailing and trailing[-1].strip(",;:").lower() in _CREDIT_PARTICIPLES:
        return None

    artist = normalize_artist(match.group("artist"))
    if not artist or len(artist.split()) > _MAX_ARTIST_WORDS:
        return None
    if artist.split()[0].lower() in _DETERMINERS:
        return None
    if re.search(r"\bby\b", artist, re.IGNORECASE):
        return None
    return _build(line, match.group("title"), artist, "by")


def _direction(left: str, right: str) -> tuple[str, str, bool]:
    """Decide which side of a separator is the artist.

    Returns:
        An ``(artist, title, ambiguous)`` triple. The default is artist-first, the
        convention PRD S5 FR-002 names ("Artist - Title"); a version annotation on one
        side overrides it, since those attach to titles.
    """
    left_titleish = has_version_annotation(left)
    right_titleish = has_version_annotation(right)
    if left_titleish and not right_titleish:
        return right, left, False
    return left, right, left_titleish and right_titleish


def parse_dash(line: Line) -> LineMatch | None:
    """Parse ``Artist - Title`` and its dash/pipe/bullet separator variants."""
    parts = _SEPARATOR_RE.split(line.text, maxsplit=1)
    if len(parts) != 2:  # noqa: PLR2004 - split with maxsplit=1 yields one or two parts
        return None
    left, right = parts[0].strip(), parts[1].strip()
    if not left or not right:
        return None
    artist, title, ambiguous = _direction(left, right)
    # An artist credit is a name, not a clause. This is the main defence against a
    # prose sentence that happens to contain " - " parsing as a track.
    if len(artist.split()) > _MAX_ARTIST_WORDS:
        return None
    return _build(line, title, artist, "dash", ambiguous_direction=ambiguous)


def parse_tab(line: Line) -> LineMatch | None:
    """Parse a tab-separated pair.

    A stray tab carries no convention about column order the way a dash does, so the
    result is always flagged ambiguous and lands in review. Whole-document TSV goes
    through the table parser instead, which can read a header row.
    """
    match = _TAB_RE.match(line.text)
    if not match:
        return None
    left, right = match.group("left").strip(), match.group("right").strip()
    if not left or not right:
        return None
    return _build(line, right, left, "tab", ambiguous_direction=True)


def parse_bare(line: Line) -> LineMatch | None:
    """Parse a separator-less line as a title with no artist.

    Only safe on documents that `noise.is_list_shaped` has already judged to be lists;
    the registry enforces that gate. Even then the result is low confidence, because a
    title alone is a weak query against any provider catalog.
    """
    text = line.text.strip()
    if not text or looks_like_prose(text) or len(text.split()) > BARE_TITLE_WORD_LIMIT:
        return None
    return _build(line, text, None, "bare")
