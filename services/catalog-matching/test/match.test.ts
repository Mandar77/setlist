// Scoring, thresholds, the cache, and the matching order (PRD §7.10, ADR-002 step 5).

import { describe, expect, it, vi } from 'vitest'

import { Qualifier } from '@setlist/core'

import {
  AUTO_ACCEPT,
  type Candidate,
  DEFAULT_TTL_MS,
  type Lookup,
  MatchCache,
  Matcher,
  ORIENTATION_MARGIN,
  REVIEW_FLOOR,
  TokenBucket,
  WEIGHTS,
  artistSimilarity,
  bestMatch,
  durationSimilarity,
  isNeutralKey,
  isrcKey,
  qualifierSimilarity,
  scoreCandidate,
  textKey,
  tokenSetRatio,
  verdictFor,
} from '../src/index.js'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'One More Time',
  artist: 'Daft Punk',
  durationS: 320,
  qualifiers: [],
  ...over,
})

const query = (over: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
  title: 'One More Time',
  artist: 'Daft Punk',
  durationS: 320,
  qualifiers: [] as Qualifier[],
  ...over,
})

describe('the PRD §7.10.4 thresholds', () => {
  it('are 0.8 and 0.5', () => {
    expect(AUTO_ACCEPT).toBe(0.8)
    expect(REVIEW_FLOOR).toBe(0.5)
  })

  it.each([
    [1, 'auto_accept'],
    [0.8, 'auto_accept'],
    [0.79, 'review'],
    [0.5, 'review'],
    [0.49, 'not_found'],
    [0, 'not_found'],
  ] as const)('%s is %s', (score, expected) => {
    expect(verdictFor(score)).toBe(expected)
  })

  it('weights sum to 1', () => {
    const total = WEIGHTS.title + WEIGHTS.artist + WEIGHTS.duration + WEIGHTS.qualifiers
    expect(total).toBeCloseTo(1, 10)
  })
})

describe('token-set ratio', () => {
  it('is 1 for the same tokens in any order', () => {
    expect(tokenSetRatio('One More Time', 'time more one')).toBe(1)
  })

  it('ignores padding on the longer side', () => {
    // The behaviour PRD §7.10.3 asks for by name: an edit distance would punish this.
    expect(tokenSetRatio('One More Time', 'One More Time (Daft Punk Remix)')).toBe(1)
  })

  it('is 0 for disjoint text', () => {
    expect(tokenSetRatio('One More Time', 'Smells Like Teen Spirit')).toBe(0)
  })

  it('treats two empties as equal and one empty as unmatched', () => {
    expect(tokenSetRatio('', '')).toBe(1)
    expect(tokenSetRatio('x', '')).toBe(0)
  })
})

describe('artist similarity', () => {
  it('folds before comparing', () => {
    expect(artistSimilarity('DAFT PUNK ', 'daft punk')).toBe(1)
  })

  it('returns 0.5 when either side is unknown', () => {
    // Unknown is not wrong. A bare title with no artist should not be scored as a
    // mismatch against every candidate.
    expect(artistSimilarity(null, 'Daft Punk')).toBe(0.5)
  })
})

describe('duration tolerance', () => {
  it('is exact within ±3 s', () => {
    expect(durationSimilarity(320, 323)).toBe(1)
    expect(durationSimilarity(320, 317)).toBe(1)
  })

  it('decays beyond it and bottoms out', () => {
    expect(durationSimilarity(320, 326)).toBeLessThan(1)
    expect(durationSimilarity(320, 400)).toBe(0)
  })

  it('is 0.5 when unknown', () => {
    expect(durationSimilarity(null, 320)).toBe(0.5)
  })
})

describe('qualifier agreement is asymmetric', () => {
  it('is 1 when both sides agree', () => {
    expect(qualifierSimilarity([], [])).toBe(1)
    expect(qualifierSimilarity([Qualifier.LIVE], [Qualifier.LIVE])).toBe(1)
  })

  it('punishes an unwanted live recording more than a missing one', () => {
    // A live take offered for a studio query is a different performance; a studio take
    // offered for a live query is at least the song.
    const unwantedLive = qualifierSimilarity([], [Qualifier.LIVE])
    const missingLive = qualifierSimilarity([Qualifier.LIVE], [])
    expect(unwantedLive).toBeLessThan(missingLive)
  })
})

