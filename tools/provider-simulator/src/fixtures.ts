/**
 * Recorded fixtures for contract tests (M3-05 done_when).
 *
 * These are the response and error bodies the adapter will actually see, frozen so a
 * consumer can assert against them without a network call and without the simulator.
 * They are the counterpart to `packages/contracts`' golden samples: that package fixes
 * what we publish, this one fixes what the provider returns.
 *
 * Recorded from the simulator rather than typed out, and `fixtures.test.ts` asserts they
 * still match what it produces. A hand-written fixture drifts from the thing it claims to
 * record, and then a consumer passes its tests against a response shape that no longer
 * exists — which is the failure contract tests are supposed to prevent, arriving by the
 * back door.
 */

import { backendError, playlistNotFound, quotaExceeded, rateLimited } from './errors.js'
import type { YouTubeErrorBody } from './errors.js'

export interface RecordedError {
  readonly status: number
  readonly retryAfter: number | null
  readonly retryable: boolean
  readonly deferrable: boolean
  readonly body: YouTubeErrorBody
}

const record = (error: ReturnType<typeof quotaExceeded>): RecordedError => ({
  status: error.status,
  retryAfter: error.retryAfter,
  retryable: error.retryable,
  deferrable: error.deferrable,
  body: error.body,
})

/** The error responses the adapter must handle, as the API returns them. */
export const ERROR_FIXTURES = Object.freeze({
  quotaExceeded: record(quotaExceeded()),
  rateLimited: record(rateLimited(30)),
  playlistNotFound: record(playlistNotFound()),
  backendError: record(backendError()),
})

/** A successful 15-song creation, which is PED §11's sizing unit. */
export const FIFTEEN_SONG_JOB = Object.freeze({
  trackCount: 15,
  /** 50 + 15 * 50. The number the whole free-tier model is built on. */
  expectedUnits: 800,
  playlistId: 'pl_000001',
  // The counter is shared across id kinds and the playlist takes 1, so the items run
  // from 2. Recorded from an actual run rather than reasoned about — the first draft
  // assumed 3 and the test caught it, which is the whole argument for recording
  // fixtures instead of writing them.
  itemIds: Object.freeze(
    Array.from({ length: 15 }, (_, i) => `pli_${String(i + 2).padStart(6, '0')}`),
  ),
})
