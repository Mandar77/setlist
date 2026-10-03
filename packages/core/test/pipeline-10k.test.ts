/**
 * The ten-thousand-input differential (ADR-001).
 *
 * > TypeScript output must equal the oracle's on every golden case and on ≥10,000
 * > generated inputs.
 *
 * Eight golden cases prove the port composes; ten thousand prove it on input nobody
 * chose by hand, which is where a port actually breaks. It found two real divergences —
 * a `\p{Lu}` sentence lookahead that broke a Greek tracklist, and an uncompensated float
 * sum — neither of which any hand-written case would have produced.
 *
 * ## Why this is its own file
 *
 * Because the mutation run cannot include it, and a mutation run that *silently* lost it
 * would be worse than one that visibly excludes it.
 *
 * Stryker instruments every statement in the core, which makes this test — ten thousand
 * whole-pipeline runs plus ten thousand SHA-256 digests — exceed any sane per-test
 * timeout. The first attempt failed Stryker's own dry run at 30 s. Raising the timeout
 * would be worse than failing: a mutant that merely made the core slower would be scored
 * "killed by timeout", which is not a test noticing a wrong answer, and the mutation
 * score would quietly start measuring performance.
 *
 * So `vitest.stryker.config.ts` excludes this one file by name. Everything else —
 * including the 4,903-case function-level diff and the eight golden cases — is mutated
 * against. The exclusion is narrow, written down, and has a reason that was measured.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractDeterministic } from '../src/pipeline.js'
import { sha256Hex } from '../src/sha256.js'
import {
  compact,
  frozenOutputs,
  handWrittenCases,
  ORACLE_DIR,
  render,
  type OracleOutput,
} from './support/oracle-shape.js'
import { repoRoot } from './support/repo-root.js'

interface PipelineCase {
  readonly input: string
  readonly digest: string
}

const PIPELINE_FIXTURE = resolve(repoRoot, 'golden', 'diff', 'pipeline.jsonl')

const pipelineCases: PipelineCase[] = readFileSync(PIPELINE_FIXTURE, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('//'))
  .map(line => JSON.parse(line) as PipelineCase)

describe('the ten-thousand-input differential', () => {
  it('carries at least the ten thousand ADR-001 asks for', () => {
    // The control. The assertion below reports by absence, so an empty fixture would
    // make it pass while comparing nothing at all.
    expect(pipelineCases.length).toBeGreaterThanOrEqual(10_000)
  })

  it('agrees with Python about what canonical means', () => {
    // Checked before the digests are trusted. If the two encoders disagreed about
    // spacing or key order, every one of the ten thousand would fail for a reason that
    // has nothing to do with the port.
    const cases = handWrittenCases()
    for (const name of frozenOutputs().slice(0, 3)) {
      const id = name.replace(/\.json$/u, '')
      const expected = JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as OracleOutput
      const actual = render(extractDeterministic(cases.get(id)!), expected.source_kind)
      // Round-tripping the oracle's own file through `compact` gives exactly what Python
      // hashed; the port's rendering must serialize to the same bytes.
      expect(compact(actual)).toBe(compact(expected))
    }
  })

  it('reproduces the oracle on every one of them', () => {
    const wrong: string[] = []
    for (const c of pipelineCases) {
      const digest = sha256Hex(compact(render(extractDeterministic(c.input), 'printed')))
      if (digest !== c.digest) wrong.push(JSON.stringify(c.input))
      if (wrong.length >= 10) break
    }
    expect(
      wrong.length,
      `the port diverges from the oracle on these inputs:\n${wrong.join('\n')}`,
    ).toBe(0)
  })
})
