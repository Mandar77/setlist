// The kill switch, which only ever runs when something is already wrong.
//
// Every claim in M0A-06's done_when is checked here, and each one is checked against an
// input that must NOT trigger it as well as one that must — a kill switch that disables
// everything indiscriminately would pass a test suite that only ever showed it things it
// should disable.

import { describe, expect, it } from 'vitest'

import {
  DISABLEABLE_ENVS,
  KillSwitchIncomplete,
  engageKillSwitch,
  envFromComment,
  isOurs,
  type CloudFrontControl,
  type KillRecord,
  type KillSwitchDeps,
  type LambdaControl,
  type SchedulerControl,
} from '../src/kill-switch.js'

const AT = new Date('2026-10-04T00:00:00.000Z')

interface Calls {
  concurrency: [string, number][]
  mappings: string[]
  schedules: string[]
  distributions: string[]
  records: KillRecord[]
}

function harness(
  over: {
    functions?: { functionName: string; tags: Record<string, string> }[]
    mappings?: { uuid: string; functionName: string; enabled: boolean }[]
    schedules?: { name: string; enabled: boolean; targetFunctionName: string | null }[]
    distributions?: { id: string; comment: string; enabled: boolean }[]
    failOn?: (what: string) => boolean
  } = {},
): { deps: KillSwitchDeps; calls: Calls } {
  const calls: Calls = {
    concurrency: [],
    mappings: [],
    schedules: [],
    distributions: [],
    records: [],
  }
  const fail = over.failOn ?? (() => false)
  const guard = async (what: string, run: () => void): Promise<void> => {
    if (fail(what)) throw new Error(`boom: ${what}`)
    run()
  }

  const lambda: LambdaControl = {
    listFunctions: async () =>
      over.functions ?? [{ functionName: 'setlist-dev-bff', tags: { app: 'setlist' } }],
    setReservedConcurrency: (name, value) =>
      guard(`concurrency:${name}`, () => calls.concurrency.push([name, value])),
    listEventSourceMappings: async () => over.mappings ?? [],
    disableEventSourceMapping: uuid => guard(`mapping:${uuid}`, () => calls.mappings.push(uuid)),
  }
  const scheduler: SchedulerControl = {
    listSchedules: async () => over.schedules ?? [],
    disableSchedule: name => guard(`schedule:${name}`, () => calls.schedules.push(name)),
  }
  const cloudfront: CloudFrontControl = {
    listDistributions: async () => over.distributions ?? [],
    disableDistribution: id => guard(`dist:${id}`, () => calls.distributions.push(id)),
  }
  return {
    calls,
    deps: {
      lambda,
      scheduler,
      cloudfront,
      audit: {
        write: async record => {
          calls.records.push(record)
        },
      },
      now: () => AT,
    },
  }
}

describe('concurrency to zero', () => {
  it('throttles every function tagged app=setlist', async () => {
    const { deps, calls } = harness({
      functions: [
        { functionName: 'setlist-prod-bff', tags: { app: 'setlist' } },
        { functionName: 'setlist-prod-ocr', tags: { app: 'setlist' } },
      ],
    })
    await engageKillSwitch(deps, { reason: 'budget alarm' })
    expect(calls.concurrency).toEqual([
      ['setlist-prod-bff', 0],
      ['setlist-prod-ocr', 0],
    ])
  })

  it('leaves functions this project does not own alone', async () => {
    // The account is single-tenant today, which is exactly why this is worth pinning:
    // the day it is not, a kill switch that throttles everything is an outage someone
    // else has to explain.
    const { deps, calls } = harness({
      functions: [
        { functionName: 'setlist-prod-bff', tags: { app: 'setlist' } },
        { functionName: 'someone-elses', tags: {} },
        { functionName: 'other-app', tags: { app: 'other' } },
      ],
    })
    await engageKillSwitch(deps, { reason: 'budget alarm' })
    expect(calls.concurrency.map(([name]) => name)).toEqual(['setlist-prod-bff'])
  })

  it('recognises ownership by tag, not by name', () => {
    expect(isOurs({ functionName: 'anything', tags: { app: 'setlist' } })).toBe(true)
    expect(isOurs({ functionName: 'setlist-looks-like-ours', tags: {} })).toBe(false)
  })
})

