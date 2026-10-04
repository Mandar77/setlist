/**
 * The weekly re-match workflow (M6-02).
 *
 * Standard, never Express. Express bills per request and per GB-second with no free tier
 * at all; Standard gives 4,000 state transitions a month, of which prod's share is 2,000
 * (`budget.yaml`). That allowance is the entire design constraint here — it is not a
 * performance budget, it is the difference between $0 and a bill.
 *
 * ## Why the transition count is computed rather than measured
 *
 * A state machine's cost is its transitions, and transitions are a property of the
 * definition plus the input size. That makes the cost knowable before anything is
 * deployed, which is the only useful time to know it: `transitionsPerRun` is what the
 * usage model multiplies, and `state-machine.test.ts` holds it to the prod share. A
 * design that could only be costed by running it would be one nobody could approve.
 *
 * ## Why batches, not items
 *
 * Mapping over individual items would make the transition count scale with the catalog,
 * so a growing user base would silently walk into the limit. Batching makes the count
 * scale with ceil(items / BATCH_SIZE) and puts a ceiling in reach: the Map's
 * `MaxConcurrency` bounds width, and `BATCH_SIZE` bounds depth.
 */

/** Items re-matched per Map iteration. */
export const BATCH_SIZE = 200

/** Transitions consumed by the states outside the Map, once per run. */
const FIXED_STATES = 4

/** Transitions consumed per Map iteration. */
const STATES_PER_BATCH = 3

/**
 * Transitions one run costs.
 *
 * Standard charges a transition per state entered, and the Map's iterations are counted
 * individually — which is the detail that makes a per-item Map expensive and a per-batch
 * Map affordable.
 */
export function transitionsPerRun(itemCount: number, batchSize = BATCH_SIZE): number {
  if (itemCount < 0) throw new RangeError(`itemCount must be non-negative, got ${itemCount}`)
  const batches = Math.ceil(itemCount / batchSize)
  return FIXED_STATES + batches * STATES_PER_BATCH
}

/** The largest catalog one run can re-match inside a monthly transition budget. */
export function maxItemsWithin(
  monthlyTransitions: number,
  runsPerMonth: number,
  batchSize = BATCH_SIZE,
): number {
  const perRun = Math.floor(monthlyTransitions / runsPerMonth)
  const batches = Math.floor((perRun - FIXED_STATES) / STATES_PER_BATCH)
  return Math.max(0, batches * batchSize)
}

export interface StateMachineDefinition {
  readonly Comment: string
  readonly StartAt: string
  readonly States: Record<string, Record<string, unknown>>
}

/**
 * The Amazon States Language definition.
 *
 * Written out rather than built with CDK's fluent API so the transition accounting above
 * can be checked against the states that actually exist — a count derived from a
 * constant nobody compares to the definition is a count that drifts.
 */
export function weeklyRematchDefinition(): StateMachineDefinition {
  return {
    Comment: 'Weekly re-match of stored items against the free catalogs. Standard workflow.',
    StartAt: 'LoadDueItems',
    States: {
      LoadDueItems: {
        Type: 'Task',
        Comment: 'Read the items whose match is older than the re-match interval.',
        Next: 'AnyWork',
      },
      AnyWork: {
        Type: 'Choice',
        Choices: [{ Variable: '$.batchCount', NumericGreaterThan: 0, Next: 'RematchBatches' }],
        Default: 'Done',
      },
      RematchBatches: {
        Type: 'Map',
        // Bounded width. An unbounded Map would run every batch at once and hit the
        // MusicBrainz rate limit from many Lambdas simultaneously, which the token
        // bucket cannot help with because it is per-process.
        MaxConcurrency: 2,
        ItemsPath: '$.batches',
        Iterator: {
          StartAt: 'MatchBatch',
          States: {
            MatchBatch: { Type: 'Task', Next: 'WriteBatch' },
            WriteBatch: { Type: 'Task', Next: 'BatchDone' },
            BatchDone: { Type: 'Succeed' },
          },
        },
        Next: 'Done',
      },
      Done: { Type: 'Succeed' },
    },
  }
}

/** `StateMachineType` for the CDK resource. Never `EXPRESS` — see SZC-SFN-EXPRESS. */
export const STATE_MACHINE_TYPE = 'STANDARD' as const
