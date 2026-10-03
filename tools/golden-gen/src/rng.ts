/**
 * A seeded PRNG, because "deterministic for a fixed seed" is a CORE-03 requirement and
 * `Math.random` cannot be one.
 *
 * mulberry32: 32 bits of state, four operations, no dependencies. The quality bar here
 * is low on purpose — this picks which separator to put between an artist and a title,
 * not cryptographic material — but the *reproducibility* bar is absolute. The generated
 * corpus is committed, and a generator that produced a different file on each run would
 * make every diff unreadable and the staleness check meaningless.
 *
 * Deliberately not seeded from the clock, the process, or the filesystem order.
 */

export class Rng {
  #state: number

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new TypeError(`seed must be an integer, got ${seed}`)
    // `>>> 0` so a negative seed still produces a usable 32-bit state rather than NaN.
    this.#state = seed >>> 0
  }

  /** A float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`empty range [${min}, ${max}]`)
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** One element, chosen uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('cannot pick from an empty list')
    return items[this.int(0, items.length - 1)]!
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p
  }

  /** A copy of `items` in a shuffled order, leaving the original alone. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i)
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }

  /** `count` distinct elements, or all of them when there are not enough. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length))
  }
}
