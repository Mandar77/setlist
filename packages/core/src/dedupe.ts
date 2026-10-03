/**
 * Deduplication of repeated songs (FR-004).
 *
 * Two passes, in this order:
 *
 * 1. **Exact key collapse.** Items sharing a dedup key — folded title, folded artist, and
 *    qualifier set — are one song. Qualifiers are part of the key so a studio cut and its
 *    live version stay separate.
 * 2. **Artist absorption.** A title that appeared once without an artist and once with
 *    one is the same song mentioned twice; the artistless mention is folded into the
 *    attributed one. This only fires when exactly one attributed item shares the title,
 *    so an ambiguous "Home" is never guessed at.
 */

import { itemKey, mergeHints, type ParsedItem, type Span } from './models.js'
import { fold } from './normalize.js'

/**
 * Collapse duplicate songs, preserving first-appearance order.
 *
 * The surviving item is the highest-confidence occurrence; every other occurrence
 * contributes its hints and is recorded in `duplicates` so the UI can show "appeared 3
 * times" and the review flow can cite each mention.
 */
export function dedupe(items: readonly ParsedItem[]): ParsedItem[] {
  return absorbArtistless(collapseExact(items))
}

/** Group by dedup key and merge each group into its best occurrence. */
function collapseExact(items: readonly ParsedItem[]): ParsedItem[] {
  // A Map, because JavaScript objects reorder integer-like keys and a dedup key can be
  // "1979|||" — which would silently change output order. Insertion order is the
  // first-appearance order the docstring promises.
  const groups = new Map<string, ParsedItem[]>()
  for (const item of items) {
    const key = itemKey(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()].map(merge)
}

/** Merge one group of identical songs into a single item. */
function merge(group: ParsedItem[]): ParsedItem {
  if (group.length === 1) return group[0]!

  // Highest confidence wins; ties go to the earliest mention, which keeps output order
  // stable and matches what a reader would consider the canonical listing. Python's
  // `max` keeps the FIRST maximum, so the comparison is strict.
  let winner = group[0]!
  for (const item of group.slice(1)) {
    const better =
      item.confidence > winner.confidence ||
      (item.confidence === winner.confidence && -item.span.start > -winner.span.start)
    if (better) winner = item
  }
  const others = group.filter(item => item !== winner)

  let hints = winner.hints
  for (const other of others) hints = mergeHints(hints, other.hints)

  return Object.freeze({ ...winner, hints, duplicates: collectSpans(winner, others) })
}

/** Gather every other occurrence's spans, de-duplicated and in document order. */
function collectSpans(winner: ParsedItem, others: readonly ParsedItem[]): readonly Span[] {
  const spans = new Map<string, Span>()
  const add = (span: Span): void => {
    const key = `${span.start}:${span.end}`
    if (!spans.has(key)) spans.set(key, span)
  }

  for (const span of winner.duplicates) add(span)
  for (const other of others) {
    add(other.span)
    for (const span of other.duplicates) add(span)
  }
  // Python's `sorted` is stable, so equal starts keep insertion order.
  return Object.freeze([...spans.values()].sort((a, b) => a.start - b.start))
}

/** Fold artistless mentions into the one attributed item sharing their title. */
function absorbArtistless(items: ParsedItem[]): ParsedItem[] {
  const attributed = new Map<string, ParsedItem[]>()
  for (const item of items) {
    if (!item.artist) continue
    const key = fold(item.title)
    const group = attributed.get(key)
    if (group) group.push(item)
    else attributed.set(key, [item])
  }

  // Keyed by the item object itself, which is what the oracle's `id()` means here —
  // identity, not equality. Two distinct items can be field-identical.
  const absorbed = new Map<ParsedItem, ParsedItem[]>()
  const survivors: ParsedItem[] = []
  for (const item of items) {
    if (item.artist) {
      survivors.push(item)
      continue
    }
    const candidates = attributed.get(fold(item.title)) ?? []
    if (candidates.length === 1) {
      const target = candidates[0]!
      const group = absorbed.get(target)
      if (group) group.push(item)
      else absorbed.set(target, [item])
    } else {
      survivors.push(item)
    }
  }

  if (absorbed.size === 0) return survivors

  return survivors.map(item => {
    const sources = absorbed.get(item)
    return sources ? mergeAbsorbed(item, sources) : item
  })
}

/** Attach absorbed artistless mentions to their attributed item. */
function mergeAbsorbed(target: ParsedItem, sources: ParsedItem[]): ParsedItem {
  let hints = target.hints
  for (const source of sources) hints = mergeHints(hints, source.hints)
  return Object.freeze({ ...target, hints, duplicates: collectSpans(target, sources) })
}
