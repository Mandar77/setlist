/**
 * The matching strategy (PRD §7.10, as amended by ADR-002).
 *
 * Order is the whole design:
 *
 *   1. **Cache.** Costs nothing and asks nobody.
 *   2. **ISRC** (§7.10.1). An ISRC is an exact identifier; when the parser recovered one
 *      there is nothing to score.
 *   3. **Normalized text search** (§7.10.2), scored and thresholded (§7.10.3–4).
 *
 * MusicBrainz is reached only through the token bucket, and never on the hot path — PRD
 * §7.10.6 is explicit that its ≤1 req/s limit "forces MusicBrainz lookups onto a
 * rate-limited, cached path, not the hot request path". Deezer is the fallback because
 * it has no such limit.
 *
 * ## ADR-002 step 5
 *
 * When the parser could not settle the line orientation it attaches an `alternate`
 * reading. Both readings are checked here, against the FREE catalogs, before any
 * YouTube quota is spent — the swap wins only by a clear margin, and an unresolved
 * orientation never proceeds to autonomous creation.
 */

import type { Qualifier } from '@setlist/core'

import { MatchCache, isrcKey, textKey } from './cache.js'
import { type Candidate, type Query, type Scored, bestMatch } from './score.js'
import { TokenBucket } from './rate-limit.js'

/** ADR-002 step 5: the swapped reading must win by this much to be taken. */
export const ORIENTATION_MARGIN = 0.1

export interface Lookup {
  /** Exact lookup. Cheap and unambiguous when the parser recovered an ISRC. */
  byIsrc(isrc: string): Promise<Candidate | null>
  /** Text search. Returns candidates to be scored, not a decision. */
  search(title: string, artist: string | null): Promise<readonly Candidate[]>
}

export interface MatchInput {
  readonly title: string
  readonly artist: string | null
  readonly isrc: string | null
  readonly durationS: number | null
  readonly qualifiers: readonly Qualifier[]
  /** ADR-002: the swapped reading, when orientation was uncertain. */
  readonly alternate?: { readonly title: string; readonly artist: string | null }
}

export type MatchSource = 'cache' | 'isrc' | 'text' | 'alternate'

/**
 * What happened to the line's orientation (ADR-002 step 5).
 *
 *   * `not_applicable` - the parser was sure, so there was no alternate to weigh.
 *   * `resolved` - one reading won by the margin. Either the original was confirmed or
 *     the swap replaced it; both are decisions.
 *   * `unresolved` - neither reading won clearly. The catalogs were asked and did not
 *     answer, which is NOT the same as the original being right, so the item goes to
 *     review and autonomous creation refuses it.
 */
export type OrientationOutcome = 'not_applicable' | 'resolved' | 'unresolved'

export interface MatchResult {
  readonly scored: Scored | null
  readonly source: MatchSource | null
  /** Set when ADR-002's alternate reading won and the orientation was flipped. */
  readonly orientationFlipped: boolean
  readonly orientationOutcome: OrientationOutcome
}

/**
 * May this result be created autonomously, without a person looking at it?
 *
 * Two independent vetoes, and ADR-002 step 5 is explicit about the second: "Autonomous
 * creation never proceeds on an unresolved orientation." An unresolved orientation can
 * still produce a high-scoring match -- the catalogs simply could not say WHICH reading
 * it was a high-scoring match for -- so the score alone would wave it through.
 */
export function mayCreateAutonomously(result: MatchResult): boolean {
  if (result.orientationOutcome === 'unresolved') return false
  return result.scored?.verdict === 'auto_accept'
}

export interface MatcherOptions {
  /** Rate-limited, cached. MusicBrainz. */
  readonly primary: Lookup
  /** Unlimited fallback. Deezer. */
  readonly fallback?: Lookup
  readonly bucket?: TokenBucket
  readonly cache?: MatchCache<Scored>
}

export class Matcher {
  private readonly primary: Lookup
  private readonly fallback: Lookup | null
  private readonly bucket: TokenBucket
  private readonly cache: MatchCache<Scored>

  constructor(options: MatcherOptions) {
    this.primary = options.primary
    this.fallback = options.fallback ?? null
    this.bucket = options.bucket ?? new TokenBucket()
    this.cache = options.cache ?? new MatchCache<Scored>()
  }

