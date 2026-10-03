# oracle-py — FROZEN

> **This package is frozen. It takes bug fixes to nothing and features to nothing.**
>
> It was `packages/core`, the Python domain core, and it moved here unchanged at
> CORE-01. `packages/core` is being rewritten in TypeScript (ADR-004, CORE-04) and this
> is what the rewrite gets checked against. A reference implementation that is still
> being improved is not a reference: "the port matches the oracle" would only ever mean
> "the port matches whatever the oracle did this week".
>
> So the rule is narrow and absolute. **A wrong answer in here is not a bug to fix, it
> is behaviour to reproduce.** If the extractor gets something wrong, the fix belongs in
> the TypeScript core, and the difference belongs in a golden case that documents it.
> This package is deleted at CORE-07, once the port is trusted.

Changing it is possible and is meant to be awkward: `make -C tools/oracle-py verify`
fails the moment any output moves, and clearing that requires running
`make -C tools/oracle-py golden-write`, which rewrites the frozen outputs under
`golden/oracle/` and puts the diff in front of a reviewer. There is no way to do it
quietly, which is the point.

## Being the oracle

```bash
echo "Daft Punk - One More Time" |
  uv run python -m setlist_core.cli --source-kind printed
```

stdin is text, stdout is JSON, and the JSON has exactly one spelling: keys sorted at
every level, `qualifiers` sorted rather than frozenset-ordered, UTF-8 with non-ASCII
emitted literally, one trailing newline. That is what makes a byte diff from a Vitest
suite meaningful — see `src/setlist_core/cli.py` for what each of those choices is
defending against.

`golden/oracle/<case-id>.json` holds that output for every case in
`golden/extraction/`, committed. `golden.py` checks them and `make golden-write`
regenerates them.

## What it is

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
