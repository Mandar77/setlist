/**
 * Line triage, one table entry at a time.
 *
 * `parsers.test.ts` covers the three outcomes in general. This covers the lists: every
 * abbreviation, every rule character, every heading depth, every URL form. Those are
 * data, and data needs a case per row — a suite that checks four of twenty-eight
 * abbreviations is a suite under which twenty-four of them can be deleted silently, and
 * the mutation run said exactly that.
 *
 * Every expectation here is written out as a literal rather than read from the module.
 * A test that iterates `ABBREVIATIONS` to assert things about `ABBREVIATIONS` passes
 * whatever is in it, including nothing.
 */

import { describe, expect, it } from 'vitest'

import { splitLines } from '../src/parsers/index.js'
import { isListShaped, looksLikeNoise, looksLikeProse } from '../src/parsers/noise.js'

// ---------------------------------------------------------------------- abbreviations
/**
 * Every abbreviation whose period is not a sentence break.
 *
 * Written out, in the module's order, so that deleting one from the module fails exactly
 * one case here and names it.
 */
const ABBREVIATIONS = [
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'St',
  'Jr',
  'Sr',
  'Prof',
  'Rev',
  'Gen',
  'Sgt',
  'Vs',
  'Feat',
  'Ft',
  'No',
  'Vol',
  'Pt',
  'Op',
  'Ch',
  'Fig',
  'Inc',
  'Ltd',
  'Co',
  'Corp',
  'Etc',
  'Ca',
  'Approx',
  'Orig',
  'Rec',
]

