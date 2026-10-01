// MUST FAIL: exactOptionalPropertyTypes
//
// Without it, `{ album: undefined }` satisfies `{ album?: string }`, which quietly
// conflates "absent" with "present but unknown". Hints distinguish those two cases.
//
// Expected error: TS2375 / TS2412

export interface Hint {
  readonly album?: string
}

export function build(album: string | undefined): Hint {
  return { album }
}
