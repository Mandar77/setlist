// MUST FAIL: noImplicitReturns
//
// A new source kind added to the union without a matching case would silently return
// undefined. ADR-002 makes orientation depend on this exact switch.
//
// Expected error: TS2366 / TS7030

export type SourceKind = 'paste' | 'scan_handwriting'

export function artistFirstByDefault(kind: SourceKind): boolean {
  if (kind === 'paste') {
    return true
  }
}
