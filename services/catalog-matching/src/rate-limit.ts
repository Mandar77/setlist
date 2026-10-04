/**
 * A token bucket that MusicBrainz will accept (PRD §7.10.6).
 *
 * "≤1 request/sec per IP; a descriptive User-Agent (with contact) is mandatory or
 * requests are throttled/blocked." Both halves are enforced here, and both are a
 * condition of being allowed to use a volunteer-run service at all — exceeding the rate
 * does not return 429 so much as get the IP blocked, which is not a failure a retry
 * fixes.
 *
 * ## Why this serializes rather than counts
 *
 * The obvious token bucket keeps a counter and refills it on a timer. Under concurrency
 * that has a race: two callers both read a count of 1, both decrement, and two requests
 * leave in the same second. The window where it happens is small, which is worse than if
 * it were large — it passes every test that does not deliberately look for it, and then
 * blocks the IP in production.
 *
 * So acquisition is serialized through a promise chain. Each caller awaits the previous
 * caller's scheduled departure time, then claims the next slot. There is exactly one
 * `nextSlot` variable and it is only ever advanced, so no two callers can be given the
 * same instant however many of them arrive at once.
 */

/** MusicBrainz's published limit. Not configurable upward. */
export const MUSICBRAINZ_MIN_INTERVAL_MS = 1000

/**
 * The User-Agent MusicBrainz requires: application, version, and a contact.
 *
 * A generic agent is throttled or blocked, and the contact is what lets them tell us to
 * stop rather than blocking silently. The repository URL is the contact — it is public
 * and it is not a personal email, which ADR-005 forbids committing.
 */
export const USER_AGENT = 'setlist/0.1 (https://github.com/Mandar77/setlist)'

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export class TokenBucket {
  /** The earliest instant the next request may depart. */
  private nextSlot = 0
  /** The tail of the queue: every acquirer awaits the one before it. */
  private chain: Promise<void> = Promise.resolve()
  private granted = 0

  constructor(
    private readonly intervalMs: number = MUSICBRAINZ_MIN_INTERVAL_MS,
    private readonly clock: Clock = systemClock,
  ) {}

  /** How many departures have been granted. */
  get count(): number {
    return this.granted
  }

  /**
   * Wait until it is this caller's turn, then return the instant it departed.
   *
   * Callers are served in arrival order. The returned timestamp is the SCHEDULED slot,
   * not `now()` after waking — a test asserting the interval wants the schedule, and the
   * wakeup can be late without the request having been early.
   */
  async acquire(): Promise<number> {
    // Claim a slot synchronously, before any await. This is the whole concurrency
    // argument: slot assignment cannot interleave because nothing suspends between
    // reading `nextSlot` and writing it.
    const now = this.clock.now()
    const slot = Math.max(now, this.nextSlot)
    this.nextSlot = slot + this.intervalMs
    this.granted += 1

    const previous = this.chain
    this.chain = previous.then(async () => {
      const wait = slot - this.clock.now()
      if (wait > 0) await this.clock.sleep(wait)
    })
    await this.chain
    return slot
  }
}

/** A clock a test drives by hand, so rate-limit tests do not take real seconds. */
export class FakeClock implements Clock {
  private current = 0
  private readonly sleepers: { at: number; resolve: () => void }[] = []

  now(): number {
    return this.current
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.sleepers.push({ at: this.current + ms, resolve })
    })
  }

  /** Move time forward, waking everything due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    // Loop rather than wake once: a woken sleeper may schedule another sleep inside the
    // window we are advancing through, and it has to wake too.
    for (;;) {
      const due = this.sleepers.filter(s => s.at <= target).sort((a, b) => a.at - b.at)
      if (due.length === 0) break
      const next = due[0]!
      this.current = Math.max(this.current, next.at)
      this.sleepers.splice(this.sleepers.indexOf(next), 1)
      next.resolve()
      // Let the woken continuation run before deciding what is due next.
      await Promise.resolve()
      await Promise.resolve()
    }
    this.current = target
  }
}
