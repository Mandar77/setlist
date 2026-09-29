---
description: Add or version a domain event contract
argument-hint: <domain>.<EventName>
---

Add `setlist.$1.vN` to `packages/contracts`:

- JSON Schema plus generated TypeScript and Pydantic types.
- A golden sample from the producer, verified by every consumer in CI.
- SNS message attributes for filtering — never payload-based filtering, which is billed.
- Envelope fields: `id`, `type`, `correlationid`, `idempotencykey`, `env`, `data`; ≤64 KB.

A breaking change creates `vN+1` and is dual-published for one release. Never mutate a
published schema in place. Message bodies carry identifiers only — never song names or
any other personal data.
