/**
 * Event contracts: the envelope, the versioned schemas, the SNS attributes and the
 * producer golden samples.
 *
 * ADR-004 makes these zod-first. The JSON Schema the Python consumers read is GENERATED
 * from the zod schemas (`pnpm -C packages/contracts schema`) and committed, because a
 * hand-maintained Python mirror of a zod schema is the same drift problem versioning
 * exists to prevent — and a generated file that nobody checks is the same problem again,
 * so a test asserts the committed output is current.
 */

export * from './envelope.js'
export * from './events.js'
export * from './samples.js'
export * from './sns.js'
