/**
 * The metrics, including every edge the oracle differential cannot reach.
 *
 * `oracle-py/` pins CER and WER against `jiwer` on a shared fixture corpus (ADR-014).
 * That differential is the authority on the ARITHMETIC. This file covers the decisions
 * jiwer has no opinion about — song-level F1, what an empty reference means, and the
 * aggregation — plus the must-fail directions, because a metric that returns a plausible
 * number for every input is the failure mode that matters here.
 */

import { describe, expect, it } from 'vitest'

import { cer, characters, editDistance, songF1, wer, words } from '../src/metrics.js'
import { scoreEngine, type EngineReading, type TruthSpec } from '../src/evaluate.js'

describe('edit distance', () => {
  it('is zero for identical input and the length for empty input', () => {
    expect(editDistance([...'abc'], [...'abc'])).toBe(0)
    expect(editDistance([...'abc'], [])).toBe(3)
    expect(editDistance([], [...'abc'])).toBe(3)
  })

  it('counts one substitution, one insertion and one deletion as one each', () => {
    expect(editDistance([...'kitten'], [...'sitten'])).toBe(1)
    expect(editDistance([...'kitten'], [...'kittens'])).toBe(1)
    expect(editDistance([...'kitten'], [...'itten'])).toBe(1)
  })

  it('is the textbook value for kitten/sitting', () => {
    expect(editDistance([...'kitten'], [...'sitting'])).toBe(3)
  })

  it('is symmetric', () => {
    expect(editDistance([...'flaw'], [...'lawn'])).toBe(editDistance([...'lawn'], [...'flaw']))
  })
})

describe('tokenization', () => {
  it('collapses whitespace runs rather than emitting empty words', () => {
    // `'a  b'.split(' ')` gives three words, one of them empty, which silently inflates
    // WER on any engine that emits double spaces — which is most of them.
    expect(words('a  b')).toEqual(['a', 'b'])
    expect(words('  leading and trailing  ')).toEqual(['leading', 'and', 'trailing'])
    expect(words('   ')).toEqual([])
    expect(words('')).toEqual([])
  })

  it('counts a non-BMP character as one unit, not two', () => {
    // `'🎵'.length` is 2. Counting UTF-16 code units would make an emoji two errors and
    // every CJK title's error rate wrong in a way that looks like an engine problem.
    expect(characters('🎵')).toHaveLength(1)
    expect(characters('日本語')).toHaveLength(3)
  })
})

describe('error rates', () => {
  it('divides by the reference length, not the alignment length', () => {
    // Four reference characters, four errors appended: 100%, not 50%. Dividing by the
    // alignment would let a wildly over-long hypothesis score better than a short one.
    expect(cer(['abcd'], ['abcdwxyz']).rate).toBe(1)
    expect(cer(['abcd'], ['abcd']).rate).toBe(0)
  })

  it('can exceed 100%', () => {
    // Not clamped. An engine emitting three times the reference is 200% wrong and the
    // report should say so rather than flattening every bad engine to "100%".
    expect(cer(['ab'], ['abxxxxxx']).rate).toBeGreaterThan(1)
  })

  it('scores an empty reference with output as the full error count, not zero', () => {
    // The must-fail direction for the blank page: returning 0 here would make an engine
    // that hallucinates onto an empty reference the best in the table.
    //
    // 13 and 2, not Infinity — the denominator is guarded at 1, which is jiwer's
    // convention and is what oracle-differential.test.ts pins. Finite matters: the
    // corpus average is a micro-average, and one Infinity would poison the whole column.
    expect(cer([''], ['invented text']).rate).toBe(13)
    expect(wer([''], ['invented text']).rate).toBe(2)
  })

  it('ignores whitespace-only differences, because layout is not text', () => {
    // An engine that reads every character correctly and spaces or wraps differently has
    // made no READING error. Both sides of the differential collapse whitespace before
    // measuring, so this has to hold here too.
    expect(cer(['one two three'], ['one  two   three']).rate).toBe(0)
    expect(cer(['trimmed'], ['   trimmed   ']).rate).toBe(0)
  })

  it('treats an empty reference with no output as perfect', () => {
    expect(cer([''], ['']).rate).toBe(0)
    expect(wer([''], ['']).rate).toBe(0)
  })

  it('scores lines jointly, so a merged line is not free', () => {
    // An engine that merges two lines into one loses the newline and nothing else. That
    // IS an error and the metric has to see it; scoring line-by-line and averaging would
    // need a one-to-one line correspondence, which is exactly what this engine broke.
    expect(cer(['one', 'two'], ['onetwo']).errors).toBe(1)
  })
})

