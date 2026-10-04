/**
 * Producer golden samples — one valid message per event type (PED §10.4).
 *
 * "Producer golden samples are verified by consumers in CI." These are that artifact:
 * the producer writes what it actually sends, and every consumer validates against the
 * same objects, so a consumer that has drifted fails in its own suite rather than at 3am
 * against a real message.
 *
 * They live in TypeScript rather than JSON because the whole point is that they are
 * type-checked against the schemas they exemplify. A JSON fixture can describe a message
 * that the schema does not accept; this cannot compile if it does.
 *
 * Every id here is fixed, not generated. A sample with a random uuid is a sample that
 * cannot be compared byte for byte, and comparing them is what catches an envelope change
 * nobody meant to make.
 */

import type { EventType } from './events.js'

// Crockford base32, which EXCLUDES I, L, O and U. The first draft spelled words into
// these ids -- USER, JOB, CONN -- and three of the five were invalid ULIDs as a result.
const USER = '01J0000000000000000000SER1'
const SCAN = '01J00000000000000000SCAN01'
const JOB = '01J00000000000000000JB0001'
const CONN = '01J0000000000000000000CNN1'
const CORRELATION = '01J0000000000000000000CRR1'

/** Shared envelope fields. Only `type` and `data` vary between samples. */
const base = {
  id: '0f9f1d7e-4a2b-4c3d-8e5f-6a7b8c9d0e1f',
  correlationid: CORRELATION,
  idempotencykey: `scan:${SCAN}:v1`,
  env: 'dev',
} as const

export const GOLDEN_SAMPLES: Readonly<Record<EventType, Record<string, unknown>>> = Object.freeze({
  'setlist.identity.UserDeleted.v1': {
    ...base,
    type: 'setlist.identity.UserDeleted.v1',
    data: { userId: USER, deletedAt: '2026-10-04T00:00:00.000Z' },
  },
  'setlist.provider.ProviderConnected.v1': {
    ...base,
    type: 'setlist.provider.ProviderConnected.v1',
    data: { userId: USER, provider: 'youtube', connectionId: CONN },
  },
  'setlist.provider.ProviderTokenRevoked.v1': {
    ...base,
    type: 'setlist.provider.ProviderTokenRevoked.v1',
    data: { userId: USER, provider: 'youtube', connectionId: CONN, reason: 'user_revoked' },
  },
  'setlist.ingestion.ScanSubmitted.v1': {
    ...base,
    type: 'setlist.ingestion.ScanSubmitted.v1',
    data: {
      scanId: SCAN,
      userId: USER,
      sourceKind: 'paste',
      textDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteLength: 120,
    },
  },
  'setlist.extraction.SongsExtracted.v1': {
    ...base,
    type: 'setlist.extraction.SongsExtracted.v1',
    data: {
      scanId: SCAN,
      userId: USER,
      itemCount: 4,
      rejectedCount: 0,
      residualCount: 1,
      deterministicCoverage: 0.8,
    },
  },
  'setlist.matching.SongsMatched.v1': {
    ...base,
    type: 'setlist.matching.SongsMatched.v1',
    data: { scanId: SCAN, userId: USER, matchedCount: 3, unmatchedCount: 1, needsReviewCount: 1 },
  },
  'setlist.playlist.CreatePlaylistRequested.v1': {
    ...base,
    type: 'setlist.playlist.CreatePlaylistRequested.v1',
    data: { jobId: JOB, scanId: SCAN, userId: USER, provider: 'youtube', trackCount: 3 },
  },
  'setlist.playlist.PlaylistCreated.v1': {
    ...base,
    type: 'setlist.playlist.PlaylistCreated.v1',
    data: {
      jobId: JOB,
      userId: USER,
      provider: 'youtube',
      providerPlaylistId: 'PL-abc123_def456',
      trackCount: 3,
    },
  },
  'setlist.playlist.JobCompleted.v1': {
    ...base,
    type: 'setlist.playlist.JobCompleted.v1',
    data: { jobId: JOB, userId: USER, outcome: 'partial', trackCount: 3, failedCount: 1 },
  },
  'setlist.provider.ProviderCallFailed.v1': {
    ...base,
    type: 'setlist.provider.ProviderCallFailed.v1',
    data: {
      jobId: JOB,
      provider: 'youtube',
      statusCode: 403,
      reason: 'quota',
      retryable: true,
    },
  },
  'setlist.analytics.UsageThresholdCrossed.v1': {
    ...base,
    type: 'setlist.analytics.UsageThresholdCrossed.v1',
    data: { limitName: 'youtube_units_per_day', env: 'dev', sharePct: 72.5, threshold: 70 },
  },
  'setlist.config.FlagChanged.v1': {
    ...base,
    type: 'setlist.config.FlagChanged.v1',
    data: {
      flag: 'autonomous_creation',
      env: 'dev',
      enabled: false,
      changedAt: '2026-10-04T00:00:00.000Z',
    },
  },
})
