# Autopilot state

Milestone: M0 | Last done: M0A-03 | Next: M0A-04 | Blocked: 30 tasks, M0B-\* + M1-02/03 on H1

Metrics: coverage 95% (Python core) | text precision/recall 1.00 on 8 hand-written cases | free-tier max — (estimator not built) | quarantined tests 0 | `make verify` 41s

Notes:

- PREP-01/02/03 and M0A-01/02/03 done. Specs landed with 32 amendments inline; Windows
  hardening; a real 2MS gate; a pnpm/TypeScript toolchain beside the Python one; the
  CDK app with its profile factory; and now the SetlistZeroCostPack.
- `make verify` now spans both languages and CI runs that exact target, so local and CI
  cannot drift. `tools/toolchain-smoke` proves the strict settings actually reject bad
  code — it caught itself passing vacuously on Windows before it caught anything else.
- The zero-cost pack is **on by default under `profile=zero`**, not opt-in behind
  `-c nag=true`. `make nag` checks both directions: the real stacks must pass it, and
  `tests/fixtures/nat-stack` must be rejected with SZC-NAT. A pack that is never
  attached produces a clean synth too, so the first check alone proves nothing.
- Worth remembering from M0A-03: `app.synth()` does **not** throw on an error
  annotation — it writes `aws:cdk:error` metadata and exits 0. The CDK **CLI** is what
  fails the build. Anything that checks the gate must go through the CLI.
- **Blocking the first push:** the git author identity. `scan-secrets.sh` refuses until
  it is declared in `security/published-identities.txt` or rewritten to a noreply
  address. See `docs/hitl/QUEUE.md` and SESSION-1 step 1b.
- Nothing pushed — no remote branches. Work fast-forwards `develop` locally until
  Session 1, then everything pushes at once (AUTOPILOT §2.1 step 8).
