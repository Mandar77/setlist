"""Setlist domain core.

Pure, offline, deterministic. No AWS SDK, no HTTP, no provider clients - so the
extraction engine can be unit-tested and accuracy-gated in CI without credentials.
"""

from setlist_core.confidence import (
    AUTO_ACCEPT_THRESHOLD,
    NOT_FOUND_THRESHOLD,
    REVIEW_THRESHOLD,
    deterministic_confidence,
)
from setlist_core.dedupe import dedupe
from setlist_core.enums import ExtractionMethod, Provider, Qualifier, RejectReason
from setlist_core.grounding import ground
from setlist_core.models import (
    ExtractionResult,
    ExtractionStats,
    Hints,
    Line,
    ParsedItem,
    RejectedItem,
    SourceDocument,
    Span,
)
from setlist_core.pipeline import (
    DEFAULT_MAX_INPUT_BYTES,
    InputTooLargeError,
    extract_deterministic,
)
from setlist_core.providers import CAPABILITIES, Capabilities, ProviderAdapter, TrackCandidate

__version__ = "0.1.0"

__all__ = [
    "AUTO_ACCEPT_THRESHOLD",
    "CAPABILITIES",
    "DEFAULT_MAX_INPUT_BYTES",
    "NOT_FOUND_THRESHOLD",
    "REVIEW_THRESHOLD",
    "Capabilities",
    "ExtractionMethod",
    "ExtractionResult",
    "ExtractionStats",
    "Hints",
    "InputTooLargeError",
    "Line",
    "ParsedItem",
    "Provider",
    "ProviderAdapter",
    "Qualifier",
    "RejectReason",
    "RejectedItem",
    "SourceDocument",
    "Span",
    "TrackCandidate",
    "__version__",
    "dedupe",
    "deterministic_confidence",
    "extract_deterministic",
    "ground",
]
