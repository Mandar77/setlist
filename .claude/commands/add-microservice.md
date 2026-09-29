---
description: Scaffold a new Lambda microservice under services/, zero-cost profile compliant
argument-hint: <service-name>
---

Scaffold `services/$1/` following the conventions of an existing service.

**TypeScript on Node, arm64, esbuild zip** — that is the default and almost certainly
what you want ([ADR-004](../../docs/adr/0004-language-map.md)). Python is permitted
only for `services/ocr` and `packages/etl`; if you believe a new service needs Python,
that is an ADR, not a scaffolding choice.

- `src/` — Powertools (TypeScript) handler: `@idempotent` on `event.id`, structured
  JSON logs, correlation ID propagated, EMF metrics.
- `tests/` — Vitest with `aws-sdk-client-mock`. No real AWS, no real provider calls.
- `infra/` — a CDK stack named `setlist-{env}-$1`, built through
  `ProfileAwareFactory` so the same code synthesizes under both `zero` and `enterprise`.
- `openapi.yaml` — only if the service is reachable synchronously.

Non-negotiable:
- Nothing on the never-use list in `infra/free-tier/budget.yaml`.
- A DynamoDB key prefix for this service, enforced by an IAM `LeadingKeys` condition.
- Explicit log retention; reserved concurrency set.
- Its WCU/RCU share added to `budget.yaml`, keeping the provisioned total at or under 17.
- A path-filtered workflow entry reusing `_service.yml`.
- No new billed-per-call AWS API. If you add any AWS API call, cite its pricing page
  in the commit.

Then run `make preflight ENV=dev`, report the free-tier estimate delta, and run the
`cost-auditor` subagent on the diff.
