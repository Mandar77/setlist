# Autopilot state

Milestone: M0 | Last done: PREP-03 | Next: M0A-01 | Blocked: 30 tasks, M0B-* + M1-02/03 on H1

Metrics: coverage 95% (oracle-py, Python) | text precision/recall 1.00 on 8 hand-written cases | free-tier max — (estimator not built) | quarantined tests 0

Notes:
- PREP-01/02/03 done. Specs landed in `docs/` with 32 amendments inline; Windows
  hardening (PYTHONUTF8, LF, no-heredoc rule); real 2MS full-history gate, fail-closed
  and checksum-pinned.
- `make verify` now runs: lint, types, unit, accuracy, ledger, links, eol, suppressions,
  guard, no-secrets. CI mirrors it.
- Nothing pushed yet — no remote branches. Work fast-forwards `develop` locally until
  Session 1, then everything pushes at once (AUTOPILOT §2.1 step 8).
- Open for the human: git author identity before the first push (`docs/hitl/QUEUE.md`).
