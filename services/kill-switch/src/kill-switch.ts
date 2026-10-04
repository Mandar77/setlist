/**
 * The kill switch: stop everything that can spend money, as fast as possible.
 *
 * It fires when the budget alarm trips or when the usage sentinel sees a share cross
 * `trip_pct`. By the time it runs, something is already wrong — so the design question is
 * not "how do we do this elegantly" but "what still works when half the calls fail".
 *
 * ## Four things, in this order
 *
 * 1. **Reserved concurrency to zero** on every function tagged `app=setlist`. This is the
 *    one that actually stops spend: a function at zero concurrency is throttled at the
 *    service, so nothing it would have invoked downstream runs either.
 * 2. **Disable event source mappings**, which otherwise keep polling and keep failing.
 * 3. **Disable schedules**, which would otherwise re-invoke a throttled function forever
 *    and turn a stopped system into a retry storm.
 * 4. **Disable the dev and stage distributions** — never prod. Taking production offline
 *    to save money is a decision for a human with the context to make it; dev and stage
 *    have no users and are pure cost.
 *
 * ## It keeps going when a call fails
 *
 * The naive version stops at the first error, which means one unlucky API call leaves the
 * other three quarters of the system running. So every step is attempted, failures are
 * collected, the audit record is written with whatever happened, and only then does it
 * throw. An operator reading the record sees what did and did not stop, which is the
 * question they will actually have.
 *
 * ## It is safe to run twice
 *
 * Setting concurrency to zero twice is the same as once, and so is disabling something
 * already disabled. That matters because the alarm can fire repeatedly, and because the
 * first thing an operator does when unsure is run it again.
 */

/** The subset of Lambda's API this needs, so tests do not need the SDK or credentials. */
export interface LambdaControl {
  /** Every function in the account, with its tags. */
  listFunctions(): Promise<readonly FunctionSummary[]>
  setReservedConcurrency(functionName: string, value: number): Promise<void>
  listEventSourceMappings(): Promise<readonly EventSourceMapping[]>
  disableEventSourceMapping(uuid: string): Promise<void>
}

export interface FunctionSummary {
  readonly functionName: string
  readonly tags: Readonly<Record<string, string>>
}

export interface EventSourceMapping {
  readonly uuid: string
  readonly functionName: string
  readonly enabled: boolean
}

export interface SchedulerControl {
  listSchedules(): Promise<readonly Schedule[]>
  disableSchedule(name: string): Promise<void>
}

export interface Schedule {
  readonly name: string
  readonly enabled: boolean
  /** The function this schedule invokes, when it invokes one. */
  readonly targetFunctionName: string | null
}

export interface CloudFrontControl {
  listDistributions(): Promise<readonly DistributionSummary[]>
  disableDistribution(id: string): Promise<void>
}

export interface DistributionSummary {
  readonly id: string
  /** The `setlist-<env>` comment the platform stack sets. */
  readonly comment: string
  readonly enabled: boolean
}

export interface AuditSink {
  write(record: KillRecord): Promise<void>
}

export interface KillRecord {
  readonly reason: string
  readonly at: string
  readonly functionsThrottled: readonly string[]
  readonly mappingsDisabled: readonly string[]
  readonly schedulesDisabled: readonly string[]
  readonly distributionsDisabled: readonly string[]
  readonly failures: readonly string[]
}

export interface KillSwitchDeps {
  readonly lambda: LambdaControl
  readonly scheduler: SchedulerControl
  readonly cloudfront: CloudFrontControl
  readonly audit: AuditSink
  /** Injected so the record is deterministic in a test. */
  readonly now: () => Date
}

/**
 * Environments whose distribution may be switched off automatically.
 *
 * Positively listed, so an environment nobody considered is left alone rather than taken
 * down. prod is absent deliberately and `kill-switch.test.ts` asserts it stays absent.
 */
export const DISABLEABLE_ENVS: ReadonlySet<string> = new Set(['dev', 'stage'])

