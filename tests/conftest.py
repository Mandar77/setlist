"""Shared fixtures and helpers for the Setlist test suite."""

from collections.abc import Callable

import pytest

from setlist_core.models import Line, SourceDocument
from setlist_core.normalize import normalize_document


@pytest.fixture
def line() -> Callable[[str], Line]:
    """Build a `Line` at offset zero from normalized text."""

    def _make(text: str, offset: int = 0) -> Line:
        return Line(normalize_document(text), offset)

    return _make


@pytest.fixture
def document() -> Callable[[str], SourceDocument]:
    """Build a `SourceDocument` from raw text."""
    return SourceDocument.from_raw
