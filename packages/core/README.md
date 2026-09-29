# setlist-core

Pure-Python domain core. **No AWS SDK, no network, no provider clients** — everything
in here is deterministic and unit-testable offline.

| Module | Responsibility |
| --- | --- |
| `models` | Pydantic models crossing every boundary: `SourceDocument`, `Span`, `Hints`, `ParsedItem`, `ExtractionResult` |
| `normalize` | NFKC + zero-width handling, qualifier stripping, dedup keys (PRD §7.9.1) |
| `parsers/` | Deterministic pattern parsers (FR-002) |
| `grounding` | Anti-hallucination span gate (FR-003, PRD §7.9.4) |
| `dedupe` | Normalized-key collapse of repeated songs (FR-004) |
| `confidence` | Per-item confidence scoring and source precedence (FR-004) |
| `pipeline` | `extract_deterministic()` — the deterministic half of the hybrid extractor |

## Span contract

Spans index into `SourceDocument.text` — the **normalized** text, not the raw input.
NFKC normalization and zero-width stripping both change string length, so offsets taken
against the raw bytes would drift. Anything that reports or verifies a span must use
`SourceDocument.text` as its coordinate system; the API returns that text alongside the
items so the SPA can highlight the right characters.
