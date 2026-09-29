# ADR-003 — Build order: M0 first, split so nothing waits on a human

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1

## Context

PED §16 sequences M0 through M8, but M0 as written mixes work that needs an AWS
account with work that does not. Treated as one block, the whole programme stalls
until the human finishes Session 1 — and Session 1 cannot happen until the bootstrap
CloudFormation template it uploads has been written, which is itself M0 work.

## Decision

Split M0 along the credential boundary, and put the TypeScript port between the halves.

| Stage | Needs AWS? | Contents |
| --- | --- | --- |
| **M0a** | No | Nag pack, KICS zero-cost queries, free-tier estimator, `make preflight`, CI workflows, the account-bootstrap template, kill-switch and sentinel code, canary fixtures |
| **CORE** | No | The [ADR-001](0001-parser-home-typescript-core.md) TypeScript port and [ADR-006](0006-test-data.md) test data |
| **M0b** | Yes, after H1 | Bootstrap verification, `cdk bootstrap`, dev/stage deploys, kill-switch drill, canary PR, the M0 gate |

M1–M8 then follow PED §16.

The ledger always selects the first unblocked task, so a task waiting on a human
session never halts the rest of the work — which is the actual point of the split.

## Consequences

- Everything that can be built and proven offline is built and proven offline,
  including the policy gate that protects the $0 guarantee. **The gate exists before
  the account it protects**, which is the only ordering that makes the guarantee real.
- Session 1 can be done at any time without blocking progress, and the moment it is
  done M0b unblocks in one step.
- `make preflight` must therefore run fully offline: synth, nag and estimator are all
  local. Only KICS needs Docker, and `make verify` must work without it.
