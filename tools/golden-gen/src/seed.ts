/** Reading `golden/seed/recordings.jsonl`, the one input this generator has. */

import { readFileSync } from 'node:fs'

export interface CreditedArtist {
  readonly name: string
  readonly mbid: string
  readonly join: string
}

export interface SeedRow {
  readonly recording_mbid: string
  readonly title: string
  readonly version: string
  readonly artist: string
  readonly artists: readonly CreditedArtist[]
  readonly isrc: string | null
  readonly isrcs: readonly string[]
  readonly duration_ms: number | null
  readonly release_mbid: string
  readonly release_title: string
  readonly release_date: string | null
  readonly tags: readonly string[]
}

export function loadSeed(path: string): SeedRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as SeedRow)
}
