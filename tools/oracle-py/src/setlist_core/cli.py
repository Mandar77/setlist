"""Byte-stable JSON over stdin/stdout, so another language can be checked against this.

This exists for CORE-04, where `packages/core` is rewritten in TypeScript. The claim
that the rewrite is faithful is only worth something if it can be tested, and testing it
means running both implementations over the same input and diffing the output. A Python
API cannot be called from a Vitest suite; a subprocess that reads text and prints JSON
can.

So the contract here is narrower than the library's. Every value is rendered in a form
with exactly one spelling:

* keys sorted, at every level, so field-declaration order stops mattering;
* `qualifiers` sorted, because it is a `frozenset` and set iteration order is not a
  property anyone should be reproducing in another language;
* no whitespace variance, no trailing newline ambiguity, UTF-8 throughout;
* `ensure_ascii=False`, so a transliteration bug shows up as the wrong character rather
  than as a difference between an escape sequence and the character it stands for.

Float formatting is the one thing left to the runtime, and it is the one thing a port
must be careful about: Python and JavaScript both print the shortest round-tripping
decimal for a double, so they agree on every value either can produce, but only as long
as the arithmetic that produced it agrees first. That is the point of diffing.

Usage:
    echo "Daft Punk - One More Time" | python -m setlist_core.cli --source-kind printed
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from setlist_core.models import ExtractionResult, ParsedItem, RejectedItem, Span
from setlist_core.pipeline import DEFAULT_MAX_INPUT_BYTES, InputTooLargeError, extract_deterministic

#: Bumped when the shape below changes in a way that would break a consumer. The golden
#: oracle outputs carry it, so a shape change cannot pass as a behaviour change.
SCHEMA_VERSION = 1

#: What kind of input this text came from. Only `printed` is implemented; the
#: deterministic pass does not yet branch on it. It is required on the command line
#: anyway, because the handwritten path lands at M2 and a flag that appears later is a
#: breaking change to every caller, while a flag that is ignored for now is not.
SOURCE_KINDS = ("printed", "handwritten")


def render(result: ExtractionResult, *, source_kind: str) -> dict[str, Any]:
    """Project an `ExtractionResult` into the stable wire shape."""
    payload: dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "source_kind": source_kind,
        "document": {
            "digest": result.document.digest,
            "raw_length": result.document.raw_length,
            "text": result.document.text,
        },
        "items": [_item(item) for item in result.items],
        "residual": [_span(span) for span in result.residual],
        "rejected": [_rejected(item) for item in result.rejected],
        "stats": {
            "lines_total": result.stats.lines_total,
            "lines_parsed": result.stats.lines_parsed,
            "lines_residual": result.stats.lines_residual,
            "items_before_dedupe": result.stats.items_before_dedupe,
            "items_after_dedupe": result.stats.items_after_dedupe,
            "rejected": result.stats.rejected,
        },
    }
    return payload


def _span(span: Span) -> dict[str, int]:
    return {"start": span.start, "end": span.end}


def _item(item: ParsedItem) -> dict[str, Any]:
    return {
        "title": item.title,
        "artist": item.artist,
        "span": _span(item.span),
        "confidence": item.confidence,
        "method": str(item.method),
        "parser": item.parser,
        "duplicates": [_span(span) for span in item.duplicates],
        "hints": {
            "album": item.hints.album,
            "year": item.hints.year,
            "isrc": item.hints.isrc,
            "duration_s": item.hints.duration_s,
            "featured_artists": list(item.hints.featured_artists),
            # Sorted, not just listed. `qualifiers` is a frozenset, and the order
            # Python happens to iterate it in is a hash-table detail no other
            # implementation should have to reproduce.
            "qualifiers": sorted(str(q) for q in item.hints.qualifiers),
            "version_label": item.hints.version_label,
            "position": item.hints.position,
            "timestamp_s": item.hints.timestamp_s,
        },
    }


def _rejected(item: RejectedItem) -> dict[str, Any]:
    return {
        "title": item.title,
        "artist": item.artist,
        "reason": str(item.reason),
        "detail": item.detail,
        "span": _span(item.span) if item.span is not None else None,
        "parser": item.parser,
    }


def dumps(payload: dict[str, Any]) -> str:
    """Serialize a payload to the one spelling this CLI ever emits."""
    return json.dumps(
        payload,
        sort_keys=True,
        indent=2,
        ensure_ascii=False,
        allow_nan=False,
    )


def run(text: str, *, source_kind: str, max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES) -> str:
    """Extract from ``text`` and return the serialized result."""
    result = extract_deterministic(text, max_input_bytes=max_input_bytes)
    return dumps(render(result, source_kind=source_kind))


def main(argv: list[str] | None = None) -> int:
    """Read stdin, print JSON, return a process exit code."""
    parser = argparse.ArgumentParser(
        prog="oracle-py",
        description="Frozen reference implementation of Setlist's deterministic extractor.",
    )
    parser.add_argument(
        "--source-kind",
        required=True,
        choices=SOURCE_KINDS,
        help="what the text came from; recorded in the output",
    )
    parser.add_argument(
        "--max-input-bytes",
        type=int,
        default=DEFAULT_MAX_INPUT_BYTES,
        help=f"input size cap (default {DEFAULT_MAX_INPUT_BYTES})",
    )
    args = parser.parse_args(argv)

    # Read bytes and decode explicitly. `sys.stdin` on Windows would otherwise decode
    # with the locale codec and translate CRLF, and this project parses Unicode song
    # titles for a living — the first non-Latin-1 byte would be a crash, and the line
    # endings would move every span.
    text = sys.stdin.buffer.read().decode("utf-8")

    try:
        output = run(text, source_kind=args.source_kind, max_input_bytes=args.max_input_bytes)
    except InputTooLargeError as error:
        print(f"oracle-py: {error}", file=sys.stderr)
        return 2

    sys.stdout.buffer.write(output.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