describe('scoring end to end', () => {
  it('an exact match auto-accepts', () => {
    expect(scoreCandidate(query(), candidate()).verdict).toBe('auto_accept')
  })

  it('a live take for a studio query never auto-accepts', () => {
    // The score stays high — it IS a close match, and that is worth reporting — but the
    // verdict is capped at review. Within a weighted sum the qualifier term is worth
    // 0.1, so the worst possible mismatch only drags 1.0 to 0.95 and would auto-accept a
    // different recording. This expectation failed on the first run, and the cap in
    // `scoreCandidate` is what it bought.
    const scored = scoreCandidate(query(), candidate({ qualifiers: [Qualifier.LIVE] }))
    expect(scored.score).toBeGreaterThan(AUTO_ACCEPT)
    expect(scored.verdict).toBe('review')
  })

  it('the cap applies only to qualifiers the query did not ask for', () => {
    const wanted = scoreCandidate(
      query({ qualifiers: [Qualifier.LIVE] }),
      candidate({ qualifiers: [Qualifier.LIVE] }),
    )
    expect(wanted.verdict).toBe('auto_accept')
  })

  it('a different song is not_found', () => {
    const scored = scoreCandidate(
      query(),
      candidate({ title: 'Smells Like Teen Spirit', artist: 'Nirvana', durationS: 301 }),
    )
    expect(scored.verdict).toBe('not_found')
  })

  it('popularity breaks a tie and nothing more', () => {
    const tie = bestMatch(query(), [candidate({ popularity: 0.1 }), candidate({ popularity: 0.9 })])
    expect(tie?.candidate.popularity).toBe(0.9)

    // ...but it must not outrank a better match.
    const better = bestMatch(query(), [
      candidate({ popularity: 0 }),
      candidate({ title: 'Something Else', popularity: 1 }),
    ])
    expect(better?.candidate.title).toBe('One More Time')
  })

  it('returns null for no candidates', () => {
    expect(bestMatch(query(), [])).toBeNull()
  })
})

describe('the cache stores neutral keys only', () => {
  it('accepts an ISRC key and a hashed text key', () => {
    expect(isNeutralKey(isrcKey('usrc17607839'))).toBe(true)
    expect(isNeutralKey(textKey('One More Time', 'Daft Punk'))).toBe(true)
  })

  it('rejects anything that could contain the query', () => {
    expect(isNeutralKey('daft punk|one more time')).toBe(false)
    expect(isNeutralKey('q#notahash')).toBe(false)
  })

  it('refuses to store under a non-neutral key rather than sanitizing it', () => {
    // Sanitizing would keep working while the invariant had already been broken
    // upstream, and the upstream bug would never surface.
    const cache = new MatchCache<string>()
    expect(() => cache.set('one more time', 'x')).toThrow(/non-neutral/)
  })

  it('the text key does not contain the text', () => {
    const key = textKey('One More Time', 'Daft Punk')
    expect(key).not.toMatch(/one|more|time|daft|punk/i)
  })

  it('folds, so spacing and casing share a row', () => {
    expect(textKey('One More Time', 'Daft Punk')).toBe(textKey('one more  time', 'DAFT PUNK'))
  })

  it('expires entries', () => {
    let now = 0
    const cache = new MatchCache<string>(1000, () => now)
    cache.set(isrcKey('USRC17607839'), 'v')
    expect(cache.get(isrcKey('USRC17607839'))).toBe('v')
    now = 1001
    expect(cache.get(isrcKey('USRC17607839'))).toBeNull()
  })

  it('has a TTL at all, and a bounded one', () => {
    // CLAUDE.md: never persist provider content beyond ToS limits. An unbounded cache
    // is the violation, and a very long one is the same violation more slowly.
    expect(DEFAULT_TTL_MS).toBeGreaterThan(0)
    expect(DEFAULT_TTL_MS).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000)
  })
})

