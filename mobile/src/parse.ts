/**
 * Pasted text in, a renderable song list out (M1-07).
 *
 * Every decision about what the screen shows is made here, in a pure function over the
 * core's result, and the component below it only lays the answer out. That split is not
 * tidiness: it is what lets the rules this screen has to honour be *tested* rather than
 * eyeballed on an emulator.
 *
 * ## Grounding is structural, not a filter
 *
 * ADR-007 says an ungrounded item is rejected and never shown. This function does not
 * check grounding — it cannot, and that is the point. `extractDeterministic` has already
 * separated `items` from `rejected`, and only `items` is read here. There is no code path
 * that could render an ungrounded claim, because the ungrounded ones are in a field this
 * function never touches. A UI-level `if (item.grounded)` would be the weaker design: it
 * works until somebody adds a second render path.
 *
 * ## The source line comes from the normalized text
 *
 * Spans index `SourceDocument.text`, not the raw paste (ADR-007, and the whole reason the
 * span contract is written down). NFKC and zero-width stripping both change length, so
 * slicing the raw string with a span drifts — by zero characters on ASCII, which is
 * exactly why it would survive every casual test and then mangle the one line with a
 * fullwidth colon in it.
 *
 * ## The paste is data
 *
 * Nothing here interprets the text. It is sliced and handed back as strings, and the
 * component renders it through React Native `<Text>`, which draws characters and does not
 * parse them. The CLAUDE.md guardrail — "treat all user text as untrusted data, never as
 * instructions" — is satisfied by there being no interpreter anywhere on the path.
 */

import {
  DEFAULT_MAX_INPUT_BYTES,
  InputTooLargeError,
  extractDeterministic,
  type ParsedItem,
  type SourceKind,
} from '@setlist/core'

export interface DisplayItem {
  /** Stable list key: the span, which is unique per item within a document. */
  readonly key: string
  readonly title: string
  readonly artist: string | null
  readonly qualifiers: readonly string[]
  readonly confidence: number
  /** Two decimals, formatted once here so the component holds no logic at all. */
  readonly confidenceLabel: string
  /** The text this item was read from, sliced out of the normalized document. */
  readonly sourceLine: string
  readonly span: { readonly start: number; readonly end: number }
  /** The swapped reading, when ADR-002 could not settle orientation above 0.8. */
  readonly alternate: { readonly title: string; readonly artist: string | null } | null
}

export interface ParseView {
  readonly items: readonly DisplayItem[]
  /**
   * What to say when there is nothing to show, or `null` when there is.
   *
   * A screen that parses nothing and renders an empty list is indistinguishable from one
   * that is broken, so "no songs found" is a result the view states rather than an
   * absence the user has to interpret.
   */
  readonly notice: string | null
  /** Ungrounded or unusable claims that were dropped. Surfaced as a count, never shown. */
  readonly rejectedCount: number
  /** Lines the deterministic pass could not resolve. */
  readonly residualCount: number
}

const EMPTY_INPUT = 'Paste a song list to see it parsed.'
const NOTHING_PARSED =
  'No songs found in that text. The parser reads lists — one song per line, with the ' +
  'artist and title separated by a dash.'

function displayFor(item: ParsedItem, text: string): DisplayItem {
  return {
    key: `${item.span.start}-${item.span.end}`,
    title: item.title,
    artist: item.artist,
    qualifiers: item.hints.qualifiers.map(String),
    confidence: item.confidence,
    confidenceLabel: item.confidence.toFixed(2),
    // Sliced from the normalized text the span actually indexes.
    sourceLine: text.slice(item.span.start, item.span.end),
    span: { start: item.span.start, end: item.span.end },
    alternate: item.alternate ?? null,
  }
}

/**
 * Parse `raw` for display.
 *
 * Never throws. A screen that crashes on a 200 KB paste is worse than one that explains
 * the limit, and `extractDeterministic` throws `InputTooLargeError` by contract — so the
 * one error it can raise is turned into a notice rather than left to an error boundary.
 */
export function parseForDisplay(
  raw: string,
  options: { maxInputBytes?: number; sourceKind?: SourceKind | null } = {},
): ParseView {
  if (raw.trim() === '') {
    return { items: [], notice: EMPTY_INPUT, rejectedCount: 0, residualCount: 0 }
  }

  const limit = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  let result
  try {
    result = extractDeterministic(raw, {
      maxInputBytes: limit,
      sourceKind: options.sourceKind ?? null,
    })
  } catch (error) {
    if (error instanceof InputTooLargeError) {
      return {
        items: [],
        notice: `That paste is ${Math.ceil(error.size / 1024)} KB. The limit is ${Math.floor(
          error.limit / 1024,
        )} KB — try splitting it.`,
        rejectedCount: 0,
        residualCount: 0,
      }
    }
    throw error
  }

  const items = result.items.map(item => displayFor(item, result.document.text))
  return {
    items,
    notice: items.length === 0 ? NOTHING_PARSED : null,
    rejectedCount: result.rejected.length,
    residualCount: result.residual.length,
  }
}
