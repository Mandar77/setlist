/** `pnpm -C tools/seed-catalog exec tsx src/verify-cli.ts` — the gate `make seed` runs. */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { verifyFile } from './verify.js'

// Three levels from src/, matching cli.ts. Four was written for the compiled dist/src
// layout and silently resolved one directory above the repository, where the seed file
// does not exist — an ENOENT that reads like a missing file rather than a wrong path.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

process.exitCode = verifyFile(
  process.argv[2] ?? resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl'),
)
