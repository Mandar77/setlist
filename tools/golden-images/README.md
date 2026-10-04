# golden-images

The OCR golden set (M2-01): 620 images of song lists whose contents are known before any
OCR engine sees them, drawn from `golden/seed/recordings.jsonl`.

```bash
make golden         # rebuild the summary, the manifest and all 620 images
make golden-check   # assert the committed summary is current (runs in make verify)
pnpm -C tools/golden-images test:render   # the Chromium half, needs a browser
```

Rendering needs Chromium: `pnpm -C packages/core exec playwright install chromium`.

## What is committed, and what is not

| | Where | Tracked |
| --- | --- | --- |
| Summary — counts, font licences, coverage, manifest digest | `golden/ocr/corpus.json` | yes, ~4 KB |
| Manifest — every image, every line, every expected song | `golden/ocr-generated/manifest.json` | no |
| The images | `golden/ocr-generated/*.jpg` | no, ~65 MB |

M2-01 keeps the images out of git. The manifest follows them out, because at 2.5 MB it is
rewritten whole whenever the seed changes and a diff nobody can read is not review.

What stays is the summary, and a SHA-256 of the full manifest inside it. That digest is
the determinism proof and it is a stronger one than a readable diff: rebuilding the corpus
and comparing one hash asserts that all 620 images, every line of text and every
augmentation parameter came out identical. An eye passing over a 2.5 MB diff asserts that
someone scrolled.

`test/not-committed.test.ts` asks git what it is actually tracking, so an image added with
`git add -f` fails rather than being noticed at review or not at all.

## Determinism, stated precisely

**The plan is deterministic everywhere.** One seed (`OCR_CORPUS_SEED`), one mulberry32
PRNG shared with the text corpus, no clock and no filesystem order. The same manifest comes
out on Windows and in Linux CI, which is what lets `make golden-check` prove the corpus is
current without a browser.

**The pixels are deterministic per platform and browser version.** Text rasterizing is
FreeType's business and is not byte-identical across operating systems. Claiming otherwise
would be a claim that fails in CI the first time anyone checked it, so the images are
rebuilt wherever they are needed rather than compared across machines. Within one machine
and one Chromium, a rerun is byte-identical, and `render.browser.test.ts` checks that.

## Two truths, because a struck-out line has two right answers

Draw a line through a song and OCR should still read it — the ink is on the page. The
extractor should not return it — the writer crossed it out. A corpus with one truth field
has to pick one of those and be wrong about the other.

So `line.text` is what CER and WER are measured against, and `songTruth` is what song-level
F1 is measured against. M2-05 scores one on each.

## Three image classes

| Class | Count | What it is | What may be done to it |
| --- | --- | --- | --- |
| `handwriting` | 220 | A setlist on paper, in one of eight handwriting faces | rotation ≤7°, perspective, blur, glare, ruled paper, strikethrough, JPEG noise |
| `print` | 220 | A printed sheet or programme | the same, with ruled paper rare |
| `screenshot` | 180 | A phone screenshot of a list | blur and JPEG noise only |

A screenshot is a copy of a framebuffer. It has no rotation, no tilt, no reflection and no
paper, and grading OCR on a distortion the product can never receive would make the number
mean less rather than more. `plan.test.ts` asserts that.

## Fonts: OFL or Apache only, licences recorded

Fourteen `@fontsource/*` packages, pinned in `package.json` and governed by the same
`minimumReleaseAge` as everything else. Each ships a `metadata.json` carrying the upstream
licence and attribution, which is read rather than transcribed — "licences recorded" is
then a fact about the installed packages instead of a list that goes stale the first time
somebody swaps a font. Anything outside OFL-1.1 and Apache-2.0 is refused by `loadFont`,
and `fonts.test.ts` exercises the refusal as well as the acceptance.

Contact addresses are stripped from attributions before they are recorded. This repository
is public, three of the fourteen upstream headers carry the designer's email, and
`tools/check_no_secrets.py` caught them. Redacting keeps the gate; an allowlist would not.

## Coverage, and the thing it costs

CSS cannot switch font fallback off. Hand Chromium a Japanese title in Rock Salt — a
Latin-only face — and it does not draw tofu, it silently substitutes a system font. The
manifest would then claim handwriting the image does not show, and the glyphs that were
drawn would come from a font under no licence this project vetted.

So a row is only offered to a font that covers every one of its codepoints, decided from
the font's own published `unicode.json` before anything is rendered.

The cost is visible in the summary: of 1,977 usable seed rows, **1,719 are drawable and 258
are not**. The gap is almost entirely CJK and Hangul — `@fontsource/noto-sans-jp` is 78 MB
unpacked and its Korean and Chinese siblings are 50 MB and 73 MB, which is not a
devDependency this repository should carry for a corpus that is rebuilt on every CI run.
Noto Sans brings Cyrillic, Greek and Devanagari, which covers the two largest non-Latin
buckets in the seed.

That number is in `corpus.json` and moves when the font set changes, so "the generated set
under-represents CJK" is a measurement rather than a thing nobody noticed. The real
handwriting set (M2-06) and M2-07's gate are measured on real photographs, which is where
that gap actually matters.

## What building it found

**Text was being clipped.** The first version drew each line with `overflow: hidden`, and a
long credit simply ran off the right edge — "Killer Cars - Radiohead" came out as "...-
Radio". The manifest still claimed the whole string, so those images were ground truth for
text that was not on the page. Lines wrap now, the font size is derived from the line count
with room for every line to wrap once, and the renderer measures the result after layout
and refuses to write an image whose text did not fit.

**The arithmetic for that budget was wrong by 4.6 pixels.** `fontSizeFor` divided by the
unrounded line-height ratio while the renderer rounded to whole pixels; at nine lines, 72.6
became 73 and the page overflowed. The size is searched down against the number the
renderer will actually use, so the two cannot drift. `plan.test.ts` found it.

**Glare erased text instead of degrading it.** A specular highlight at 0.86 alpha washed the
top third of a printed sheet to about 14% contrast. Realistic, and useless: ground truth for
erased text grades every engine as equally wrong and says nothing about which is better. The
peak is capped where the text is still there to be found.
