"""Daily aggregation from EVT# partitions to AGG# items, as a scheduled Lambda (PED D8).

`run(spec, source, sink)` is the whole job and it is pure. The adapters bind the two
ports to memory, to DynamoDB, or to the Lambda runtime, so the identical aggregation is
what a unit test, an integration test and production all exercise.
"""

from setlist_etl.catalog import ALLOWED_TYPES, BANNED_TYPES, catalog, declared_types
from setlist_etl.job import JobError, aggregate_key, run
from setlist_etl.model import Aggregate, EventRecord, JobSpec, Sink, Source

__all__ = [
    "ALLOWED_TYPES",
    "BANNED_TYPES",
    "Aggregate",
    "EventRecord",
    "JobError",
    "JobSpec",
    "Sink",
    "Source",
    "aggregate_key",
    "catalog",
    "declared_types",
    "run",
]
