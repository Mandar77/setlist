// MUST FAIL: @typescript-eslint/no-explicit-any (lint, not typecheck)
//
// `any` on a parsed item would disable every guarantee the strict settings buy.
//
// Expected: ESLint error, not a tsc error.

export function parse(input: any): string {
  return String(input)
}
