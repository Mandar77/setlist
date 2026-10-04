"""The DynamoDB adapters, against DynamoDB Local (M6-01).

Marked `local_aws`, not `integration`. The existing `integration` marker means "requires
deployed AWS resources (dev account)" and ADR-005 forbids local AWS credentials — this
needs neither. It runs against a container on localhost with fake credentials, so it can
run on any machine with Docker and in CI, and it must not be confused with a test that
touches a real account.

It is excluded from `make verify` for the same reason the Chromium conformance run is:
that gate has a five-minute budget and must work without Docker.

What it buys over the unit tests is the part the in-memory adapters cannot model —
pagination, the key schema, and the batch writer's overwrite semantics. `run` itself is
already covered; this is about the two adapters.
"""

from __future__ import annotations

import os
from datetime import date

import pytest
from setlist_etl import JobSpec, run
from setlist_etl.adapters import EVENT_PARTITION, DynamoDbSink, DynamoDbSource

boto3 = pytest.importorskip("boto3", reason="boto3 is a dev dependency for this test only")

pytestmark = pytest.mark.local_aws

ENDPOINT = os.environ.get("DYNAMODB_LOCAL_ENDPOINT", "http://localhost:8000")
TABLE = "setlist-etl-test"
DAY = date(2026, 10, 3)


@pytest.fixture(scope="module")
def table():  # type: ignore[no-untyped-def]
    """A fresh single-table instance in DynamoDB Local.

    Credentials are fake and the region is arbitrary: DynamoDB Local accepts anything and
    ADR-005 forbids real ones being present at all.
    """
    resource = boto3.resource(
        "dynamodb",
        endpoint_url=ENDPOINT,
        region_name="us-east-1",
        aws_access_key_id="local",
        # Not a secret: DynamoDB Local requires some credential and accepts any.
        aws_secret_access_key="local",  # noqa: S106
    )
    existing = {t.name for t in resource.tables.all()}
    if TABLE in existing:
        resource.Table(TABLE).delete()
        resource.Table(TABLE).wait_until_not_exists()

    created = resource.create_table(
        TableName=TABLE,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        # Provisioned, never PAY_PER_REQUEST — the never-use list bans on-demand, and a
        # test fixture that used it would normalise the thing the gate exists to stop.
        ProvisionedThroughput={"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    )
    created.wait_until_exists()
    yield created
    created.delete()


def _put_events(table, count: int, event_type: str = "scan.submitted", tracks: int = 1) -> None:  # type: ignore[no-untyped-def]
    partition = EVENT_PARTITION.format(env="dev", day=DAY.isoformat())
    with table.batch_writer() as batch:
        for i in range(count):
            batch.put_item(
                Item={
                    "pk": partition,
                    "sk": f"EVT#{i:06d}",
                    "event_type": event_type,
                    "occurred_on": DAY.isoformat(),
                    "env": "dev",
                    "payload": {"tracks": tracks},
                }
            )


def test_reads_a_partition_and_writes_aggregates(table) -> None:  # type: ignore[no-untyped-def]
    _put_events(table, 3, tracks=2)
    spec = JobSpec(day=DAY, env="dev", sum_fields=("tracks",))

    written = run(spec, DynamoDbSource(table), DynamoDbSink(table))

    assert len(written) == 1
    assert written[0].count == 3
    assert written[0].sums == {"tracks": 6}

    stored = table.get_item(Key={"pk": written[0].partition_key, "sk": written[0].sort_key})["Item"]
    assert int(stored["count"]) == 3


def test_a_rerun_overwrites_rather_than_duplicating(table) -> None:  # type: ignore[no-untyped-def]
    _put_events(table, 2)
    spec = JobSpec(day=DAY, env="dev")
    run(spec, DynamoDbSource(table), DynamoDbSink(table))
    run(spec, DynamoDbSource(table), DynamoDbSink(table))

    rows = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(f"AGG#dev#{DAY.isoformat()}")
    )["Items"]
    assert len(rows) == 1


def test_pagination_reads_every_record(table) -> None:  # type: ignore[no-untyped-def]
    # The thing the in-memory source cannot model. `Table.query` returns at most 1 MB per
    # call, so a day large enough to exceed it would otherwise be silently truncated —
    # an aggregate correct about the first megabyte and wrong overall.
    _put_events(table, 400)
    written = run(JobSpec(day=DAY, env="dev"), DynamoDbSource(table), DynamoDbSink(table))
    assert written[0].count == 400


def test_an_empty_partition_writes_nothing(table) -> None:  # type: ignore[no-untyped-def]
    spec = JobSpec(day=date(2020, 1, 1), env="dev")
    assert run(spec, DynamoDbSource(table), DynamoDbSink(table)) == []
