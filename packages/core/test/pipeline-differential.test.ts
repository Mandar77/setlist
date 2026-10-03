/**
 * The whole pipeline, diffed against the oracle on every golden case.
 *
 * The function-level diff in `differential.test.ts` proves the pieces agree. This proves
 * they compose: the same text in, the same items, spans, confidences, hints, rejections
 * and residual out — compared against `golden/oracle/`, the byte-frozen output CORE-01
 * recorded from the Python implementation.
 *
 * Nothing here calls the oracle. It is frozen, and its answers are committed, which is
 * what makes a frozen reference useful rather than merely retired.
 *
 * The ten-thousand-input half of ADR-001's requirement lives in `pipeline-10k.test.ts`,
 * which explains why it had to move out.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractDeterministic } from '../src/pipeline.js'
import {
  canonical,
  frozenOutputs,
  handWrittenCases,
  ORACLE_DIR,
  render,
  type OracleOutput,
} from './support/oracle-shape.js'
import { repoRoot } from './support/repo-root.js'

const cases = handWrittenCases()
const frozen = frozenOutputs()

describe('the frozen oracle outputs', () => {
  it('exist and cover the hand-written corpus', () => {
    // The control: every assertion below reports by absence, so an empty directory
    // would make the suite pass while comparing nothing.
    expect(frozen.length).toBeGreaterThanOrEqual(8)
    expect(cases.size).toBeGreaterThanOrEqual(8)
  })
})

// --------------------------------------------------------- the allowlist (ADR-001)

/**
 * One permitted difference between the port and the frozen oracle.
 *
 * `tools/check_diff_allowlist.js` owns the schema and the scope — that `kind` is
 * `orientation` and nothing else, that `reason` says something, that the case exists.
 * What it cannot see is whether the difference is real, so that is checked here, where
 * both outputs are in hand.
 */
interface AllowlistEntry {
  readonly case: string
  readonly items: readonly { title: string; artist: string | null; confidence: number }[]
  readonly reason: string
}

/**
 * The permitted differences, by case id.
 *
 * At CORE-04 this is empty and the loop below is a plain equality check on all eight
 * cases. It is wired up anyway: ADR-002 orientation changes arrive at CORE-05, and an
 * allowlist whose consuming code is written at the same time as its first entry is an
 * allowlist that gets written to fit the entry.
 */
function allowlist(): Map<string, AllowlistEntry> {
  // `yaml` is a dependency of infra; pnpm hoists nothing. Same resolution as
  // tools/check_workflows.js. Reaching for node: APIs is what the test-only ESLint
  // exemption is for — `src/` stays pure.
  const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml') as {
    parse: (source: string) => { entries?: AllowlistEntry[] } | null
  }
  const document = parse(readFileSync(resolve(repoRoot, 'golden', 'diff-allowlist.yaml'), 'utf8'))
  return new Map((document?.entries ?? []).map(entry => [entry.case, entry]))
}

const permitted = allowlist()

/**
 * Everything about an output that an orientation change may not touch.
 *
 * Which side of a pair is the title, obviously — and also the confidence, because
 * swapping a pair genuinely moves it. The penalties are computed on the title and the
 * artist, so reading "Overmono - So U Kno" the other way round makes "Overmono" a
 * single-token title and takes 0.05 off. That surfaced the first time a real swap was
 * run through here: 0.92 against 0.87, on a case where nothing was wrong.
 *
 * Excusing confidence outright would be the easy fix and the wrong one — a scoring bug
 * on an allowlisted case would then pass unnoticed. So it is not excused, it is moved:
 * the entry must state the confidence it expects, and the check below holds the port to
 * that number. The oracle stops being the authority for an allowlisted item; a reviewed
 * line in a YAML file takes over.
 */
function orientationInvariant(output: OracleOutput): unknown {
  return {
    ...output,
    items: output.items.map(({ title, artist, confidence: _confidence, ...rest }) => ({
      ...rest,
      // Sorted, so a swapped pair and an unswapped one serialize identically while every
      // other field still has to match exactly.
      pair: [title, artist ?? ''].sort(),
    })),
  }
}

describe('packages/core reproduces tools/oracle-py end to end', () => {
  for (const name of frozen) {
    const id = name.replace(/\.json$/u, '')
    it(id, () => {
      const text = cases.get(id)
      expect(text, `no golden case named ${id}`).toBeDefined()

      const expected = JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as OracleOutput
      const actual = render(extractDeterministic(text!), expected.source_kind)

      const entry = permitted.get(id)
      if (entry === undefined) {
        expect(canonical(actual)).toBe(canonical(expected))
        return
      }

      // An entry for a case that no longer diverges is a standing permission nobody
      // needs, and the next real difference would slip in under it unnoticed.
      expect(
        canonical(actual),
        `${id} is on the diff allowlist but matches the oracle exactly — remove the entry`,
      ).not.toBe(canonical(expected))

      // The difference must be an orientation swap and nothing else. Spans, parsers,
      // hints, duplicates, residual, rejections and stats all still have to match: an
      // allowlisted case is permitted to read a pair the other way round, not to be
      // excused from the differential.
      expect(canonical(orientationInvariant(actual))).toBe(
        canonical(orientationInvariant(expected)),
      )

      // And it must be the swap the entry claims, confidence included, so the file says
      // what actually happens rather than merely that something does.
      expect(
        actual.items.map(i => ({ title: i.title, artist: i.artist, confidence: i.confidence })),
      ).toEqual(
        entry.items.map(i => ({ title: i.title, artist: i.artist, confidence: i.confidence })),
      )
    })
  }

  it('lists no difference that has gone away', () => {
    // The loop above only visits cases that exist. An entry naming a deleted case would
    // otherwise sit here forever, unchecked.
    for (const id of permitted.keys()) {
      expect(cases.has(id), `the allowlist names "${id}", which is not a golden case`).toBe(true)
    }
  })
})