  private queryOf(input: MatchInput): Query {
    return {
      title: input.title,
      artist: input.artist,
      durationS: input.durationS,
      qualifiers: input.qualifiers,
    }
  }

  /** Every primary call goes through the bucket. There is no other path to it. */
  private async primarySearch(title: string, artist: string | null): Promise<readonly Candidate[]> {
    await this.bucket.acquire()
    return this.primary.search(title, artist)
  }

  async match(input: MatchInput): Promise<MatchResult> {
    const query = this.queryOf(input)

    // 1. Cache.
    const key = input.isrc ? isrcKey(input.isrc) : textKey(input.title, input.artist)
    const cached = this.cache.get(key)
    if (cached !== null) {
      return {
        scored: cached,
        source: 'cache',
        orientationFlipped: false,
        // A cache hit is keyed on the query as the parser produced it, so whatever the
        // orientation question was, it was answered when the row was written.
        orientationOutcome: 'not_applicable',
      }
    }

    // 2. ISRC. An exact identifier needs no scoring, so it is accepted as-is.
    if (input.isrc !== null) {
      await this.bucket.acquire()
      const exact = await this.primary.byIsrc(input.isrc)
      if (exact !== null) {
        const scored: Scored = {
          candidate: exact,
          score: 1,
          verdict: 'auto_accept',
          parts: { title: 1, artist: 1, duration: 1, qualifiers: 1 },
        }
        this.cache.set(key, scored)
        // An ISRC identifies the recording outright, so orientation stops being a
        // question rather than being resolved.
        return {
          scored,
          source: 'isrc',
          orientationFlipped: false,
          orientationOutcome: 'not_applicable',
        }
      }
    }

    // 3. Text search, primary then fallback.
    let candidates = await this.primarySearch(input.title, input.artist)
    if (candidates.length === 0 && this.fallback !== null) {
      candidates = await this.fallback.search(input.title, input.artist)
    }
    const primaryBest = bestMatch(query, candidates)

    // ADR-002 step 5: try the swapped reading too, against the same free catalogs.
    if (input.alternate !== undefined) {
      const swapped = await this.searchAlternate(input)
      const originalScore = primaryBest?.score ?? 0
      const swappedScore = swapped?.score ?? 0

      if (swapped !== null && swappedScore - originalScore >= ORIENTATION_MARGIN) {
        this.cache.set(key, swapped)
        return {
          scored: swapped,
          source: 'alternate',
          orientationFlipped: true,
          orientationOutcome: 'resolved',
        }
      }

      if (primaryBest !== null && originalScore - swappedScore >= ORIENTATION_MARGIN) {
        // The original won by the margin, which is a decision and not a default.
        this.cache.set(key, primaryBest)
        return {
          scored: primaryBest,
          source: 'text',
          orientationFlipped: false,
          orientationOutcome: 'resolved',
        }
      }

      // Neither won. The catalogs were asked and did not answer, so this goes to review
      // rather than quietly keeping the parser's guess -- which is what ADR-002 means by
      // "otherwise keep the prior and send the item to review". The verdict is forced
      // down because a high score here says the TEXT matched something, not that the
      // orientation was right.
      const unresolved =
        primaryBest === null ? null : { ...primaryBest, verdict: 'review' as const }
      if (unresolved !== null) this.cache.set(key, unresolved)
      return {
        scored: unresolved,
        source: unresolved === null ? null : 'text',
        orientationFlipped: false,
        orientationOutcome: 'unresolved',
      }
    }

    if (primaryBest !== null) this.cache.set(key, primaryBest)
    return {
      scored: primaryBest,
      source: primaryBest === null ? null : 'text',
      orientationFlipped: false,
      orientationOutcome: 'not_applicable',
    }
  }

  private async searchAlternate(input: MatchInput): Promise<Scored | null> {
    const alternate = input.alternate!
    const query: Query = {
      title: alternate.title,
      artist: alternate.artist,
      durationS: input.durationS,
      qualifiers: input.qualifiers,
    }
    let candidates = await this.primarySearch(alternate.title, alternate.artist)
    if (candidates.length === 0 && this.fallback !== null) {
      candidates = await this.fallback.search(alternate.title, alternate.artist)
    }
    return bestMatch(query, candidates)
  }
}
