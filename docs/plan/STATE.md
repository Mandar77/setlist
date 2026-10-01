# Autopilot state

Milestone: M0 | Last done: M0A-01 | Next: M0A-02 | Blocked: 30 tasks, M0B-\* + M1-02/03 on H1

Metrics: coverage 95% (Python core) | text precision/recall 1.00 on 8 hand-written cases | free-tier max — (estimator not built) | quarantined tests 0 | `make verify` 42s

Notes:

- PREP-01/02/03 and M0A-01 done. Specs landed with 32 amendments inline; Windows
  hardening; a real 2MS gate; and a pnpm/TypeScript toolchain beside the Python one.
- `make verify` now spans both languages and CI runs that exact target, so local and CI
  cannot drift. `tools/toolchain-smoke` proves the strict settings actually reject bad
  code — it caught itself passing vacuously on Windows before it caught anything else.
- **Blocking the first push:** the git author identity. `scan-secrets.sh` refuses until
  it is declared in `security/published-identities.txt` or rewritten to a noreply
  address. See `docs/hitl/QUEUE.md` and SESSION-1 step 1b.
- Nothing pushed — no remote branches. Work fast-forwards `develop` locally until
  Session 1, then everything pushes at once (AUTOPILOT §2.1 step 8).
