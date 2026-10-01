// MUST FAIL: noUncheckedIndexedAccess
//
// Without that flag `lines[0]` is typed `string`, this compiles, and the function
// returns undefined at runtime. The parser indexes arrays of lines and tokens
// constantly, so this is the most load-bearing of the strict settings.
//
// Expected error: TS2322 (string | undefined is not assignable to string)

export function firstLine(lines: readonly string[]): string {
  return lines[0]
}
