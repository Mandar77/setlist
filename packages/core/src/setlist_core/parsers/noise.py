"""Line triage: structural noise, prose, and list shape.

Three outcomes matter, and conflating them is the classic way to lose recall:

* **Noise** - markdown rules, headings, code fences, bare URLs. Dropped outright; it
  never reaches a parser and never reaches Bedrock.
* **Prose** - sentences that may well mention songs. Never bare-parsed, always routed
  to the residual LLM pass (PRD S7.9.3), which is the component that can read it.
* **Everything else** - offered to the deterministic pattern parsers.

Being too eager here costs recall against G2; being too timid costs Bedrock tokens.
The bias is deliberately toward passing things through to the LLM.
"""

import re
import statistics

from setlist_core.models import Line

__all__ = ["is_list_shaped", "looks_like_noise", "looks_like_prose"]

_RULE_RE = re.compile(r"^\s*[-=*_~]{3,}\s*$")
_MD_HEADING_RE = re.compile(r"^\s*#{1,6}\s+\S")
_CODE_FENCE_RE = re.compile(r"^\s*(?:```|~~~)")
_TABLE_SEP_RE = re.compile(r"^\s*\|?[\s:|-]*\|[\s:|-]*$")
_URL_ONLY_RE = re.compile(r"^\s*<?(?:https?://|www\.)\S+>?\s*$", re.IGNORECASE)
_HTML_ONLY_RE = re.compile(r"^\s*<[^>]+>\s*$")
_HAS_ALNUM_RE = re.compile(r"[^\W_]", re.UNICODE)
#: "Encore:", "Main set:", "Disc 2:" - a short label introducing a section.
_SECTION_LABEL_RE = re.compile(r"^\s*\S[^:]{0,40}:\s*$")

#: A line with more words than this is prose, not a track entry.
PROSE_WORD_LIMIT = 12
#: A sentence break: terminal punctuation followed by the start of a new sentence.
_SENTENCE_RE = re.compile(r"(?P<word>[\w']+)?[.!?]+[)\"'”]?\s+(?=[A-Z0-9\"“])")
#: Abbreviations whose period is not a sentence break. Without these, "Mr. Brightside"
#: and "Vol. 2" read as prose and never reach a parser.
_ABBREVIATIONS = frozenset(
    {
        "mr",
        "mrs",
        "ms",
        "dr",
        "st",
        "jr",
        "sr",
        "prof",
        "rev",
        "gen",
        "sgt",
        "vs",
        "feat",
        "ft",
        "no",
        "vol",
        "pt",
        "op",
        "ch",
        "fig",
        "inc",
        "ltd",
        "co",
        "corp",
        "etc",
        "ca",
        "approx",
        "orig",
        "rec",
    }
)
#: Below this many words a line is short enough to be a bare title.
BARE_TITLE_WORD_LIMIT = 10
#: A document needs at least this many content lines before list-shape is meaningful.
MIN_LIST_LINES = 3
#: Above this share of prose lines, a document is an article, not a list.
MAX_PROSE_FRACTION = 0.3
#: Word count above which a sentence break is taken as evidence of prose.
_SENTENCE_MIN_WORDS = 3


def looks_like_noise(text: str) -> bool:
    """Report whether a line is structural markup rather than content."""
    if not text.strip():
        return True
    if not _HAS_ALNUM_RE.search(text):
        return True
    return bool(
        _RULE_RE.match(text)
        or _MD_HEADING_RE.match(text)
        or _CODE_FENCE_RE.match(text)
        or _TABLE_SEP_RE.match(text)
        or _URL_ONLY_RE.match(text)
        or _HTML_ONLY_RE.match(text)
        or _SECTION_LABEL_RE.match(text)
    )


def _has_sentence_break(text: str) -> bool:
    """Report whether ``text`` contains a real sentence boundary.

    Abbreviations and single-letter initials ("R.E.M.") are excluded, since those
    periods are part of names that routinely appear in track titles.
    """
    return any(
        (word := match.group("word")) is None
        or (len(word) > 1 and word.lower().rstrip("'") not in _ABBREVIATIONS)
        for match in _SENTENCE_RE.finditer(text)
    )


def looks_like_prose(text: str) -> bool:
    """Report whether a line reads as a sentence rather than a list entry.

    Prose is not noise: it may contain songs, so it goes to the LLM residual pass. The
    point of this check is only to stop the bare-title parser from claiming it.
    """
    stripped = text.strip()
    if not stripped:
        return False
    words = stripped.split()
    if len(words) > PROSE_WORD_LIMIT:
        return True
    return len(words) > _SENTENCE_MIN_WORDS and _has_sentence_break(stripped)


def is_list_shaped(lines: list[Line]) -> bool:
    """Report whether a document looks like a list of entries rather than an article.

    Gates the bare-title parser. On a genuine list ("Bohemian Rhapsody" on its own
    line) a separator-less line is a track; in an article the same line is a fragment,
    and claiming it would manufacture songs the author never listed.
    """
    content = [line.text.strip() for line in lines if not looks_like_noise(line.text)]
    if len(content) < MIN_LIST_LINES:
        return False
    word_counts = [len(text.split()) for text in content]
    if statistics.median(word_counts) > BARE_TITLE_WORD_LIMIT:
        return False
    prose_lines = sum(1 for text in content if looks_like_prose(text))
    return prose_lines / len(content) < MAX_PROSE_FRACTION
