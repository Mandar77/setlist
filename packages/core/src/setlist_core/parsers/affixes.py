"""Strip list scaffolding off a line before pattern parsing.

Real-world song lists wrap the actual "artist - title" payload in ordinals, bullets,
DJ cue timestamps, trailing run times and stray ISRCs. Peeling those first means the
pair parsers only ever see the payload, and the peeled values become structured hints
instead of noise inside a title.

Every function here preserves document coordinates: the returned `Line` carries an
offset adjusted by exactly the number of characters consumed, so spans built from it
still point at the right characters in `SourceDocument.text`.
"""

import re

from setlist_core.models import Hints, Line
from setlist_core.normalize import normalize_isrc, parse_duration

__all__ = ["strip_prefixes", "strip_suffixes"]

_BULLETS = "-*•‣·◦⁃∙>+"

# "1. ", "12) ", "#3 - ", "[4] " - capped at three digits so a leading year such as
# "1979 - Smashing Pumpkins" is never mistaken for an ordinal.
_ORDINAL_RE = re.compile(r"^\s*#?\s*(?P<n>\d{1,3})\s*[.)\]:–—-]\s+")
_BRACKET_ORDINAL_RE = re.compile(r"^\s*[\[(]\s*(?P<n>\d{1,3})\s*[\])]\s*[.)–—-]?\s+")
_BULLET_RE = re.compile(rf"^\s*[{re.escape(_BULLETS)}]\s+")
# "00:03", "[1:02:17]", "(4:21) " - DJ cue sheets and timestamped tracklists.
_TIMESTAMP_RE = re.compile(
    r"^\s*[\[(]?\s*(?P<t>(?:\d{1,2}:)?\d{1,2}:[0-5]\d)\s*[\])]?\s*[.)–—-]?\s+"
)
_LEADING_PUNCT_RE = re.compile(r"^\s*[|–—]\s+")

# Trailing run time: "... (3:45)" or "... [03:45]". A bare trailing "3:45" is not
# consumed - too easy to swallow a real title such as "9:30".
_TRAILING_DURATION_RE = re.compile(r"\s*[\[(]\s*(?P<t>(?:\d{1,2}:)?\d{1,2}:[0-5]\d)\s*[\])]\s*$")
_TRAILING_ISRC_RE = re.compile(
    r"\s*[\[(]?\s*(?:ISRC[:\s]*)?(?P<isrc>[A-Za-z]{2}[A-Za-z0-9]{3}[-\s]?\d{2}[-\s]?\d{5})"
    r"\s*[\])]?\s*$"
)


def _advance(line: Line, consumed: int) -> Line:
    """Return ``line`` with its first ``consumed`` characters removed."""
    return Line(line.text[consumed:], line.offset + consumed)


def strip_prefixes(line: Line) -> tuple[Line, Hints]:
    """Peel ordinals, bullets and cue timestamps off the front of a line.

    Applied repeatedly, so ``"3. [00:14] Artist - Title"`` yields position 3, timestamp
    14 s, and a line starting at ``"Artist"``.

    Returns:
        The remaining line and the hints recovered from what was peeled.
    """
    position: int | None = None
    timestamp_s: int | None = None
    current = line

    while current.text:
        ordinal = _ORDINAL_RE.match(current.text) or _BRACKET_ORDINAL_RE.match(current.text)
        if ordinal and position is None:
            # Zero-indexed lists exist ("0. ..."). The marker is still scaffolding and
            # is consumed, but `position` is a 1-based ordinal, so 0 is not recorded.
            value = int(ordinal.group("n"))
            position = value if value >= 1 else None
            current = _advance(current, ordinal.end())
            continue

        stamp = _TIMESTAMP_RE.match(current.text)
        if stamp and timestamp_s is None:
            seconds = parse_duration(stamp.group("t"))
            if seconds is not None:
                timestamp_s = int(seconds)
                current = _advance(current, stamp.end())
                continue

        bullet = _BULLET_RE.match(current.text)
        if bullet:
            current = _advance(current, bullet.end())
            continue

        leading = _LEADING_PUNCT_RE.match(current.text)
        if leading:
            current = _advance(current, leading.end())
            continue
        break

    # Drop any remaining indentation so spans start at the first real character.
    stripped = current.text.lstrip()
    current = _advance(current, len(current.text) - len(stripped))

    return current, Hints(position=position, timestamp_s=timestamp_s)


def strip_suffixes(line: Line) -> tuple[Line, Hints]:
    """Peel a trailing run time and ISRC off the end of a line.

    Returns:
        The remaining line and the hints recovered from what was peeled.
    """
    text = line.text
    duration_s: float | None = None
    isrc: str | None = None

    for _ in range(2):  # at most one duration and one ISRC, in either order
        isrc_match = _TRAILING_ISRC_RE.search(text)
        if isrc_match and isrc is None:
            candidate = normalize_isrc(isrc_match.group("isrc"))
            if candidate is not None:
                isrc = candidate
                text = text[: isrc_match.start()]
                continue

        duration_match = _TRAILING_DURATION_RE.search(text)
        if duration_match and duration_s is None:
            duration_s = parse_duration(duration_match.group("t"))
            if duration_s is not None:
                text = text[: duration_match.start()]
                continue
        break

    trimmed = text.rstrip(" \t.,;")
    return Line(trimmed, line.offset), Hints(duration_s=duration_s, isrc=isrc)
