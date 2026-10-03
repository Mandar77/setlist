"""Text normalization: document canonicalization, qualifier stripping, dedup keys.

Two distinct kinds of normalization live here and must not be confused:

1. **Document normalization** (`normalize_document`) produces the canonical text that
   every `Span` indexes into. It is applied exactly once, at ingest.
2. **Key folding** (`fold`, `dedupe_key`) produces lossy comparison keys. It is never
   written back into user-visible fields and never affects span offsets.
"""

import re
import unicodedata

from anyascii import anyascii

from setlist_core.enums import Qualifier

__all__ = [
    "ISRC_RE",
    "dedupe_key",
    "fold",
    "has_version_annotation",
    "normalize_artist",
    "normalize_document",
    "normalize_isrc",
    "parse_duration",
    "split_artist_credits",
    "split_featured",
    "strip_qualifiers",
    "tokens",
]

# Zero-width and bidi-control characters. These are invisible, survive NFKC, and are a
# documented prompt-injection and homoglyph vector - the payload test matrix (PRD S10)
# fuzzes them explicitly.
_INVISIBLE = frozenset(
    "\u00ad"  # soft hyphen
    "\u200b\u200c\u200d\u200e\u200f"  # ZWSP / ZWNJ / ZWJ / LRM / RLM
    "\u2060\u2061\u2062\u2063\u2064"  # word joiner, invisible operators
    "\u202a\u202b\u202c\u202d\u202e"  # bidi embedding / override
    "\u2066\u2067\u2068\u2069"  # bidi isolates
    "\ufeff"  # BOM / ZWNBSP
)

_ISRC_STRIP_RE = re.compile(r"[\s\-]+")
ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")

_DURATION_RE = re.compile(r"^(?:(?P<h>\d{1,2}):)?(?P<m>\d{1,3}):(?P<s>[0-5]\d)$")

# Trailing "(...)" or "[...]" with no nested brackets.
_TRAILING_BRACKET_RE = re.compile(r"\s*[(\[]\s*([^()\[\]]*?)\s*[)\]]\s*$")
# Trailing " - annotation" (en/em dash included). Only consumed when the tail classifies
# as a known annotation, so ordinary hyphenated titles survive intact.
_DASHES = "\\-\u2010-\u2015\u2212"
_TRAILING_DASH_RE = re.compile(rf"\s+[{_DASHES}]\s+([^{_DASHES}]+?)\s*$")

_FEAT_RE = re.compile(r"^(?:feat\.?|ft\.?|featuring|w\.?/)\s+(?P<who>.+)$", re.IGNORECASE)
_INLINE_FEAT_RE = re.compile(r"\s+(?:feat\.|ft\.|featuring)\s+(?P<who>.+)$", re.IGNORECASE)
_ARTIST_SPLIT_RE = re.compile(r"\s*(?:,|&|\bx\b|\bvs\.?\b|\band\b|\+)\s*", re.IGNORECASE)

# Order matters only for readability; every pattern is tested against each annotation.
_QUALIFIER_PATTERNS: tuple[tuple[re.Pattern[str], Qualifier], ...] = (
    (re.compile(r"\blive\b", re.IGNORECASE), Qualifier.LIVE),
    (re.compile(r"\bremaster(?:ed)?\b", re.IGNORECASE), Qualifier.REMASTER),
    (re.compile(r"\bre-?mix(?:ed|es)?\b|\b\w+\s+mix\b", re.IGNORECASE), Qualifier.REMIX),
    (re.compile(r"\bacoustic\b|\bunplugged\b", re.IGNORECASE), Qualifier.ACOUSTIC),
    (re.compile(r"\binstrumental\b", re.IGNORECASE), Qualifier.INSTRUMENTAL),
    (re.compile(r"\bradio\s+(?:edit|mix|version)\b", re.IGNORECASE), Qualifier.RADIO_EDIT),
    (re.compile(r"\bextended\b", re.IGNORECASE), Qualifier.EXTENDED),
    (re.compile(r"\bdemo\b", re.IGNORECASE), Qualifier.DEMO),
    (re.compile(r"\bcover\b", re.IGNORECASE), Qualifier.COVER),
    (re.compile(r"\bkaraoke\b", re.IGNORECASE), Qualifier.KARAOKE),
)

# "Extended Mix" / "Original Mix" are the label's own master, not a third-party remix.
# The generic "<word> Mix" pattern would otherwise tag them REMIX and send the matcher
# hunting for a remix that does not exist.
_NON_REMIX_MIX_RE = re.compile(
    r"^(?:extended|original|album|radio|single|main|final|full)\s+mix$",
    re.IGNORECASE,
)