describe('song-level F1', () => {
  const song = (title: string, artist: string | null = 'A') => ({ title, artist })

  it('is 1 when the extraction matches exactly', () => {
    const expected = [song('Alpha'), song('Beta')]
    expect(songF1(expected, [song('Beta'), song('Alpha')]).f1).toBe(1)
  })

  it('is order-independent but not duplicate-independent', () => {
    // Multiset, not set. A setlist can legitimately repeat a song, and collapsing
    // duplicates would hide an engine that emitted the same line twice — a real failure
    // on ruled paper.
    const twice = [song('Alpha'), song('Alpha')]
    expect(songF1(twice, twice).f1).toBe(1)
    expect(songF1(twice, [song('Alpha')]).recall).toBe(0.5)
    expect(songF1([song('Alpha')], twice).precision).toBe(0.5)
  })

  it('does not confuse a dash in a title with the title/artist boundary', () => {
    // The separator is U+0000 precisely so this cannot collide. Joining on a dash would
    // make these two the same song, and titles with dashes are the reason the whole
    // orientation problem exists here.
    const a = [{ title: 'Hello - World', artist: null }]
    const b = [{ title: 'Hello', artist: 'World' }]
    expect(songF1(a, b).f1).toBe(0)
  })

  it('does not confuse a space in a title with the boundary either', () => {
    // A space separator would make ("Hello World", "") and ("Hello", "World") equal.
    const a = [{ title: 'Hello World', artist: null }]
    const b = [{ title: 'Hello', artist: 'World' }]
    expect(songF1(a, b).f1).toBe(0)
  })

  it('scores a correctly empty extraction as perfect, and a hallucinated one as zero', () => {
    // A page of headings has no songs. The extractor returning nothing is RIGHT, and
    // scoring it 0 would punish the correct answer; returning something is wrong.
    expect(songF1([], []).f1).toBe(1)
    expect(songF1([], [song('Invented')]).f1).toBe(0)
    expect(songF1([song('Missed')], []).f1).toBe(0)
  })
})

describe('aggregation across a corpus', () => {
  const truth = (id: string, imageClass: string, lines: string[]): TruthSpec => ({
    id,
    imageClass,
    lines,
    songTruth: [],
  })
  const reading = (imageId: string, lines: string[]): EngineReading => ({ imageId, lines })

  it('micro-averages error rates, so a long document weighs more than a short one', () => {
    // One perfect 100-character image and one wholly wrong 4-character image is 4 errors
    // over 104 characters, not the 50% a mean of the two rates would report.
    const long = 'x'.repeat(100)
    const score = scoreEngine(
      'test',
      [truth('a', 'print', [long]), truth('b', 'print', ['abcd'])],
      [reading('a', [long]), reading('b', ['wxyz'])],
    )
    expect(score.overall.cer).toBeCloseTo(4 / 104, 10)
  })

  it('reports a missing reading as unmatched rather than scoring it zero', () => {
    // A collector that crashed halfway and an engine that is bad at handwriting need
    // different responses, so they must not produce the same number.
    const score = scoreEngine('test', [truth('a', 'print', ['hello'])], [])
    expect(score.unmatched).toEqual(['a'])
    expect(score.overall.images).toBe(0)
  })

  it('reports an extra reading as unmatched too', () => {
    // The other direction: the collector and the manifest disagreeing about what was
    // rendered means the report is averaging two different corpora.
    const score = scoreEngine(
      'test',
      [truth('a', 'print', ['hello'])],
      [reading('a', ['hello']), reading('ghost', ['hello'])],
    )
    expect(score.unmatched).toEqual(['ghost'])
  })

  it('breaks results down by image class', () => {
    const score = scoreEngine(
      'test',
      [truth('a', 'print', ['hello']), truth('b', 'handwriting', ['hello'])],
      [reading('a', ['hello']), reading('b', ['xxxxx'])],
    )
    expect(score.byClass.map(c => c.imageClass)).toEqual(['handwriting', 'print'])
    expect(score.byClass.find(c => c.imageClass === 'print')!.cer).toBe(0)
    expect(score.byClass.find(c => c.imageClass === 'handwriting')!.cer).toBe(1)
  })

  it('counts an engine that returned nothing for a page with text', () => {
    // Distinct from a high error rate. An engine returning nothing at all usually means
    // the collector failed to load the image, and averaging that in as "100% CER" would
    // report a broken harness as a bad engine.
    const score = scoreEngine('test', [truth('a', 'print', ['hello'])], [reading('a', [])])
    expect(score.overall.emptyImages).toBe(1)
  })

  it('reports the share of images that would fall back to the server (FR-M-006)', () => {
    // The number that replaces usage-model.yaml's assumed 20%, so it feeds the free-tier
    // Lambda row rather than only the report. Both directions: clean text that parses
    // confidently must NOT fall back, or the measurement would justify any budget.
    const lines = ['Bohemian Rhapsody - Queen', 'Under Pressure - Queen']
    const confident = scoreEngine('good', [truth('a', 'print', lines)], [reading('a', lines)])
    expect(confident.overall.fallbackShare).toBe(0)

    // Nothing extractable: an empty extraction is a fallback, because from the product's
    // side "no songs found" and "the engine could not read this" are the same page.
    const garbage = scoreEngine(
      'bad',
      [truth('b', 'print', lines)],
      [reading('b', ['~~~~', '####'])],
    )
    expect(garbage.overall.fallbackShare).toBe(1)
  })

  it('degrading the input makes the score worse', () => {
    // The harness's own must-fail direction, and M2-05a's last done_when. A metric that
    // returns a number for everything proves nothing until it is shown to MOVE.
    const lines = ['Bohemian Rhapsody - Queen', 'Under Pressure - Queen']
    const perfect = scoreEngine('good', [truth('a', 'print', lines)], [reading('a', lines)])
    const garbled = scoreEngine(
      'bad',
      [truth('a', 'print', lines)],
      [reading('a', ['B0h3m1an Rhaps0dy ~ Qu33n', 'Und3r Pr3ssur3 ~ Qu33n'])],
    )
    expect(perfect.overall.cer).toBe(0)
    expect(garbled.overall.cer).toBeGreaterThan(perfect.overall.cer)
  })
})