/** Functions this project owns. Everything else in the account is somebody else's. */
export function isOurs(fn: FunctionSummary): boolean {
  return fn.tags['app'] === 'setlist'
}

/** `setlist-dev` -> `dev`. Returns null for a comment this project did not write. */
export function envFromComment(comment: string): string | null {
  const match = /^setlist-([a-z]+)$/.exec(comment)
  return match?.[1] ?? null
}

export class KillSwitchIncomplete extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`kill switch finished with ${failures.length} failure(s): ${failures.join('; ')}`)
    this.name = 'KillSwitchIncomplete'
  }
}

/** Run one step, recording a failure instead of propagating it. */
async function attempt(
  failures: string[],
  what: string,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run()
    return true
  } catch (error) {
    failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export async function engageKillSwitch(
  deps: KillSwitchDeps,
  options: { readonly reason: string },
): Promise<KillRecord> {
  const failures: string[] = []
  const functionsThrottled: string[] = []
  const mappingsDisabled: string[] = []
  const schedulesDisabled: string[] = []
  const distributionsDisabled: string[] = []

  // 1. Concurrency to zero. Listing can itself fail, and if it does there is nothing to
  //    iterate — recorded rather than thrown, so the remaining steps still run.
  let ours: readonly FunctionSummary[] = []
  await attempt(failures, 'listFunctions', async () => {
    ours = (await deps.lambda.listFunctions()).filter(isOurs)
  })

  for (const fn of ours) {
    const ok = await attempt(failures, `setReservedConcurrency ${fn.functionName}`, () =>
      deps.lambda.setReservedConcurrency(fn.functionName, 0),
    )
    if (ok) functionsThrottled.push(fn.functionName)
  }

  // 2. Event source mappings, for our functions only.
  const ourNames = new Set(ours.map(fn => fn.functionName))
  let mappings: readonly EventSourceMapping[] = []
  await attempt(failures, 'listEventSourceMappings', async () => {
    mappings = await deps.lambda.listEventSourceMappings()
  })

  for (const mapping of mappings) {
    if (!ourNames.has(mapping.functionName) || !mapping.enabled) continue
    const ok = await attempt(failures, `disableEventSourceMapping ${mapping.uuid}`, () =>
      deps.lambda.disableEventSourceMapping(mapping.uuid),
    )
    if (ok) mappingsDisabled.push(mapping.uuid)
  }

  // 3. Schedules. A schedule left enabled re-invokes a throttled function forever.
  let schedules: readonly Schedule[] = []
  await attempt(failures, 'listSchedules', async () => {
    schedules = await deps.scheduler.listSchedules()
  })

  for (const schedule of schedules) {
    if (schedule.targetFunctionName === null) continue
    if (!ourNames.has(schedule.targetFunctionName) || !schedule.enabled) continue
    const ok = await attempt(failures, `disableSchedule ${schedule.name}`, () =>
      deps.scheduler.disableSchedule(schedule.name),
    )
    if (ok) schedulesDisabled.push(schedule.name)
  }

  // 4. Distributions — dev and stage only.
  let distributions: readonly DistributionSummary[] = []
  await attempt(failures, 'listDistributions', async () => {
    distributions = await deps.cloudfront.listDistributions()
  })

  for (const distribution of distributions) {
    const env = envFromComment(distribution.comment)
    if (env === null || !DISABLEABLE_ENVS.has(env) || !distribution.enabled) continue
    const ok = await attempt(failures, `disableDistribution ${distribution.id}`, () =>
      deps.cloudfront.disableDistribution(distribution.id),
    )
    if (ok) distributionsDisabled.push(distribution.id)
  }

  const record: KillRecord = {
    reason: options.reason,
    at: deps.now().toISOString(),
    functionsThrottled,
    mappingsDisabled,
    schedulesDisabled,
    distributionsDisabled,
    failures,
  }

  // Written before the throw. The record is the only durable account of what happened,
  // and an exception that loses it leaves an operator with nothing but the alarm.
  await deps.audit.write(record)

  if (failures.length > 0) throw new KillSwitchIncomplete(failures)
  return record
}