# Annotations that are version markers but carry no qualifier of their own; peeling them
# still improves the match key (e.g. "(Original Mix)", "(Single Version)").
_BARE_VERSION_RE = re.compile(
    r"^(?:original|single|album|deluxe|explicit|clean|bonus|stereo|mono)"
    r"(?:\s+(?:mix|version|edit|track|master|cut))?$",
    re.IGNORECASE,
)

_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def normalize_document(raw: str) -> str:
    r"""Canonicalize a raw input document into span coordinate space.

    Applies Unicode NFKC, normalizes line endings to ``\n``, removes invisible
    formatting characters, and strips control characters other than tab and newline.
    Length is **not** preserved - see the span contract in the package README.

    Args:
        raw: Text exactly as pasted or uploaded.

    Returns:
        The normalized document. All `Span` offsets index into this string.
    """
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = unicodedata.normalize("NFKC", text)
    stripped = "".join(
        ch
        for ch in text
        if ch not in _INVISIBLE and (ch in "\n\t" or unicodedata.category(ch) != "Cc")
    )
    # Normalize AGAIN, because the strip above can create new work for it.
    #
    # NFKC puts combining marks in canonical order, which means sorting any run of them
    # by combining class. It can only do that to marks that are adjacent when it runs.
    # Removing a character between two marks makes them adjacent afterwards, and if they
    # are out of order the first pass never saw them as a pair.
    #
    # The witness Hypothesis found is U+00B4 U+001F U+1A7F. NFKC turns U+00B4 into a
    # space plus U+0301 (combining class 230); the strip then removes the U+001F sitting
    # between it and U+1A7F (combining class 220); and 220 sorts before 230. Without this
    # second pass, normalize_document(normalize_document(x)) != normalize_document(x).
    #
    # That matters because spans index this string (ADR-007). A document normalized twice
    # - re-ingested, round-tripped, read back from a cache - would shift every offset
    # after the affected position, which is the exact failure the span contract exists to
    # prevent.
    #
    # Fixed under ADR-009 rather than reproduced: measured across all 14,900 inputs in
    # golden/diff/normalize.jsonl and golden/diff/pipeline.jsonl, this changes zero
    # outputs, and the same change lands in packages/core in the same commit.
    return unicodedata.normalize("NFKC", stripped)


def fold(value: str) -> str:
    """Reduce a string to a lossy comparison key.

    Transliterates to ASCII, lowercases, drops punctuation, and collapses whitespace.
    Used for dedup keys and match scoring - never for display.
    """
    ascii_form = anyascii(unicodedata.normalize("NFKD", value))
    return _WS_RE.sub(" ", _PUNCT_RE.sub(" ", ascii_form.lower())).strip()


def tokens(value: str) -> tuple[str, ...]:
    """Return the folded, whitespace-delimited tokens of ``value``."""
    folded = fold(value)
    return tuple(folded.split()) if folded else ()


def split_featured(value: str) -> tuple[str, ...]:
    """Split a featured-artist blob such as ``"Doja Cat, SZA & Rosalia"`` into names."""
    parts = (part.strip(" .;") for part in _ARTIST_SPLIT_RE.split(value))
    return tuple(part for part in parts if part)


def _classify(annotation: str) -> tuple[frozenset[Qualifier], tuple[str, ...], bool]:
    """Classify a peeled annotation.

    Returns:
        A ``(qualifiers, featured_artists, recognized)`` triple. ``recognized`` is
        ``False`` for annotations that belong to the real title (``"(Interlude)"``,
        ``"(Part 2)"``), which stops any further peeling.
    """
    feat = _FEAT_RE.match(annotation)
    if feat:
        return frozenset(), split_featured(feat.group("who")), True

    found = frozenset(q for pattern, q in _QUALIFIER_PATTERNS if pattern.search(annotation))
    if Qualifier.REMIX in found and _NON_REMIX_MIX_RE.match(annotation):
        found -= {Qualifier.REMIX}
    if found:
        return found, (), True
    if _BARE_VERSION_RE.match(annotation):
        return frozenset(), (), True
    return frozenset(), (), False


