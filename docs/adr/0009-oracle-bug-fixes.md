# ADR-009 — The frozen oracle may take bug fixes, never features

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decided by:** the human
- **Amends:** [ADR-001](0001-parser-home-typescript-core.md) §"Migration, not rewrite" step 1
- **Context:** CORE-04's discovery that `normalize_document` is not idempotent

## Context

[ADR-001](0001-parser-home-typescript-core.md) freezes the Python core as
`tools/oracle-py` and says it "receives no new features". While porting, that sentence
got read more strictly than it says — `STATE.md` recorded it as "it takes no bug fixes: a
wrong answer in there is behaviour to reproduce, not a defect" — and the stricter reading
is what the port was built under. That reading was right for its purpose. The whole value
of the differential is that the port reproduces the oracle including the parts that look
wrong, and three "obvious fixes" during CORE-04 turned out to be real porting bugs: a
`\p{Lu}` lookahead that broke a Greek tracklist, an uncompensated float sum, and a
pydantic whitespace strip.

But a frozen target and a correct target are different goals, and the strict reading has
no way to tell a porting bug from a genuine defect in the thing being ported. CORE-04
found one of the latter. `normalize_document` applies NFKC and then strips control
characters, so the strip can make two combining marks adjacent that NFKC never got to
compare, and a second pass reorders them by canonical combining class. Hypothesis found
the witness U+00B4, U+001F, U+1A7F. Both implementations do it identically, so the port
is faithful and the differential is sound — the bug is in the behaviour both now share.

It is latent today: one call site in each language, so nothing normalizes twice. It bites
on a round trip, where re-ingesting already-normalized text shifts every span after the
affected position — the exact failure [ADR-007](0007-deterministic-core-and-span-grounding.md)'s
span contract exists to prevent.

Under the strict reading the only available move was to escalate and wait. That is the
wrong default for a defect whose fix was already measured to change nothing.

## Decision

The frozen oracle may take **bug fixes**. It still takes **no features**.

A change qualifies as a bug fix only when all of the following hold:

1. **It lands in both implementations in one change.** The Python oracle and the
   TypeScript core move together, in a single commit. The oracle's purpose is to be a
   differential target; a fix that reaches one side and not the other destroys that
   purpose for as long as the two are apart, however briefly.
2. **The full corpus shows zero changed outputs** — every case in `golden/oracle/`,
   every record in `golden/diff/normalize.jsonl`, and every digest in
   `golden/diff/pipeline.jsonl` — **or** every changed output is listed in
   `golden/diff-allowlist.yaml` with a reason, and the reason says why the new answer is
   correct rather than merely different.
3. **It fixes a stated or implied contract**, not a preference. "This looks wrong to me"
   is not a bug; "this violates the span contract" is.

Condition 2 is the one that does the work. A fix that moves no output is a fix that
cannot have lost hard-won behaviour, which is the risk the freeze was protecting against.
A fix that does move outputs is not forbidden, but it has to argue for each one in the
same file that already exists for arguing about differences — and
`tools/check_diff_allowlist.js` currently permits only ADR-002 orientation entries, so
widening it is itself a change someone reviews.

Features remain forbidden with no exception. A new qualifier pattern, a new separator, a
widened lookahead: those are CORE-05 and later work on the TypeScript side only, after
the oracle retires at CORE-07.

### First task under this ADR

Fix `normalize_document`'s idempotence in both implementations. Add the shrunk
counterexample Hypothesis found as a permanent **explicit example** in both property
suites, so the witness is checked on every run rather than rediscovered by chance. Keep
the idempotence property itself — the explicit example pins the known case, the property
keeps looking for the next one.

## Consequences

- The port's parity claim is unaffected: both sides move together, and condition 2 means
  the differential's answers do not change.
- `STATE.md`'s stricter gloss is superseded. The ledger and `STATE.md` are amended in the
  same change as this ADR.
- The oracle stays a stable target in the only sense that matters — its *answers* are
  stable — while stopping short of preserving its defects as though they were decisions.
- Risk accepted: a fix could be wrong in a way the corpus does not cover. Condition 1
  bounds the damage, because the differential still has to pass, and anything the corpus
  misses was equally missed by the freeze.
- This does not reopen the three CORE-04 findings. The ASCII sentence lookahead, the
  float summation and the pydantic strip are reproduced deliberately and stay reproduced;
  they are behaviour the port must match, not contract violations.
