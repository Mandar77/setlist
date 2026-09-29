# ADR-006 — Test data Claude Code can trust

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1
- **Related:** [ADR-002](0002-line-orientation.md) (depends on the seed catalog)

## Context

**Claude Code must never grade its own work.** An agent that writes both the parser
and its expected outputs will converge on a golden set that its own bugs satisfy, and
every accuracy number after that is theatre. The M0 golden set was hand-written from
real formats, which is honest but small and still authored by the same process that
wrote the parser.

The fix is to derive expected outputs from an **external** source of truth, before any
parser sees them.

## Decision

### Seed catalog — the external truth

~2,000 recordings pulled once from MusicBrainz into `golden/seed/recordings.jsonl`,
committed.

- **Terms:** MusicBrainz core data is CC0. Stay at 1 request/s. Send a User-Agent
  carrying the repo URL — MusicBrainz throttles or blocks requests without one.
- **Fields:** title, artist credit, ISRCs, duration, MBIDs.
- **Coverage:** live / remaster / feat. variants, plus non-Latin names.

### Text golden set — generated truth-first

Generated **from the seed**, so expected outputs come from the catalog and never from
the parser. Covers numbered and bulleted lists, `by`, CSV, timestamps, both dash
orders for each source kind, chat and Reddit-style prose, typos, emoji, odd casing and
multilingual text. Deterministic, ≥300 cases.

### OCR golden set — rendered, not committed

CI generates it from the seed with deterministic seeds.

- **Sources:** handwriting fonts (OFL/Apache-licensed, e.g. via `@fontsource`),
  printed posters and flyers, chat screenshots rendered with Playwright.
- **Augmentations:** rotation ≤7°, perspective, blur, glare, JPEG noise, ruled paper,
  crossed-out lines.

### Real handwriting — the only set that can prove the handwriting targets

In Session 3 the human copies out 15 lists **that Claude Code generated**, so the
ground truth is known in advance rather than transcribed afterwards.

- Photos encrypted with `age` into `golden/private/`; the key is a GitHub secret.
- Decryption happens only in CI runs on `develop` and `main`.

### Gates

| Set | Gates |
| --- | --- |
| Synthetic text + OCR | Every push |
| Real handwriting | M2, M7, M8 |

Synthetic handwriting is cleaner than real handwriting, so **only the real set can
pass the handwriting targets**. Reporting synthetic CER against a handwriting target
would be a false pass.

### Changing expected outputs

Only through an ADR, the way [ADR-002](0002-line-orientation.md)'s
`golden/diff-allowlist.yaml` works. Editing an expectation to make a test go green is
the failure mode this ADR exists to prevent.

## Consequences

- The seed builder must be resumable and rate-limited; a 2,000-row pull at 1 req/s
  takes over half an hour.
- `golden/private/` is git-ignored and the plaintext is deleted after encryption. The
  repository is public.
- The eight hand-written M0 cases stay as a readable smoke corpus; the generated set
  is what carries the statistical claim.
