# ADR-010 — The mutation floor is a ratchet, not a cliff

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decided by:** the human
- **Amends:** `CLAUDE.md` "Quality floors" for `packages/core` only
- **Context:** CORE-04 reaching 55.41% against a 70% floor

## Context

`CLAUDE.md` sets Stryker at ≥70% for `packages/core`. CORE-04 introduced mutation
testing on the TypeScript side for the first time and reached **55.41%**, moving
42.51 → 47.32 → 53.91 → 55.41 as table-driven tests landed. The remaining 809 survivors
are roughly three groups: conditionals inside the csv reader's character loop, which are
reachable and would die to more tests; regex-source mutations, most of which are
equivalent because the mutated pattern matches the same language; and `StringLiteral`
mutations of `throw` messages, killable only by asserting exact error text.

That left the project with two bad options and no good one. Lowering the floor is a
quality-gate relaxation, which `CLAUDE.md` makes a `human-needed` issue with an ADR.
Leaving `break: 70` makes `make mutate-ts` fail and the nightly workflow red —
indefinitely, since the gap is real work. A permanently red gate is not a gate; it is a
notification people learn to ignore, and it hides the next regression inside noise that
was already there.

The floor was also doing nothing to protect what it was for. A fixed break threshold at
70 against a score of 55 cannot detect a drop from 55 to 45. It fails identically either
way.

## Decision

**70% stays the target for `packages/core`.** It is not lowered and it is not deleted.

What changes is how it is enforced while the gap is being closed:

1. **Stryker's `break` threshold is set to today's measured score**, and from then on
   **only ever raised**. It is a ratchet: every change must score at least what the last
   one did. Lowering it is a quality-gate relaxation and stays a `human-needed` issue
   with an ADR, exactly as `CLAUDE.md` says.
2. **CORE-04 closes on its other `done_when` items.** The port reproduces the oracle,
   the allowlist is empty and enforced, the regressions are ported, coverage clears 90%.
   Those are done, and holding the task open on a number that is now tracked elsewhere
   just makes the ledger lie about where the work is.
3. **CORE-04b, "`packages/core` mutation score ≥70%", is a new task and a dependency of
   CORE-07.** The oracle cannot retire until the TypeScript suite proves it catches
   regressions on its own. That is the real reason the number matters: today the
   differential against the oracle is doing much of the work the unit tests get credit
   for, and CORE-07 removes it. `stryker.units.config.json` — mutants against the
   hand-written suites only, no differentials — is the sharper measure of that, and
   becomes the real number at CORE-07.
4. **Survivors are killed with tests.** A mutant may be disabled as equivalent only with
   a written reason, in the config next to the exclusion, that the reviewer agrees is
   behaviour-equivalent. "Equivalent" means the mutated program cannot be distinguished
   by any input, not that no current test distinguishes it — those are different claims
   and only the first justifies an exclusion.

The ratchet applies to `packages/core`. Floors elsewhere (Stryker ≥65%, mutmut ≥70%) are
unchanged.

## Consequences

- The nightly workflow goes green and stays meaningful: a regression below the current
  score fails immediately, which the fixed 70 could not do.
- The ratchet has a deadline attached rather than being open-ended — CORE-04b blocks
  CORE-07, so the gap cannot be carried indefinitely without blocking the milestone that
  retires the oracle.
- CORE-04 is reported as done with its mutation number recorded, not hidden. The ledger
  entry keeps the 55.41% and the survivor analysis.
- Risk accepted: a ratchet can stall just above its current value, each change adding
  one test. CORE-04b being a hard dependency of CORE-07 is what bounds that.
- This is the general pattern for thresholds that cannot be met yet, and
  `AUTOPILOT.md` §2.3 is amended to say so: a floor that is out of reach becomes a
  ratchet plus a deadline task, not a blocker and not an escalation.
