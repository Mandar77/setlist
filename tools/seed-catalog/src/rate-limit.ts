/**
 * One request per second, measured between starts, with the clock injected.
 *
 * MusicBrainz asks for at most one request per second per IP and will throttle or block
 * an IP that ignores it (PRD §7.10.1). That is not a performance setting to tune — it is
 * someone else's free, donation-funded infrastructure, and the polite version is the
 * only correct one.
 *
 * The clock is a parameter rather than `Date.now` because the only useful test of a rate
 * limiter is one that asserts a thousand requests were spaced properly, and a test that
 * actually waits a thousand seconds is a test nobody runs. With a fake clock the same
 * assertion takes a millisecond and can be made exact rather than approximate.
 *
 * Spacing is measured start-to-start, not end-to-start. If a request takes 400ms the
 * next may begin 600ms later; a limiter that waited a full second *after* each response
 * would be slower than asked and still correct, but it would also be lying about what it
 * enforces, and the difference matters the moment a response is slow.
 */

/** Everything this limiter needs from the outside world. */
export interface Clock {
  /** Milliseconds since some fixed origin; monotonic is fine, wall clock is fine. */
  now(): number
  /** Resolve after at least `ms` milliseconds. */
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export class RateLimiter {
  readonly #minIntervalMs: number
  readonly #clock: Clock
  #lastStart: number | undefined
  /**
   * Serializes callers. Without it, two concurrent `acquire()` calls would both read the
   * same `#lastStart`, both compute the same wait, and both start at the same instant —
   * a limiter that permits exactly the burst it exists to prevent.
   */
  #tail: Promise<void> = Promise.resolve()

  constructor(minIntervalMs: number, clock: Clock = systemClock) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError(
        `minIntervalMs must be a non-negative finite number, got ${minIntervalMs}`,
      )
    }
    this.#minIntervalMs = minIntervalMs
    this.#clock = clock
  }

  /**
   * Resolve when it is this caller's turn, with the clock time the turn was granted.
   *
   * The return value is not decoration. A caller reading the clock itself after `await`
   * does not learn when its slot opened — it learns when its continuation happened to be
   * scheduled, which is strictly later and, under a test clock that other callers are
   * advancing, can be much later. The grant time is only knowable inside the queue, so
   * the queue reports it.
   */
  async acquire(): Promise<number> {
    const mine = this.#tail.then(() => this.#waitForTurn())
    // Swallow on the chain only: the caller still sees a rejection through `mine`, but a
    // failure must not poison the queue for everyone behind it.
    this.#tail = mine.then(
      () => undefined,
      () => undefined,
    )
    return mine
  }

  async #waitForTurn(): Promise<number> {
    const last = this.#lastStart
    if (last !== undefined) {
      const elapsed = this.#clock.now() - last
      if (elapsed < this.#minIntervalMs) {
        await this.#clock.sleep(this.#minIntervalMs - elapsed)
      }
    }
    // Read the clock again rather than computing the expected time: if `sleep` overshot,
    // which real timers do, the next interval should be measured from when this request
    // actually started.
    this.#lastStart = this.#clock.now()
    return this.#lastStart
  }
}
