/**
 * `make golden` writes the corpus; `make golden-check` asserts it is current.
 *
 * Same generate-and-check arrangement as the KICS queries, the bootstrap template and
 * the oracle's frozen outputs: the artifact is committed so it can be read and reviewed,
 * and a check proves the committed bytes are the ones the generator produces now. A
 * generated file nothing verifies is a file that silently stops matching its generator.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generate, serialize } from './generate.js'
import { loadSeed } from './seed.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

export const SEED_PATH = resolve(repoRoot, 'golden', 'seed', 'recordings.jsonl')
export const OUT_PATH = resolve(repoRoot, 'golden', 'extraction', 'generated.json')

function build(): string {
  return serialize(generate(loadSeed(SEED_PATH)))
}

function main(argv: readonly string[]): number {
  const expected = build()

  if (argv.includes('--check')) {
    let actual: string
    try {
      actual = readFileSync(OUT_PATH, 'utf8')
    } catch {
      console.error('golden: generated.json is missing — run `make golden`')
      return 1
    }
    if (actual !== expected) {
      console.error(
        'golden: generated.json does not match the generator. Either it was edited by ' +
          'hand, or the generator or the seed changed and it was not regenerated. Run ' +
          '`make golden`.',
      )
      return 1
    }
    const { cases } = JSON.parse(actual) as { cases: { tier: string }[] }
    const clean = cases.filter(c => c.tier === 'clean').length
    console.log(
      `golden: ${cases.length} generated cases current (${clean} clean, ${cases.length - clean} noisy)`,
    )
    return 0
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, expected, 'utf8')
  const { cases } = JSON.parse(expected) as { cases: { tier: string; expected: unknown[] }[] }
  const songs = cases.reduce((n, c) => n + c.expected.length, 0)
  console.log(`golden: wrote ${cases.length} cases, ${songs} expected songs`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
