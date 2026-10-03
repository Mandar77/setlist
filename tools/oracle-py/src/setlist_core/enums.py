"""Enumerations shared across the extraction and matching domains.

Kept in their own module so that `normalize` and `models` can both depend on them
without a cycle.
"""

from enum import StrEnum


class Qualifier(StrEnum):
    """A version marker peeled off a track title during normalization.

    Qualifiers are structured rather than discarded: matching needs them to avoid
    picking a live cut when the source text asked for the studio recording
    (PRD G2, §7.10.2).
    """

    LIVE = "live"
    REMIX = "remix"
    REMASTER = "remaster"
    ACOUSTIC = "acoustic"
    INSTRUMENTAL = "instrumental"
    RADIO_EDIT = "radio_edit"
    EXTENDED = "extended"
    DEMO = "demo"
    COVER = "cover"
    KARAOKE = "karaoke"


class ExtractionMethod(StrEnum):
    """How an item came to exist.

    Precedence for confidence and merge conflicts is
    ``DETERMINISTIC > LLM_GROUNDED > LLM_UNGROUNDED`` (PRD §7.9.5); ungrounded LLM
    items are rejected outright and never reach a result.
    """

    DETERMINISTIC = "deterministic"
    LLM_GROUNDED = "llm_grounded"
    LLM_UNGROUNDED = "llm_ungrounded"
    HYBRID = "hybrid"


class RejectReason(StrEnum):
    """Why a candidate item was dropped before reaching the preview."""

    SPAN_OUT_OF_RANGE = "span_out_of_range"
    SPAN_TEXT_MISMATCH = "span_text_mismatch"
    EMPTY_TITLE = "empty_title"
    TITLE_TOO_LONG = "title_too_long"
    NOISE_LINE = "noise_line"
    SCHEMA_INVALID = "schema_invalid"


class Provider(StrEnum):
    """Music platforms Setlist can create playlists on (PRD §4)."""

    SPOTIFY = "spotify"
    YOUTUBE = "youtube"
    APPLE = "apple"
    AMAZON = "amazon"