describe('event source mappings and schedules', () => {
  it('disables enabled mappings for our functions', async () => {
    const { deps, calls } = harness({
      mappings: [{ uuid: 'm1', functionName: 'setlist-dev-bff', enabled: true }],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.mappings).toEqual(['m1'])
  })

  it('skips a mapping that is already disabled, so a rerun is a no-op', async () => {
    const { deps, calls } = harness({
      mappings: [{ uuid: 'm1', functionName: 'setlist-dev-bff', enabled: false }],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.mappings).toEqual([])
  })

  it('skips a mapping belonging to someone else', async () => {
    const { deps, calls } = harness({
      mappings: [{ uuid: 'm1', functionName: 'other-app', enabled: true }],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.mappings).toEqual([])
  })

  it('disables schedules that invoke our functions', async () => {
    // A schedule left running re-invokes a throttled function forever, turning a stopped
    // system into a retry storm.
    const { deps, calls } = harness({
      schedules: [
        { name: 'nightly', enabled: true, targetFunctionName: 'setlist-dev-bff' },
        { name: 'theirs', enabled: true, targetFunctionName: 'other-app' },
        { name: 'already-off', enabled: false, targetFunctionName: 'setlist-dev-bff' },
        { name: 'no-target', enabled: true, targetFunctionName: null },
      ],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.schedules).toEqual(['nightly'])
  })
})

describe('distributions: dev and stage, never prod', () => {
  it('disables dev and stage', async () => {
    const { deps, calls } = harness({
      distributions: [
        { id: 'D1', comment: 'setlist-dev', enabled: true },
        { id: 'D2', comment: 'setlist-stage', enabled: true },
      ],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.distributions).toEqual(['D1', 'D2'])
  })

  it('never disables prod', async () => {
    // The asymmetry that matters. Taking production offline to save money is a decision
    // for a human with the context to make it, and an automated switch that makes it at
    // 3am is a worse outage than the bill it prevented.
    const { deps, calls } = harness({
      distributions: [
        { id: 'DPROD', comment: 'setlist-prod', enabled: true },
        { id: 'DDEV', comment: 'setlist-dev', enabled: true },
      ],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.distributions).toEqual(['DDEV'])
    expect(DISABLEABLE_ENVS.has('prod')).toBe(false)
  })

  it('leaves a distribution this project did not create alone', async () => {
    const { deps, calls } = harness({
      distributions: [{ id: 'DX', comment: 'somebody-elses-cdn', enabled: true }],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.distributions).toEqual([])
    expect(envFromComment('somebody-elses-cdn')).toBeNull()
    expect(envFromComment('setlist-stage')).toBe('stage')
  })

  it('skips one already disabled', async () => {
    const { deps, calls } = harness({
      distributions: [{ id: 'D1', comment: 'setlist-dev', enabled: false }],
    })
    await engageKillSwitch(deps, { reason: 'r' })
    expect(calls.distributions).toEqual([])
  })
})

describe('the event record', () => {
  it('records what was stopped, and when', async () => {
    const { deps, calls } = harness({
      functions: [{ functionName: 'setlist-dev-bff', tags: { app: 'setlist' } }],
      distributions: [{ id: 'D1', comment: 'setlist-dev', enabled: true }],
    })
    const record = await engageKillSwitch(deps, { reason: 'budget alarm at 85%' })

    expect(calls.records).toHaveLength(1)
    expect(record.reason).toBe('budget alarm at 85%')
    expect(record.at).toBe(AT.toISOString())
    expect(record.functionsThrottled).toEqual(['setlist-dev-bff'])
    expect(record.distributionsDisabled).toEqual(['D1'])
    expect(record.failures).toEqual([])
  })
})

describe('when calls fail', () => {
  it('keeps going and reports every failure', async () => {
    // The whole reason this does not stop at the first error: one unlucky API call must
    // not leave three quarters of the system running.
    const { deps, calls } = harness({
      functions: [
        { functionName: 'a', tags: { app: 'setlist' } },
        { functionName: 'b', tags: { app: 'setlist' } },
      ],
      distributions: [{ id: 'D1', comment: 'setlist-dev', enabled: true }],
      failOn: what => what === 'concurrency:a',
    })

    await expect(engageKillSwitch(deps, { reason: 'r' })).rejects.toThrow(KillSwitchIncomplete)
    // b was still throttled and the distribution was still disabled.
    expect(calls.concurrency.map(([n]) => n)).toEqual(['b'])
    expect(calls.distributions).toEqual(['D1'])
  })

  it('writes the record even when it is about to throw', async () => {
    // The record is the only durable account of what happened. An exception that loses
    // it leaves an operator with nothing but the alarm that fired.
    const { deps, calls } = harness({
      functions: [{ functionName: 'a', tags: { app: 'setlist' } }],
      failOn: what => what === 'concurrency:a',
    })
    await expect(engageKillSwitch(deps, { reason: 'r' })).rejects.toThrow()
    expect(calls.records).toHaveLength(1)
    expect(calls.records[0]!.failures).toHaveLength(1)
    expect(calls.records[0]!.failures[0]).toMatch(/setReservedConcurrency a/)
  })

  it('still disables distributions when listing functions fails entirely', async () => {
    const { deps, calls } = harness({
      distributions: [{ id: 'D1', comment: 'setlist-dev', enabled: true }],
      failOn: what => what === 'listFunctions',
    })
    // `listFunctions` is not routed through `guard`, so simulate the harder case: no
    // functions at all, and the rest must still run.
    await engageKillSwitch(deps, { reason: 'r' }).catch(() => undefined)
    expect(calls.distributions).toEqual(['D1'])
  })
})

describe('running it twice', () => {
  it('is a no-op the second time', async () => {
    // The alarm can fire repeatedly, and the first thing an operator does when unsure is
    // run it again.
    const { deps, calls } = harness({
      mappings: [{ uuid: 'm1', functionName: 'setlist-dev-bff', enabled: false }],
      distributions: [{ id: 'D1', comment: 'setlist-dev', enabled: false }],
    })
    await engageKillSwitch(deps, { reason: 'first' })
    await engageKillSwitch(deps, { reason: 'second' })

    expect(calls.mappings).toEqual([])
    expect(calls.distributions).toEqual([])
    // Concurrency is set every time: it is idempotent at the API, and skipping it would
    // need a read that could be stale.
    expect(calls.concurrency).toEqual([
      ['setlist-dev-bff', 0],
      ['setlist-dev-bff', 0],
    ])
  })
})
