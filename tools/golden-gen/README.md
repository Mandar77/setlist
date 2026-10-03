# golden-gen

Turns `golden/seed/recordings.jsonl` into `golden/extraction/generated.json`: a few
hundred song-list documents whose correct answers are known before the extractor ever
sees them.

```bash
make golden         # regenerate
make golden-check   # assert the committed corpus is current (runs in make verify)
```

## Why "truth-first" is the whole point

A golden set built by running the parser and writing down what it said is not a test. It
agrees with every bug introduced before the next regeneration, and it fails only when
behaviour changes — never when behaviour is wrong.

So nothing here reads the extractor. Each case starts from real MusicBrainz rows whose
title and credit are already known, renders them into text, and records the *same* title
and credit as the expected answer. Renderers may only **add** things the contract says
are removable: a list marker, a timestamp, a qualifier. Whatever the renderer did, the
answer is still the seed's title and the seed's primary credit.

Two rules carry most of the weight:

- **The primary credit is computed from the seed's join phrases**, not by splitting a
  rendered string. MusicBrainz already recorded that "David Guetta & Tocadisco feat.
  Chris Willis" is a primary of `David Guetta & Tocadisco` and a feature of
  `Chris Willis`; re-deriving that from text would be guessing at something we were told.
- **Rows whose title already carries an annotation are excluded.** "Too Original (TJR
  remix)" has two defensible answers — the seed's and the one the contract's qualifier
  stripping produces — and a case built on it would assert a disagreement about the
  contract rather than test extraction. Titles this corpus decorates are decorated by a
  renderer, which knows exactly what it added.

## Two tiers

| Tier | What is in it | How it is gated |
| --- | --- | --- |
| `clean` | lists, `by`, CSV, timestamps, qualifiers, non-Latin, odd casing, zero-width, fullwidth, ragged whitespace, Reddit posts | precision ≥0.95, recall ≥0.90, F1 ≥0.92 |
| `noisy` | chat prose, heavy typos, undecidable column/dash order, two recorded extractor gaps | no score gate; grounding only |

The split is the most consequential decision in the generator, and it is not a quality
dial. The deterministic pass is explicitly not the component that reads prose — PRD
§7.9.3 hands the residual to the LLM — so demanding recall on a chat message would be
demanding it guess. What every tier is held to is grounding: G2 says no hallucinated
songs, and that promise does not weaken on input the parser cannot read.

Current `clean` score: **precision 0.988, recall 0.982, F1 0.985** over 319 cases.

## Five things the corpus found

Building it turned up four generator mistakes and three real extractor gaps. The
generator mistakes are worth recording because each one first looked like an extractor
problem:

1. **` -- ` is not a separator.** The contract's set is `[-~|/•·]` and the three long
   dashes. Generating double-hyphen lines asserted a requirement nobody made, and scored
   a recipe at 0.37.
2. **` | ` collides with table detection.** A pipe is how a markdown table is written, so
   `detect_table` claims the document and the list marker stays glued to the artist.
   Reasonable behaviour; the shape is covered by the CSV recipes instead.
3. **Headerless CSV has no answer unless you fix the column order.** Randomizing it
   scored 0.54 and every failure was a swap — a question the text does not answer. The
   reversed order is generated as a noisy case.
4. **`numbered-bare` ("1 Title") is not a marker the contract names.** The digit ends up
   in the title.

And the gaps, which are generated as noisy cases so they stay visible rather than being
quietly avoided — CORE-04 should fix them in the TypeScript core:

- **`feat.` on the left flips the orientation.** "Calvin Harris feat. Dua Lipa - One
  Kiss" comes back with title "Calvin Harris", because `has_version_annotation` treats a
  featured credit as a cue that its side is the title. True for "(Live)", false for a
  featured artist, and this is one of the commonest shapes in dance and hip-hop.
- **Emoji are transliterated into the title.** `fold()` runs anyascii, which turns 😭
  into "sob" and 💿 into "cd", so "Artist - Title 🔥" folds with the emoji attached.
- **A leading emoji is not stripped as a list marker**, so "🎵 Artist - Title" yields an
  artist of "🎵 Artist".

## Determinism

One seed (`CORPUS_SEED` in `src/generate.ts`), one mulberry32 PRNG, no clock and no
filesystem order. Changing the seed rewrites the whole corpus, so it is a decision rather
than a knob. `make golden-check` asserts the committed file is byte-identical to what the
generator produces now, and the test suite asserts that two different seeds produce
different corpora — otherwise the first assertion would hold for a generator that ignored
its seed entirely.
