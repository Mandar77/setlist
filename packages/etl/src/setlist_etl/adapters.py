"""Ports bound to real things: memory, DynamoDB, and the Lambda entry point.

The DynamoDB adapter takes an already-constructed table resource rather than building
one. That is what lets the integration test point it at DynamoDB Local with a two-line
change and no environment variables, and it keeps `boto3` out of this package's
dependencies — the Lambda runtime provides it, and a unit test should not need AWS
installed to import the job.
"""

from __future__ import annotations

from contextlib import AbstractContextManager
from datetime import date
from typing import Any, Protocol

from setlist_etl.job import run
from setlist_etl.model import Aggregate, EventRecord, JobSpec


class BatchWriterLike(Protocol):
    """The one method the sink uses from boto3's batch writer."""

    def put_item(self, Item: dict[str, object]) -> None:  # noqa: N803  (boto3's casing)
        """Buffer one item for writing."""
        ...


class TableLike(Protocol):
    """The slice of a boto3 Table resource these adapters use.

    A Protocol rather than `Any` so the adapters state what they need, and so a fake in
    a test is checked against the same shape the real resource satisfies. boto3 ships no
    usable static types for its resource objects, which is why this is declared here
    instead of imported.
    """

    def query(self, **kwargs: object) -> dict[str, Any]:
        """Query one partition, one page at a time."""
        ...

    def batch_writer(self) -> AbstractContextManager[BatchWriterLike]:
        """A context manager that buffers writes."""
        ...


class InMemorySource:
    """A source backed by a list, for unit tests."""

    def __init__(self, records: list[EventRecord]) -> None:
        """Hold the records this source will filter."""
        self._records = records

    def read(self, spec: JobSpec) -> list[EventRecord]:
        """Return the records matching the spec's day and environment."""
        return [r for r in self._records if r.occurred_on == spec.day and r.env == spec.env]


class InMemorySink:
    """A sink that remembers, for unit tests."""

    def __init__(self) -> None:
        """Start with nothing written."""
        self.written: list[Aggregate] = []

    def write(self, aggregates: list[Aggregate]) -> None:
        """Remember the aggregates, replacing anything written before."""
        self.written = list(aggregates)


# --------------------------------------------------------------------- DynamoDB

#: The single table's partition key for a day of events.
EVENT_PARTITION = "EVT#{env}#{day}"


class DynamoDbSource:
    """Reads one `EVT#` partition.

    Paginated explicitly. `Table.query` returns at most 1 MB per call and a day with
    enough events to exceed that would otherwise be silently truncated — an aggregate
    that is correct about the first megabyte and wrong overall.
    """

    def __init__(self, table: TableLike) -> None:
        """Bind to an already-constructed table resource."""
        self._table = table

    def read(self, spec: JobSpec) -> list[EventRecord]:
        """Read every page of the day's partition."""
        from boto3.dynamodb.conditions import Key  # noqa: PLC0415  (Lambda-only import)

        partition = EVENT_PARTITION.format(env=spec.env, day=spec.day.isoformat())
        records: list[EventRecord] = []
        start_key: dict[str, Any] | None = None

        while True:
            kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(partition)}
            if start_key is not None:
                kwargs["ExclusiveStartKey"] = start_key
            page = self._table.query(**kwargs)

            for item in page.get("Items", []):
                records.append(
                    EventRecord(
                        event_type=str(item["event_type"]),
                        occurred_on=date.fromisoformat(str(item["occurred_on"])),
                        env=str(item["env"]),
                        payload={k: int(v) for k, v in (item.get("payload") or {}).items()},
                    )
                )

            start_key = page.get("LastEvaluatedKey")
            if start_key is None:
                return records


class DynamoDbSink:
    """Writes `AGG#` items, overwriting any previous run for the same day."""

    def __init__(self, table: TableLike) -> None:
        """Bind to an already-constructed table resource."""
        self._table = table

    def write(self, aggregates: list[Aggregate]) -> None:
        """Put each aggregate, overwriting the same key from a previous run."""
        with self._table.batch_writer() as batch:
            for aggregate in aggregates:
                batch.put_item(
                    Item={
                        "pk": aggregate.partition_key,
                        "sk": aggregate.sort_key,
                        "env": aggregate.env,
                        "event_type": aggregate.event_type,
                        "occurred_on": aggregate.occurred_on.isoformat(),
                        "count": aggregate.count,
                        "sums": aggregate.sums,
                    }
                )


def lambda_handler(event: dict[str, Any], _context: object = None) -> dict[str, Any]:
    """Scheduled entry point (PED D8).

    The day comes from the event so a backfill is a one-off invocation with a different
    date rather than a code change, and so a scheduled run is reproducible after the
    fact: `{"day": "2026-10-03", "env": "prod"}` means the same thing whenever it runs.
    """
    import boto3  # noqa: PLC0415  (provided by the Lambda runtime, not by this package)

    spec = JobSpec(
        day=date.fromisoformat(str(event["day"])),
        env=str(event["env"]),
        sum_fields=tuple(event.get("sum_fields", ())),
    )
    table = boto3.resource("dynamodb").Table(str(event["table"]))
    written = run(spec, DynamoDbSource(table), DynamoDbSink(table))
    return {"day": spec.day.isoformat(), "env": spec.env, "aggregates": len(written)}
