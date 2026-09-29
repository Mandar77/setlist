"""The deterministic half of the hybrid extractor (PRD S7.9, steps 1-2 and 5).

`extract_deterministic` is the whole contract: normalize, parse what the rules can
parse, ground every claim against the source, deduplicate, and hand back both the
items and the residual spans that the Bedrock pass is responsible for. The residual is
the interesting output - it is precisely the text an LLM will see, and nothing else
ever reaches the model.
"""

import bisect

from setlist_core.confidence import deterministic_confidence
from setlist_core.dedupe import dedupe
from setlist_core.enums import ExtractionMethod
from setlist_core.grounding import ground
from setlist_core.models import (
    ExtractionResult,
    ExtractionStats,
    Line,
    ParsedItem,
    RejectedItem,
    SourceDocument,
    Span,
)
from setlist_core.parsers import (
    LineMatch,
    detect_table,
    is_list_shaped,
    looks_like_noise,
    parse_line,
    parse_table,
    split_lines,
)

__all__ = ["DEFAULT_MAX_INPUT_BYTES", "InputTooLargeError", "extract_deterministic"]

#: FR-001 default paste/upload cap. The API layer makes this configurable per
#: environment through AppConfig; the core enforces whatever it is handed.
DEFAULT_MAX_INPUT_BYTES = 100 * 1024

#: If the pair parsers already claimed this share of content lines, the rest are
#: headers rather than bare titles - see `_should_rescue_with_bare_titles`.
BARE_RESCUE_MAX_COVERAGE = 0.5


class InputTooLargeError(ValueError):
    """Raised when input exceeds the configured size cap (FR-001, NFR-004)."""

    def __init__(self, size: int, limit: int) -> None:
        """Record the offending size and the limit it exceeded."""
        super().__init__(f"input is {size} bytes, limit is {limit}")
        self.size = size
        self.limit = limit


def extract_deterministic(
    source: str | SourceDocument,
    *,
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES,
) -> ExtractionResult:
    """Run the deterministic extraction pass over a document.

    Args:
        source: Raw text, or an already-normalized `SourceDocument`.
        max_input_bytes: Size cap applied to raw text. Ignored when ``source`` is
            already a document, since that has passed the gate at ingest.

    Raises:
        InputTooLargeError: If raw text exceeds ``max_input_bytes``.

    Returns:
        An `ExtractionResult` whose `residual` spans are the input to the LLM pass.
    """
    if isinstance(source, str):
        size = len(source.encode("utf-8"))
        if size > max_input_bytes:
            raise InputTooLargeError(size, max_input_bytes)
        document = SourceDocument.from_raw(source)
    else:
        document = source

    lines = split_lines(document.text)
    matches, consumed = _collect_matches(lines)
    items, rejected = _ground_all(document, matches)
    deduped = dedupe(items)

    residual = _residual_spans(lines, matches, consumed)
    return ExtractionResult(
        document=document,
        items=deduped,
        residual=residual,
        rejected=rejected,
        stats=ExtractionStats(
            lines_total=len(lines),
            lines_parsed=len(matches),
            lines_residual=len(residual),
            items_before_dedupe=len(items),
            items_after_dedupe=len(deduped),
            rejected=len(rejected),
        ),
    )


def _collect_matches(lines: list[Line]) -> tuple[list[LineMatch], set[int]]:
    """Parse the document as a table if it is one, otherwise line by line.

    Returns:
        The matches, plus the indices of lines that were consumed without producing
        one. A CSV header is the motivating case: it is neither a track nor residual,
        and forwarding it to Bedrock would be pure token spend.
    """
    spec = detect_table(lines)
    if spec is not None:
        consumed = {_first_content_line(lines)} if spec.has_header else set[int]()
        return parse_table(lines, spec), consumed

    strict = _parse_all(lines, allow_bare=False)
    if _should_rescue_with_bare_titles(lines, strict):
        return _parse_all(lines, allow_bare=True), set()
    return strict, set()


def _parse_all(lines: list[Line], *, allow_bare: bool) -> list[LineMatch]:
    """Run the line parsers across the document."""
    return [
        match
        for match in (parse_line(line, allow_bare=allow_bare) for line in lines)
        if match is not None
    ]


def _should_rescue_with_bare_titles(lines: list[Line], strict: list[LineMatch]) -> bool:
    """Decide whether separator-less lines should be read as bare titles.

    Two conditions, and both matter:

    * The document has to read as a list at all, or an article's sentence fragments
      become songs.
    * The pair parsers have to have mostly *failed*. On a document where they
      succeeded, the leftover lines are headers and section labels - "Best tracks of
      the summer" sitting above four "Artist - Title" lines is not a track, and
      claiming it costs precision against the G2 gate.
    """
    content = sum(1 for line in lines if not looks_like_noise(line.text))
    if not content:
        return False
    if len(strict) / content >= BARE_RESCUE_MAX_COVERAGE:
        return False
    return is_list_shaped(lines)


def _first_content_line(lines: list[Line]) -> int:
    """Index of the first non-noise line, which is where a header row would sit."""
    return next(
        (index for index, line in enumerate(lines) if not looks_like_noise(line.text)),
        0,
    )


def _ground_all(
    document: SourceDocument, matches: list[LineMatch]
) -> tuple[list[ParsedItem], tuple[RejectedItem, ...]]:
    """Score and ground each match, splitting survivors from rejections."""
    items: list[ParsedItem] = []
    rejected: list[RejectedItem] = []

    for match in matches:
        rejection = ground(
            document,
            title=match.title,
            artist=match.artist,
            span=match.span,
            parser=match.parser,
        )
        if rejection is not None:
            rejected.append(rejection)
            continue
        items.append(
            ParsedItem(
                title=match.title,
                artist=match.artist,
                hints=match.hints,
                span=match.span,
                confidence=deterministic_confidence(
                    match.parser,
                    match.title,
                    match.artist,
                    match.hints,
                    ambiguous_direction=match.ambiguous_direction,
                    structured=match.structured,
                ),
                method=ExtractionMethod.DETERMINISTIC,
                parser=match.parser,
            )
        )
    return items, tuple(rejected)


def _residual_spans(
    lines: list[Line], matches: list[LineMatch], consumed: set[int]
) -> tuple[Span, ...]:
    """Spans of every content line no parser claimed.

    These go to Bedrock. Noise lines are excluded entirely - sending markdown rules
    and bare URLs to a model would be pure token spend.
    """
    starts = [line.offset for line in lines]
    claimed: set[int] = set(consumed)
    for match in matches:
        index = bisect.bisect_right(starts, match.span.start) - 1
        if index >= 0:
            claimed.add(index)

    return tuple(
        span
        for index, line in enumerate(lines)
        if index not in claimed
        and not looks_like_noise(line.text)
        and (span := line.span) is not None
    )