def strip_qualifiers(title: str) -> tuple[str, frozenset[Qualifier], tuple[str, ...], str | None]:
    """Peel version markers and featured artists off a track title.

    Args:
        title: A display title, possibly carrying trailing annotations.

    Returns:
        A ``(base_title, qualifiers, featured_artists, version_label)`` tuple.
        ``version_label`` preserves the most specific version annotation verbatim
        (e.g. ``"Eric Prydz Remix"``) because matching scores it against candidate
        titles; it is ``None`` when no version annotation was found.
    """
    base = title.strip()
    qualifiers: set[Qualifier] = set()
    featured: list[str] = []
    version_label: str | None = None

    while base:
        consumed = False
        for pattern in (_TRAILING_BRACKET_RE, _TRAILING_DASH_RE):
            match = pattern.search(base)
            if not match:
                continue
            annotation = match.group(1).strip()
            if not annotation:
                base = base[: match.start()].rstrip()
                consumed = True
                break
            found, who, recognized = _classify(annotation)
            if not recognized:
                return _finish(base, qualifiers, featured, version_label)
            qualifiers |= found
            featured.extend(who)
            if found and version_label is None:
                version_label = annotation
            base = base[: match.start()].rstrip()
            consumed = True
            break
        if not consumed:
            break

    inline = _INLINE_FEAT_RE.search(base)
    if inline:
        featured.extend(split_featured(inline.group("who")))
        base = base[: inline.start()].rstrip()

    return _finish(base, qualifiers, featured, version_label)


def _finish(
    base: str,
    qualifiers: set[Qualifier],
    featured: list[str],
    version_label: str | None,
) -> tuple[str, frozenset[Qualifier], tuple[str, ...], str | None]:
    """Assemble the `strip_qualifiers` return value, de-duplicating featured artists."""
    seen: dict[str, str] = {}
    for name in featured:
        seen.setdefault(fold(name), name)
    return (
        base.strip(" -\u2013\u2014"),
        frozenset(qualifiers),
        tuple(seen.values()),
        version_label,
    )


def normalize_artist(artist: str) -> str:
    """Trim list punctuation and a leading ``by`` from an artist string."""
    cleaned = artist.strip().strip("-\u2013\u2014,;: \t")
    cleaned = re.sub(r"^by\s+", "", cleaned, flags=re.IGNORECASE)
    return _WS_RE.sub(" ", cleaned).strip()


def split_artist_credits(artist: str) -> tuple[str, tuple[str, ...]]:
    """Separate a primary artist from featured credits folded into the same string.

    ``"Calvin Harris feat. Dua Lipa"`` becomes ``("Calvin Harris", ("Dua Lipa",))``.
    Collaboration joiners (``&``, ``x``, ``and``) are left alone: they are part of the
    primary credit as providers spell it, and splitting them would hurt matching.
    """
    cleaned = normalize_artist(artist)
    match = _INLINE_FEAT_RE.search(cleaned)
    if not match:
        bracketed = _TRAILING_BRACKET_RE.search(cleaned)
        if bracketed:
            feat = _FEAT_RE.match(bracketed.group(1).strip())
            if feat:
                return normalize_artist(cleaned[: bracketed.start()]), split_featured(
                    feat.group("who")
                )
        return cleaned, ()
    return normalize_artist(cleaned[: match.start()]), split_featured(match.group("who"))


def has_version_annotation(text: str) -> bool:
    """Report whether ``text`` ends in a recognized version or credit annotation.

    Used to decide which side of a ``"A - B"`` line is the title: version markers
    attach to titles, not to artist names.
    """
    base, qualifiers, featured, version_label = strip_qualifiers(text)
    return bool(qualifiers or featured or version_label) and bool(base)


def normalize_isrc(value: str) -> str | None:
    """Uppercase and validate an ISRC, returning ``None`` if it is not well formed.

    ISRCs are the canonical cross-platform key (PRD S7.10.1), so a malformed one must
    fail closed rather than reach a provider search.
    """
    candidate = _ISRC_STRIP_RE.sub("", value).upper()
    return candidate if ISRC_RE.match(candidate) else None


def parse_duration(value: str) -> float | None:
    """Parse ``mm:ss`` or ``h:mm:ss`` into seconds, or ``None`` if unparseable."""
    match = _DURATION_RE.match(value.strip())
    if not match:
        return None
    hours = int(match.group("h") or 0)
    return hours * 3600.0 + int(match.group("m")) * 60.0 + int(match.group("s"))


def dedupe_key(title: str, artist: str | None, qualifiers: frozenset[Qualifier]) -> str:
    """Build the collapse key for FR-004 deduplication.

    Qualifiers participate in the key on purpose: a studio cut and its live version are
    different recordings and must not collapse into one playlist entry.
    """
    return "|".join((fold(title), fold(artist or ""), ",".join(sorted(qualifiers))))