describe('an abbreviation is not a sentence break', () => {
  // Without these, "Mr. Brightside" and "Vol. 2" read as prose, never reach a parser,
  // and are forwarded to the LLM instead of being extracted for free.
  it.each(ABBREVIATIONS)('%s. does not end a sentence', abbreviation => {
    expect(looksLikeProse(`${abbreviation}. Brightside Is A Song`)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(looksLikeProse('VOL. Two Is A Song')).toBe(false)
    expect(looksLikeProse('vol. Two Is A Song')).toBe(false)
  })

  it('but an ordinary word before the period is', () => {
    // The control. Every case above would also pass if the sentence detector were
    // disabled outright, which would send every article line to the bare parser.
    expect(looksLikeProse('Berlin. Brightside Is A Song')).toBe(true)
  })

  it('and a single initial is not', () => {
    // "R.E.M." is a band, not three sentences.
    expect(looksLikeProse('R.E.M. Losing My Religion Live')).toBe(false)
  })

  it('and a sentence break needs more than three words to count', () => {
    // A short line with a period is a title with a period. The word count is what keeps
    // "Mr. Brightside" and "Ladies. Gentlemen." apart from an article.
    expect(looksLikeProse('Hello. World')).toBe(false)
  })
})

// ----------------------------------------------------------------------------- noise
describe('structural markup is noise', () => {
  it.each([
    ['a dash rule', '---'],
    ['an equals rule', '==='],
    ['an asterisk rule', '***'],
    ['an underscore rule', '___'],
    ['a tilde rule', '~~~'],
    ['a long rule', '--------------------'],
    ['an h1', '# Tracklist'],
    ['an h2', '## Tracklist'],
    ['an h3', '### Tracklist'],
    ['an h4', '#### Tracklist'],
    ['an h5', '##### Tracklist'],
    ['an h6', '###### Tracklist'],
    ['a backtick code fence', '```'],
    ['a labelled code fence', '```json'],
    ['a tilde code fence', '~~~'],
    ['a markdown table separator', '| --- | --- |'],
    ['an aligned table separator', '|:---|---:|'],
    ['a bare https url', 'https://example.com/x'],
    ['a bare http url', 'http://example.com/x'],
    ['a bare www url', 'www.example.com'],
    ['an angle-bracketed url', '<https://example.com/x>'],
    ['an uppercase url', 'HTTPS://EXAMPLE.COM'],
    ['an html tag', '<div>'],
    ['a closing html tag', '</section>'],
    ['a section label', 'Encore:'],
    ['a longer section label', 'Main set, second half:'],
    ['an empty line', ''],
    ['a whitespace-only line', '   \t  '],
    ['punctuation with no content', '!!!'],
    ['a line of symbols', '>>> <<<'],
  ])('%s', (_label, raw) => {
    expect(looksLikeNoise(raw)).toBe(true)
  })
})

describe('content is not noise', () => {
  // The other half. A triage that answered "noise" to everything would pass every case
  // above and extract nothing at all.
  it.each([
    ['a dash pair', 'Daft Punk - Da Funk'],
    ['a bare title', 'Bohemian Rhapsody'],
    ['a numbered entry', '1. Justice - Genesis'],
    ['a numeric title', '1979'],
    ['a title that is mostly symbols', '10%'],
    ['a Greek title', 'Μ’ αγαπούσες ποτέ'],
    ['a Cyrillic title', 'Печаль'],
    ['a title containing a url-like word', 'Daft Punk - www'],
    ['a heading with no space', '#Tracklist'],
    ['a line with a colon in the middle', 'Encore: Da Funk'],
    ['a label longer than the section cap', `${'x'.repeat(60)}:`],
  ])('%s', (_label, raw) => {
    expect(looksLikeNoise(raw)).toBe(false)
  })
})

// --------------------------------------------------------------------------- prose
describe('prose is routed to the LLM, not parsed and not dropped', () => {
  it.each([
    'This was the best set of the entire weekend. Truly incredible.',
    'I went to see them in Berlin last year and it was completely incredible honestly',
    'They opened with the new one. Nobody expected that at all.',
  ])('%j reads as prose', raw => {
    expect(looksLikeProse(raw)).toBe(true)
    // And is still not noise: it may name songs, and dropping it would lose them.
    expect(looksLikeNoise(raw)).toBe(false)
  })

  it.each([
    'Daft Punk - One More Time',
    'Justice - Genesis (Live)',
    'Mr. Brightside',
    'Vol. 2',
    '',
  ])('%j does not', raw => {
    expect(looksLikeProse(raw)).toBe(false)
  })

  it('counts words, so a long line is prose even with no punctuation', () => {
    // Thirteen words, no sentence break at all.
    expect(
      looksLikeProse('one two three four five six seven eight nine ten eleven twelve thirteen'),
    ).toBe(true)
  })

  it('and twelve words is not', () => {
    // The boundary in the passing direction, without which `>` and `>=` are the same.
    expect(looksLikeProse('one two three four five six seven eight nine ten eleven twelve')).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------- list shape
describe('list shape gates the bare-title parser', () => {
  it('accepts a plain list', () => {
    expect(isListShaped(splitLines('Da Funk\nGenesis\nMidnight City\nWonderwall'))).toBe(true)
  })

  it('needs at least three content lines', () => {
    expect(isListShaped(splitLines('Da Funk\nGenesis'))).toBe(false)
    expect(isListShaped(splitLines('Da Funk\nGenesis\nMidnight City'))).toBe(true)
  })

  it('ignores noise lines when counting', () => {
    // Three content lines and three rules is a list, not a six-line document that
    // happens to be half markup.
    expect(isListShaped(splitLines('---\nDa Funk\n---\nGenesis\n---\nMidnight City'))).toBe(true)
  })

  it('refuses a document whose typical line is too long to be a title', () => {
    const wordy = Array.from(
      { length: 4 },
      (_, i) => `line ${i} with far too many words in it to be any kind of song title at all`,
    ).join('\n')
    expect(isListShaped(splitLines(wordy))).toBe(false)
  })

  it('refuses a document that is mostly prose', () => {
    const article = [
      'I spent the weekend at a festival and it was incredible from start to finish.',
      'The headliner played for two hours and the crowd never once sat down.',
      'Honestly I have not had a weekend like that in years. I would go again.',
      'Da Funk',
    ].join('\n')
    expect(isListShaped(splitLines(article))).toBe(false)
  })

  it('tolerates a minority of prose lines', () => {
    // Below the threshold a stray comment does not disqualify a real list, which is what
    // most Reddit tracklists look like.
    const mostlyList = [
      'Da Funk',
      'Genesis',
      'Midnight City',
      'Wonderwall',
      'Alive',
      'Stress',
      'Phantom',
      'This was the best set of the entire weekend. Truly incredible.',
    ].join('\n')
    expect(isListShaped(splitLines(mostlyList))).toBe(true)
  })
})
