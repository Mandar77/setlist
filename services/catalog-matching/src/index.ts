/**
 * catalog-matching: ISRC first, then normalized text search, scored and thresholded.
 *
 * The constraint that shapes it is MusicBrainz's ≤1 request/second (PRD §7.10.6), which
 * is a condition of being allowed to use a volunteer-run service rather than a
 * performance limit. Everything else here — the cache, the Deezer fallback, the
 * ISRC-first order — exists to ask it as rarely as possible.
 */

export * from './cache.js'
export * from './match.js'
export * from './rate-limit.js'
export * from './rematch.js'
export * from './score.js'
