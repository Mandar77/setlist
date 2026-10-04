// The weekly re-match workflow (M6-02).
//
// Three claims, each checked against something that could fail it: Standard and never
// Express; the transition count the usage model multiplies is the count the definition
// actually produces; and prod stays inside its share.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import {
  BATCH_SIZE,
  STATE_MACHINE_TYPE,
  maxItemsWithin,
  transitionsPerRun,
  weeklyRematchDefinition,
} from '../lib/rematch/state-machine.js'

const configDir = join(import.meta.dirname, '..', 'free-tier')
const model = parse(readFileSync(join(configDir, 'usage-model.yaml'), 'utf8')) as {
  operations: Record<string, Record<string, number | string>>
  volumes: Record<string, Record<string, number>>
}
const budget = parse(readFileSync(join(configDir, 'budget.yaml'), 'utf8')) as {
  gate_pct: number
  limits: Record<string, { split: Record<string, number> }>
}

describe('Standard only', () => {
  it('is STANDARD', () => {
    expect(STATE_MACHINE_TYPE).toBe('STANDARD')
  })

  it('is not EXPRESS anywhere in the definition', () => {
    // Express bills per request and per GB-second with no free tier at all. SZC-SFN-EXPRESS
    // catches it on a synthesized template; this catches it in the definition, which is
    // where it would be written.
    expect(JSON.stringify(weeklyRematchDefinition())).not.toMatch(/EXPRESS/i)
  })

  it('bounds Map concurrency', () => {
    // An unbounded Map runs every batch at once, and the MusicBrainz token bucket is
    // per-process — it cannot help when the processes are separate Lambdas.
    const map = weeklyRematchDefinition().States['RematchBatches']!
    expect(map['Type']).toBe('Map')
    expect(map['MaxConcurrency']).toBeGreaterThan(0)
    expect(map['MaxConcurrency']).toBeLessThanOrEqual(4)
  })
})

describe('the transition count matches the definition', () => {
  it('counts the states outside the Map', () => {
    const definition = weeklyRematchDefinition()
    // Every state outside the Map is entered once per run.
    expect(Object.keys(definition.States)).toHaveLength(4)
    expect(transitionsPerRun(0)).toBe(4)
  })

  it('counts the states inside the Map, per batch', () => {
    const iterator = weeklyRematchDefinition().States['RematchBatches']!['Iterator'] as {
      States: Record<string, unknown>
    }
    const perBatch = Object.keys(iterator.States).length
    expect(perBatch).toBe(3)
    expect(transitionsPerRun(BATCH_SIZE) - transitionsPerRun(0)).toBe(perBatch)
  })

  it('agrees with the numbers the usage model multiplies', () => {
    // The drift this guards against: a state added to the definition without the model
    // being updated makes every forecast quietly wrong, and nothing else would notice.
    expect(model.operations['weekly_rematch_run']!['step_functions_transitions']).toBe(
      transitionsPerRun(0),
    )
    expect(model.operations['weekly_rematch_batch']!['step_functions_transitions']).toBe(
      transitionsPerRun(BATCH_SIZE) - transitionsPerRun(0),
    )
  })

  it('scales with batches, not with items', () => {
    // Mapping per item would make the count scale with the catalog and walk into the
    // limit as the user base grows.
    expect(transitionsPerRun(BATCH_SIZE)).toBe(transitionsPerRun(1))
    expect(transitionsPerRun(BATCH_SIZE + 1)).toBeGreaterThan(transitionsPerRun(BATCH_SIZE))
  })

  it('rejects a negative item count rather than returning a plausible number', () => {
    expect(() => transitionsPerRun(-1)).toThrow(RangeError)
  })
})

describe('prod stays inside its share', () => {
  const share = budget.limits['step_functions_transitions']!.split['prod']!

  it('is at most 2000 transitions a month, which is the share', () => {
    expect(share).toBe(2000)
    const monthly =
      model.volumes['prod']!['weekly_rematch_run']! * transitionsPerRun(0) +
      model.volumes['prod']!['weekly_rematch_batch']! *
        (transitionsPerRun(BATCH_SIZE) - transitionsPerRun(0))
    expect(monthly).toBeLessThanOrEqual(share)
  })

  it('also stays under the 70% gate, not merely under the allowance', () => {
    // ADR-008's rule applied to a new row: planned volumes follow from the gate. 600
    // batches fits the allowance at 1,816 and fails the gate at 90.8%.
    const monthly =
      model.volumes['prod']!['weekly_rematch_run']! * transitionsPerRun(0) +
      model.volumes['prod']!['weekly_rematch_batch']! *
        (transitionsPerRun(BATCH_SIZE) - transitionsPerRun(0))
    expect(monthly / share).toBeLessThanOrEqual(budget.gate_pct / 100)
  })

  it.each(['dev', 'stage'])('%s stays under the gate too', env => {
    const envShare = budget.limits['step_functions_transitions']!.split[env]!
    const monthly =
      model.volumes[env]!['weekly_rematch_run']! * transitionsPerRun(0) +
      model.volumes[env]!['weekly_rematch_batch']! *
        (transitionsPerRun(BATCH_SIZE) - transitionsPerRun(0))
    expect(monthly / envShare).toBeLessThanOrEqual(budget.gate_pct / 100)
  })

  it('says how large a catalog the budget actually buys', () => {
    // Worth stating as a number rather than leaving implicit: this is the ceiling the
    // design has to live under, and it is the thing that changes if the gate moves.
    const gated = Math.floor((share * budget.gate_pct) / 100)
    expect(maxItemsWithin(gated, 4)).toBeGreaterThanOrEqual(20_000)
  })
})
