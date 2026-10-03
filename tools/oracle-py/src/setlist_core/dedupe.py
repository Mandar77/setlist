"""Deduplication of repeated songs (FR-004).

Two passes, in this order:

1. **Exact key collapse.** Items sharing a `ParsedItem.key` - folded title, folded
   artist, and qualifier set - are one song. Qualifiers are part of the key so a
   studio cut and its live version stay separate.
2. **Artist absorption.** A title that appeared once without an artist and once with
   one is the same song mentioned twice; the artistless mention is folded into the
   attributed one. This only fires when exactly one attributed item shares the title,
   so an ambiguous "Home" is never guessed at.
"""

from collections.abc import Sequence

from setlist_core.models import ParsedItem, Span
from setlist_core.normalize import fold

__all__ = ["dedupe"]


def dedupe(items: Sequence[ParsedItem]) -> tuple[ParsedItem, ...]:
    """Collapse duplicate songs, preserving first-appearance order.

    The surviving item is the highest-confidence occurrence; every other occurrence
    contributes its hints and is recorded in `ParsedItem.duplicates` so the UI can
    show "appeared 3 times" and the review flow can cite each mention.
    """
    return _absorb_artistless(_collapse_exact(items))


def _collapse_exact(items: Sequence[ParsedItem]) -> list[ParsedItem]:
    """Group by dedup key and merge each group into its best occurrence."""
    groups: dict[str, list[ParsedItem]] = {}
    for item in items:
        groups.setdefault(item.key, []).append(item)
    return [_merge(group) for group in groups.values()]


def _merge(group: list[ParsedItem]) -> ParsedItem:
    """Merge one group of identical songs into a single item."""
    if len(group) == 1:
        return group[0]
    # Highest confidence wins; ties go to the earliest mention, which keeps output
    # order stable and matches what a reader would consider the canonical listing.
    winner = max(group, key=lambda item: (item.confidence, -item.span.start))
    others = [item for item in group if item is not winner]

    hints = winner.hints
    for other in others:
        hints = hints.merge(other.hints)

    return winner.model_copy(
        update={
            "hints": hints,
            "duplicates": _collect_spans(winner, others),
        }
    )


def _collect_spans(winner: ParsedItem, others: Sequence[ParsedItem]) -> tuple[Span, ...]:
    """Gather every other occurrence's spans, de-duplicated and in document order."""
    spans: dict[tuple[int, int], Span] = {}

    def add(span: Span) -> None:
        spans.setdefault((span.start, span.end), span)

    for span in winner.duplicates:
        add(span)
    for other in others:
        add(other.span)
        for span in other.duplicates:
            add(span)
    return tuple(sorted(spans.values(), key=lambda s: s.start))


def _absorb_artistless(items: list[ParsedItem]) -> tuple[ParsedItem, ...]:
    """Fold artistless mentions into the one attributed item sharing their title."""
    attributed: dict[str, list[ParsedItem]] = {}
    for item in items:
        if item.artist:
            attributed.setdefault(fold(item.title), []).append(item)

    absorbed: dict[int, list[ParsedItem]] = {}
    survivors: list[ParsedItem] = []
    for item in items:
        if item.artist:
            survivors.append(item)
            continue
        candidates = attributed.get(fold(item.title), [])
        if len(candidates) == 1:
            absorbed.setdefault(id(candidates[0]), []).append(item)
        else:
            survivors.append(item)

    if not absorbed:
        return tuple(survivors)

    return tuple(
        _merge_absorbed(item, absorbed[id(item)]) if id(item) in absorbed else item
        for item in survivors
    )


def _merge_absorbed(target: ParsedItem, sources: list[ParsedItem]) -> ParsedItem:
    """Attach absorbed artistless mentions to their attributed item."""
    hints = target.hints
    for source in sources:
        hints = hints.merge(source.hints)
    return target.model_copy(update={"hints": hints, "duplicates": _collect_spans(target, sources)})
