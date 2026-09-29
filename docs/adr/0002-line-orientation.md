# ADR-002 — Line orientation in "X - Y"

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1
- **Related:** [ADR-006](0006-test-data.md) (the seed catalog this depends on)

## Context

PRD FR-002 names `Artist - Title` as the canonical pattern. PED epic E4 says
`1. Wonderwall - Oasis` yields `{Wonderwall, Oasis}` — Title first, since Wonderwall
is the song and Oasis the band.

Both are right about their own input. Pasted tracklists and DJ cue sheets are
overwhelmingly artist-first; handwritten setlists and gig posters are song-first,
because the person writing them already knows who is playing. A single global default
is wrong roughly half the time on the PED's headline use case.

A wrong orientation is not a harmless mislabel: it sends the matcher hunting for a
song called "Oasis" by an artist called "Wonderwall", and under autonomous creation
(FR-M-011) it silently adds the wrong track.

## Decision

Defaults come from the source kind, but **evidence overrides them**. Resolve in this
order, first match wins:

| # | Signal | Confidence |
| --- | --- | --- |
| 1 | **Explicit cues** — `Title by Artist`, a quoted title, CSV headers, labeled fields, timestamped DJ tracklists (artist first) | ≥0.95 |
| 2 | **Document convention** — the majority orientation among cue-bearing lines in the same input; a side that repeats across lines is the artist | ~0.85 |
| 3 | **Source-kind prior** — `scan_handwriting`, `scan_print`, `screenshot` → title first; `paste`, `file` → artist first | 0.60 |

Then:

4. **Below 0.8**, the parser also emits the swapped reading as `alternate`. Spans still
   point at the raw text, so [ADR-007](0007-deterministic-core-and-span-grounding.md)
   grounding holds for both readings.
5. **Resolve in matching.** Check `alternate` against free catalogs (MusicBrainz,
   Deezer) **before spending any YouTube quota**. Take the orientation whose best
   candidate wins by ≥0.10; otherwise keep the prior and send the item to review.
   Autonomous creation never proceeds on an unresolved orientation.

Step 2 is the one that does most of the work in practice: a real tracklist is
internally consistent, and the artist column repeats while the title column does not.
The headerless-CSV column inference already implemented uses exactly this signal, and
the same statistic generalizes to dash lines.

### Worked example

Pasted text `1. Wonderwall - Oasis`:
- Prior says artist-first, confidence 0.60 < 0.8, so `alternate` = (Wonderwall, Oasis).
- MusicBrainz has a recording "Wonderwall" by "Oasis" and nothing for the reverse, so
  the swap wins by more than 0.10.
- The identical line from a scan is already correct on the prior, and never needs the
  lookup.

### Title-only lines

Common on band setlists. Use a document-level artist hint when one exists — a header
such as "Oasis setlist", or an optional "All songs by" field in review. Otherwise the
line goes to review.

## Consequences

- MusicBrainz sits on the resolution path, so its constraints are load-bearing:
  ≤1 req/s per IP and a descriptive User-Agent carrying the repo URL. It runs on a
  rate-limited, cached path inside `catalog-matching` (M3-03) and **never** on the
  on-device preview path, which must work offline.
- Orientation resolution costs zero YouTube units by construction — it happens before
  any adapter call.
- `sourceKind` becomes part of the ingestion contract and must be set by every client.

## Targets

- Parser-only orientation accuracy ≥90% on bare-dash lines.
- ≥98% after matching.
- No extra YouTube units spent on orientation.
- **The 8 existing golden cases keep their expected outputs.**

## Spec edits

PRD FR-002 (orientation is inferred; defaults depend on source kind) and PED epic E4
(the example gains a `sourceKind`). Recorded in `docs/spec-amendments.md`.