/** A lookup that records what it was asked and returns scripted candidates. */
function fakeLookup(
  candidates: readonly Candidate[],
  isrcResult: Candidate | null = null,
): Lookup & { searches: string[] } {
  const searches: string[] = []
  return {
    searches,
    byIsrc: vi.fn(async () => isrcResult),
    search: vi.fn(async (title: string, artist: string | null) => {
      searches.push(`${title}|${artist ?? ''}`)
      return candidates
    }),
  }
}

describe('matching order', () => {
  const input = {
    title: 'One More Time',
    artist: 'Daft Punk',
    isrc: null,
    durationS: 320,
    qualifiers: [] as Qualifier[],
  }

  it('prefers an exact ISRC over any text search', async () => {
    const primary = fakeLookup([], candidate())
    const matcher = new Matcher({ primary, bucket: new TokenBucket(0) })
    const result = await matcher.match({ ...input, isrc: 'USRC17607839' })

    expect(result.source).toBe('isrc')
    expect(result.scored?.score).toBe(1)
    expect(primary.search).not.toHaveBeenCalled()
  })

  it('falls back to Deezer when the primary finds nothing', async () => {
    const primary = fakeLookup([])
    const fallback = fakeLookup([candidate()])
    const result = await new Matcher({ primary, fallback, bucket: new TokenBucket(0) }).match(input)

    expect(result.source).toBe('text')
    expect(fallback.search).toHaveBeenCalled()
  })

  it('serves a repeat query from cache without asking anyone', async () => {
    const primary = fakeLookup([candidate()])
    const matcher = new Matcher({ primary, bucket: new TokenBucket(0) })
    await matcher.match(input)
    const second = await matcher.match(input)

    expect(second.source).toBe('cache')
    expect(primary.search).toHaveBeenCalledTimes(1)
  })

  it('every primary call goes through the bucket', async () => {
    const bucket = new TokenBucket(0)
    const primary = fakeLookup([candidate()])
    await new Matcher({ primary, bucket }).match(input)
    expect(bucket.count).toBeGreaterThan(0)
  })
})

describe('ADR-002 step 5: the alternate reading', () => {
  const ambiguous = {
    title: 'Daft Punk',
    artist: 'One More Time',
    isrc: null,
    durationS: 320,
    qualifiers: [] as Qualifier[],
    alternate: { title: 'One More Time', artist: 'Daft Punk' },
  }

  it('flips the orientation when the swap wins by the margin', async () => {
    const primary: Lookup = {
      byIsrc: async () => null,
      // The swapped reading finds the real recording; the original finds nothing good.
      search: async (title: string) =>
        title === 'One More Time'
          ? [candidate()]
          : [candidate({ title: 'Unrelated', artist: 'Nobody' })],
    }
    const result = await new Matcher({ primary, bucket: new TokenBucket(0) }).match(ambiguous)

    expect(result.orientationFlipped).toBe(true)
    expect(result.source).toBe('alternate')
    expect(result.scored?.candidate.title).toBe('One More Time')
  })

  it('keeps the original when the swap does not win clearly', async () => {
    // The original reading is the correct one here, so the swap scores worse and the
    // prior stands. The first version of this test had the orientations the other way
    // round and asserted no flip — the swap genuinely did win, so the assertion was
    // wrong rather than the matcher.
    const correct = {
      ...ambiguous,
      title: 'One More Time',
      artist: 'Daft Punk',
      alternate: { title: 'Daft Punk', artist: 'One More Time' },
    }
    const primary: Lookup = {
      byIsrc: async () => null,
      search: async () => [candidate()],
    }
    const result = await new Matcher({ primary, bucket: new TokenBucket(0) }).match(correct)
    expect(result.orientationFlipped).toBe(false)
    expect(result.source).toBe('text')
  })

  it('the margin is 0.1, as the ADR says', () => {
    expect(ORIENTATION_MARGIN).toBe(0.1)
  })

  it('resolves against the free catalogs only — no provider quota is spent', async () => {
    // The point of doing this here at all. The matcher has no YouTube client; if it
    // ever gains one, this test should stop compiling rather than quietly pass.
    const primary = fakeLookup([candidate()])
    const matcher = new Matcher({ primary, bucket: new TokenBucket(0) })
    await matcher.match(ambiguous)
    expect(Object.keys(matcher)).not.toContain('youtube')
  })
})
