/**
 * The deterministic song grammar (ADR-001).
 *
 * One implementation, three consumers: the mobile app on Hermes, the PWA in a browser,
 * and the Node Lambdas. Everything exported here is pure — no Node, no DOM, no React
 * Native — which the ESLint purity rule enforces and `tsconfig.json` reinforces by not
 * loading Node's ambient types.
 */

export * from './enums.js'
export * from './normalize.js'
