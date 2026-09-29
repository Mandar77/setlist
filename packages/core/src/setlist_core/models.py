"""Domain models for extraction.

Every model here is immutable. Extraction is a pipeline of pure transformations, and
frozen models make it impossible for a later stage to silently mutate an earlier
stage's output - which matters because spans are cross-referenced against the document
long after the parser that produced them has returned.
"""

import hashlib
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from setlist_core.enums import ExtractionMethod, Qualifier, RejectReason
from setlist_core.normalize import dedupe_key, normalize_document

# A title longer than this is prose that a parser mis-split, not a song title.
MAX_TITLE_LENGTH = 300

Confidence = Annotated[float, Field(ge=0.0, le=1.0)]


class Frozen(BaseModel):
    """Base for immutable domain models with strict field validation."""

    model_config = ConfigDict(frozen=True, extra="forbid", str_strip_whitespace=True)


class Span(Frozen):
    """A half-open character range ``[start, end)`` into `SourceDocument.text`.

    FR-003 requires every extracted item to carry a span; items without a valid one are
    rejected rather than shown, which is what makes hallucinated songs structurally
    impossible to surface.
    """

    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def _check_order(self) -> Self:
        if self.end <= self.start:
            msg = f"span end {self.end} must be greater than start {self.start}"
            raise ValueError(msg)
        return self

    def slice(self, text: str) -> str:
        """Return the substring this span covers."""
        return text[self.start : self.end]

    def within(self, text: str) -> bool:
        """Report whether this span lies inside ``text``."""
        return self.end <= len(text)

    def shift(self, offset: int) -> "Span":
        """Return this span translated by ``offset`` characters."""
        return Span(start=self.start + offset, end=self.end + offset)


class SourceDocument(Frozen):
    """Normalized input text plus the provenance needed to reason about it.

    `text` is the canonical coordinate system for all spans. `digest` is a stable
    content hash used as a cache key and to prove that a confirmed job is operating on
    the same text that was previewed.
    """

    text: str
    raw_length: int = Field(ge=0)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")

    @classmethod
    def from_raw(cls, raw: str) -> "SourceDocument":
        """Normalize ``raw`` and wrap it as a document."""
        text = normalize_document(raw)
        return cls(
            text=text,
            raw_length=len(raw),
            digest=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )

    def __len__(self) -> int:
        """Length of the normalized text, in characters."""
        return len(self.text)


class Line:
    """A physical line of the document together with its absolute offset.

    Deliberately a plain object rather than a pydantic model: the line splitter
    allocates one per input line on the hot preview path (NFR-001, p95 < 6 s), and
    validation there buys nothing.
    """

    __slots__ = ("offset", "text")

    def __init__(self, text: str, offset: int) -> None:
        """Store the line text and its absolute offset in the document."""
        self.text = text
        self.offset = offset

    @property
    def span(self) -> Span | None:
        """The span covering this line, or ``None`` when the line is empty."""
        if not self.text:
            return None
        return Span(start=self.offset, end=self.offset + len(self.text))

    def sub(self, start: int, end: int) -> Span:
        """Build a span for ``self.text[start:end]`` in document coordinates."""
        return Span(start=self.offset + start, end=self.offset + end)

    def __repr__(self) -> str:
        """Render offset and text for test failure output."""
        return f"Line(offset={self.offset}, text={self.text!r})"


class Hints(Frozen):
    """Structured side information attached to a parsed item.

    These feed matching, not display: `isrc` short-circuits provider search (PRD
    S7.10.1), `qualifiers` and `duration_s` break ties between a studio cut and a live
    or remixed one, and `featured_artists` recovers credits folded into a title.
    """

    album: str | None = None
    year: int | None = Field(default=None, ge=1860, le=2200)
    isrc: str | None = Field(default=None, pattern=r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")
    duration_s: float | None = Field(default=None, gt=0)
    featured_artists: tuple[str, ...] = ()
    qualifiers: frozenset[Qualifier] = frozenset()
    version_label: str | None = None
    position: int | None = Field(default=None, ge=1)
    timestamp_s: int | None = Field(default=None, ge=0)

    def merge(self, other: "Hints") -> "Hints":
        """Combine two hint sets, preferring this one's populated scalar fields."""
        merged_featured = list(self.featured_artists)
        merged_featured += [a for a in other.featured_artists if a not in merged_featured]
        return Hints(
            album=self.album or other.album,
            year=self.year or other.year,
            isrc=self.isrc or other.isrc,
            duration_s=self.duration_s or other.duration_s,
            featured_artists=tuple(merged_featured),
            qualifiers=self.qualifiers | other.qualifiers,
            version_label=self.version_label or other.version_label,
            position=self.position if self.position is not None else other.position,
            timestamp_s=self.timestamp_s if self.timestamp_s is not None else other.timestamp_s,
        )


class ParsedItem(Frozen):
    """One song extracted from the source text."""

    title: str = Field(min_length=1, max_length=MAX_TITLE_LENGTH)
    artist: str | None = Field(default=None, min_length=1)
    hints: Hints = Hints()
    span: Span
    confidence: Confidence
    method: ExtractionMethod
    parser: str = Field(min_length=1)
    # Spans of the other occurrences collapsed into this item by deduplication.
    duplicates: tuple[Span, ...] = ()

    @property
    def key(self) -> str:
        """The FR-004 deduplication key for this item."""
        return dedupe_key(self.title, self.artist, self.hints.qualifiers)

    @property
    def occurrence_count(self) -> int:
        """How many times this song appeared in the source text."""
        return 1 + len(self.duplicates)


class RejectedItem(Frozen):
    """A candidate dropped before the preview, retained for auditability.

    Rejections are surfaced in the API response and logged: G2 ("no hallucinated
    songs") is only credible if we can show what was thrown away and why.
    """

    title: str
    artist: str | None = None
    reason: RejectReason
    detail: str = ""
    span: Span | None = None
    parser: str = "unknown"


class ExtractionStats(Frozen):
    """Counters emitted as EMF metrics for the extraction dashboard (NFR-006)."""

    lines_total: int = 0
    lines_parsed: int = 0
    lines_residual: int = 0
    items_before_dedupe: int = 0
    items_after_dedupe: int = 0
    rejected: int = 0

    @property
    def deterministic_coverage(self) -> float:
        """Fraction of non-noise lines the deterministic pass resolved.

        Drives the decision to escalate to the LLM pass and, at the fleet level, tells
        us whether a new source format has appeared that deserves its own parser.
        """
        considered = self.lines_parsed + self.lines_residual
        return self.lines_parsed / considered if considered else 1.0


class ExtractionResult(Frozen):
    """The output of the deterministic pass and, later, of the hybrid merge."""

    document: SourceDocument
    items: tuple[ParsedItem, ...] = ()
    # Lines the deterministic pass could not resolve. These are what gets sent to
    # Bedrock in the residual pass (PRD S7.9.3) - nothing else is.
    residual: tuple[Span, ...] = ()
    rejected: tuple[RejectedItem, ...] = ()
    stats: ExtractionStats = ExtractionStats()

    def residual_text(self) -> str:
        """Concatenate the residual lines for the LLM pass, one per line."""
        return "\n".join(span.slice(self.document.text) for span in self.residual)

    def below(self, threshold: float) -> tuple[ParsedItem, ...]:
        """Items needing human review (FR-007, default threshold 0.8)."""
        return tuple(item for item in self.items if item.confidence < threshold)
