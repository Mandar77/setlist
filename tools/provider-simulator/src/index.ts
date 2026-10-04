/**
 * An offline YouTube Data API v3 stand-in (M3-05).
 *
 * CLAUDE.md forbids calling a real provider API from a unit test, and the reason is
 * arithmetic rather than principle: a real call draws from the same 10,000-unit daily
 * allowance production uses, so a suite that ran twice would spend a day's budget on
 * tests. This reproduces the parts that change behaviour — the two quota buckets, the
 * real unit costs, and the failures the adapter must branch on — and nothing else.
 */

export * from './errors.js'
export * from './fixtures.js'
export * from './quota.js'
export * from './simulator.js'
