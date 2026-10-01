/**
 * Code that must COMPILE under the shared strict settings.
 *
 * Its counterpart lives in `fixtures/`: files that must FAIL. Together they prove the
 * gate discriminates, rather than passing because it never looked.
 */

/** `noUncheckedIndexedAccess` makes this `string | undefined`, and we handle it. */
export function firstLine(lines: readonly string[]): string {
  const head = lines[0]
  return head ?? ''
}

/** `exactOptionalPropertyTypes` means an optional field cannot be set to undefined. */
export interface Hint {
  readonly album?: string
}

export function withAlbum(album: string | undefined): Hint {
  return album === undefined ? {} : { album }
}

/** `noImplicitReturns` and `noFallthroughCasesInSwitch` both apply here. */
export type SourceKind = 'paste' | 'file' | 'scan_handwriting' | 'scan_print' | 'screenshot'

export function artistFirstByDefault(kind: SourceKind): boolean {
  switch (kind) {
    case 'paste':
    case 'file':
      return true
    case 'scan_handwriting':
    case 'scan_print':
    case 'screenshot':
      return false
  }
}
