/**
 * Find the repository root by looking for it, not by counting `..` segments.
 *
 * The differential suites read fixtures out of `golden/`, which lives at the repo root
 * and not inside this package. `resolve(here, '..', '..', '..')` is the obvious way to
 * get there and it is wrong as soon as anything runs the tests from somewhere else.
 *
 * Stryker is that somewhere else. It copies the package into
 * `packages/core/.stryker-tmp/sandbox-XXXX/` and runs the tests from there, so three
 * levels up lands on `packages/core` instead of the repo, `golden/` is not there, and
 * both differential files threw ENOENT while loading.
 *
 * **They threw, and the mutation run reported success anyway.** Stryker's dry run said
 * "Ran 230 tests" and carried on; the 27 tests in those two files — the function-level
 * diff over 4,903 strings and the whole-pipeline diff over ten thousand inputs — simply
 * were not there. A mutation score computed against a suite that has silently lost its
 * two largest tests is worse than no score, because it looks like one.
 *
 * So: walk up until a directory contains `golden/oracle`, and throw with the path that
 * was searched if none does. The failure is then a sentence rather than a number that is
 * quietly too low.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The marker that identifies the repository root rather than any parent directory. */
const MARKER = join('golden', 'oracle')

/** How far up to look before giving up. Deeper than any sandbox nesting. */
const MAX_DEPTH = 10

export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  const tried: string[] = []
  let current = resolve(from)

  for (let i = 0; i < MAX_DEPTH; i += 1) {
    tried.push(current)
    if (existsSync(join(current, MARKER))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(
    `could not find the repository root above ${from}: no directory contains ${MARKER}.\n` +
      `Searched:\n  ${tried.join('\n  ')}\n` +
      'The differential fixtures live at the repo root, so a test that cannot find them ' +
      'must fail loudly rather than quietly test nothing.',
  )
}

/** The repository root, resolved once. */
export const repoRoot = findRepoRoot()
