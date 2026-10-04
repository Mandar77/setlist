"""The shapes the ETL reads and writes.

`EVT#` partitions in, `AGG#` items out. Both live in the single DynamoDB table, which is
why neither carries a table name: the adapter knows where it is, the job knows what it
means (PED D8).

Everything here is frozen. The job is a pure function and a mutable record passed through
it would let a sink quietly change what a source produced, which is the class of bug that
makes an aggregation irreproducible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Protocol


@dataclass(frozen=True, slots=True)
class EventRecord:
    """One analytics event, as written by the services that emit them.

    `payload` carries counts and identifiers only, never song titles or personal data —
    the same rule `packages/contracts` enforces on the wire, and for the same reason: an
    aggregate outlives the request and ends up in backups.
    """

    event_type: str
    occurred_on: date
    env: str
    payload: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Aggregate:
    """One `AGG#` item: a daily roll-up for a single event type."""

    partition_key: str
    sort_key: str
    env: str
    event_type: str
    occurred_on: date
    count: int
    sums: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class JobSpec:
    """What a run covers.

    A single day, a single environment. Daily partitions are the unit because the table
    is partitioned that way and because a job that could span an arbitrary range would be
    a job whose cost nobody can predict.
    """

    day: date
    env: str
    """Which payload fields to sum. Anything not listed is counted but not summed."""
    sum_fields: tuple[str, ...] = ()


class Source(Protocol):
    """Reads one day's `EVT#` partition."""

    def read(self, spec: JobSpec) -> list[EventRecord]:
        """Return every event in the partition the spec names."""
        ...


class Sink(Protocol):
    """Writes `AGG#` items."""

    def write(self, aggregates: list[Aggregate]) -> None:
        """Persist the aggregates, overwriting any previous run for the same day."""
        ...
