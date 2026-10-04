"""`run(job, source, sink)` — the whole ETL (PED D8).

Three arguments and no globals, because the alternative is a job that can only run where
its dependencies happen to be configured. With ports, the same function runs against
in-memory fixtures in a unit test, against DynamoDB Local in an integration test, and
against the real table in a Lambda, and all three exercise the identical aggregation.

## Why Glue is not here

PED D8 and the never-use list: no Glue option reaches $0. The cheapest Python shell job
bills 1/16 DPU-hour at a one-minute minimum and Spark bills two full DPUs, so a daily
job that does thirty seconds of work still bills a minute, every day, forever. The Data
Catalog is free, and it is the only part of Glue this project uses — see `catalog.py`.
This runs as a scheduled Lambda instead, which at this volume is free.
"""

from __future__ import annotations

from collections import defaultdict

from setlist_etl.model import Aggregate, JobSpec, Sink, Source


class JobError(ValueError):
    """A run that cannot produce a correct aggregate, rather than an empty one."""


def aggregate_key(spec: JobSpec, event_type: str) -> tuple[str, str]:
    """The `AGG#` composite key for one event type on one day.

    Deterministic, so a re-run overwrites its own previous output rather than appending
    a second copy. That is what makes the job idempotent: PED §10.4 puts retries on
    `@idempotent`, but a scheduled job can also simply be run twice by an operator, and
    the cheapest defence is a key that collides on purpose.
    """
    return (f"AGG#{spec.env}#{spec.day.isoformat()}", f"TYPE#{event_type}")


def run(spec: JobSpec, source: Source, sink: Sink) -> list[Aggregate]:
    """Read one day's events, roll them up by type, write the aggregates.

    Returns what it wrote, so a caller can log or assert on it without re-reading.
    """
    records = source.read(spec)

    # A record from the wrong day or environment means the source handed back a
    # partition the spec did not ask for. Aggregating it anyway would produce a number
    # that is wrong in a way nothing downstream could detect, so it is an error rather
    # than something to filter out quietly.
    for record in records:
        if record.occurred_on != spec.day:
            raise JobError(
                f"source returned a {record.occurred_on.isoformat()} record "
                f"for the {spec.day.isoformat()} partition"
            )
        if record.env != spec.env:
            raise JobError(f"source returned a {record.env} record for the {spec.env} partition")

    counts: dict[str, int] = defaultdict(int)
    sums: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for record in records:
        counts[record.event_type] += 1
        for name in spec.sum_fields:
            value = record.payload.get(name)
            if value is None:
                continue
            if not isinstance(value, int) or isinstance(value, bool):
                raise JobError(
                    f"{record.event_type}.{name} is {type(value).__name__}, not an int; "
                    "a sum over mixed types is a number nobody can interpret"
                )
            sums[record.event_type][name] += value

    aggregates = []
    for event_type in sorted(counts):
        partition_key, sort_key = aggregate_key(spec, event_type)
        aggregates.append(
            Aggregate(
                partition_key=partition_key,
                sort_key=sort_key,
                env=spec.env,
                event_type=event_type,
                occurred_on=spec.day,
                count=counts[event_type],
                sums=dict(sorted(sums[event_type].items())),
            )
        )

    sink.write(aggregates)
    return aggregates
