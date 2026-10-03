/**
 * Enumerations shared across the extraction and matching domains.
 *
 * Ported from `tools/oracle-py/src/setlist_core/enums.py` (ADR-001). Python's `StrEnum`
 * becomes a frozen object plus a union type: the string values are the wire format, and
 * they must stay byte-identical to the oracle's or the differential test fails.
 */

export const Qualifier = {
  LIVE: 'live',
  REMIX: 'remix',
  REMASTER: 'remaster',
  ACOUSTIC: 'acoustic',
  INSTRUMENTAL: 'instrumental',
  RADIO_EDIT: 'radio_edit',
  EXTENDED: 'extended',
  DEMO: 'demo',
  COVER: 'cover',
  KARAOKE: 'karaoke',
} as const
export type Qualifier = (typeof Qualifier)[keyof typeof Qualifier]

/**
 * How an item came to exist.
 *
 * Precedence for confidence and merge conflicts is
 * `DETERMINISTIC > LLM_GROUNDED > LLM_UNGROUNDED` (PRD §7.9.5); ungrounded LLM items
 * are rejected outright and never reach a result.
 */
/**
 * How a document reached the system (ADR-002).
 *
 * Added to the ingestion contract by ADR-002 as the input the orientation ladder falls
 * back to. Deliberately NOT part of the oracle's world — the oracle reads text on stdin
 * and nothing else — which is what lets orientation resolution exist without the port
 * diverging from it. See `orientation.ts`.
 */
export const SourceKind = {
  SCAN_HANDWRITING: 'scan_handwriting',
  SCAN_PRINT: 'scan_print',
  SCREENSHOT: 'screenshot',
  PASTE: 'paste',
  FILE: 'file',
} as const
export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind]

export const ExtractionMethod = {
  DETERMINISTIC: 'deterministic',
  LLM_GROUNDED: 'llm_grounded',
  LLM_UNGROUNDED: 'llm_ungrounded',
  HYBRID: 'hybrid',
} as const
export type ExtractionMethod = (typeof ExtractionMethod)[keyof typeof ExtractionMethod]

export const RejectReason = {
  SPAN_OUT_OF_RANGE: 'span_out_of_range',
  SPAN_TEXT_MISMATCH: 'span_text_mismatch',
  EMPTY_TITLE: 'empty_title',
  TITLE_TOO_LONG: 'title_too_long',
  NOISE_LINE: 'noise_line',
  SCHEMA_INVALID: 'schema_invalid',
} as const
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason]

/** Music platforms Setlist can create playlists on (PRD §4). */
export const Provider = {
  SPOTIFY: 'spotify',
  YOUTUBE: 'youtube',
  APPLE: 'apple',
  AMAZON: 'amazon',
} as const
export type Provider = (typeof Provider)[keyof typeof Provider]

/**
 * Qualifiers in a stable order.
 *
 * The oracle stores them in a `frozenset` and sorts on the way out. Sets in JavaScript
 * preserve insertion order, which is a different thing that happens to look the same
 * until two code paths insert in different orders — so anything that serializes
 * qualifiers sorts them, and this is the comparator.
 */
export function sortQualifiers(values: Iterable<Qualifier>): Qualifier[] {
  return [...new Set(values)].sort()
}
