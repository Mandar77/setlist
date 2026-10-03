# Golden sets

**This repository is public. No consented images or personal data may be committed
here.** `handwriting/` and `flyers/` contain pointers and checksums only; the images
themselves live in the owner's private storage.

| Path | Contents | Status |
| --- | --- | --- |
| `extraction/printed.json` | Text-in, songs-out cases for the deterministic parser | live, gates CI |
| `oracle/` | `tools/oracle-py`'s output for every extraction case, frozen byte for byte | live, gates CI |
| `seed/recordings.jsonl` | ~2,200 real recordings from MusicBrainz; the truth CORE-03 generates text from | live, gates CI |
| `extraction/handwriting.json` | OCR output from the consented handwritten set | M2 |
| `matching/` | (title, artist) to provider track, per platform | M3 |
| `handwriting/INDEX.md` | Pointers + SHA-256 for the consented scans | M2 |
| `flyers/INDEX.md` | Pointers + SHA-256 for the flyer set | M2 |

## Adding a case

Add one whenever a real input is parsed wrong. A regression that is not in the golden
set will happen again. Cases are cheap; the gate is what makes them matter:

```bash
make test-accuracy
```

## Scoring

Comparison is on normalized `(title, artist)` pairs, not raw strings — the extractor is
allowed to move `(Live)` into hints or transliterate an accent. See
`tests/accuracy/test_extraction_accuracy.py` for the thresholds and why they are set
where they are.
