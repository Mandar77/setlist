/**
 * `pnpm -C tools/seed-catalog harvest` — the only thing that talks to MusicBrainz.
 *
 * Deliberately not wired into `make verify` or CI. A gate that makes a network call to a
 * volunteer-run service every build would be both unreliable and rude; the harvest is
 * run by a person, occasionally, and its output is committed. What CI checks is the
 * committed file, which `verify.ts` does offline.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { harvest } from './harvest.js'
import { MusicBrainzClient } from './musicbrainz.js'
import { FileStore } from './store.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

export const ROWS_PATH = resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl')
export const STATE_PATH = resolve(repoRoot, 'golden', 'seed', '.harvest-state.json')

async function main(): Promise<number> {
  const target = Number(process.env['SEED_TARGET_ROWS'] ?? 2000)

  const summary = await harvest({
    client: new MusicBrainzClient(),
    store: new FileStore(ROWS_PATH, STATE_PATH),
    targetRows: target,
    log: message => console.log(`  ${message}`),
  })

  const pct = summary.rows === 0 ? 0 : (100 * summary.withIsrc) / summary.rows
  console.log(
    `\nseed catalog: ${summary.rows} rows, ${summary.withIsrc} with an ISRC ` +
      `(${pct.toFixed(1)}%), ${summary.requests} request(s)${summary.resumed ? ', resumed' : ''}`,
  )
  return 0
}

// `process.exitCode` rather than `process.exit()`. Calling exit() while fetch's sockets
// are still closing trips a libuv assertion on Windows — `!(handle->flags &
// UV_HANDLE_CLOSING)` — and the harvest dies with a crash dump after printing its
// summary, which looks like a failure and is not one. Setting the code lets Node drain
// and leave on its own.
main().then(
  code => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`seed catalog: ${error instanceof Error ? error.message : String(error)}`)
    console.error('progress is saved; run again to resume')
    process.exitCode = 1
  },
)
