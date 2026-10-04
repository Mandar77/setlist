"""The aggregation itself (M6-01).

Unit tests only: `run` is pure over two ports, so everything here is in-memory and fast.
The DynamoDB adapters get their own integration test against DynamoDB Local.
"""

from __future__ import annotations

from datetime import date

import pytest
from setlist_etl import EventRecord, JobError, JobSpec, aggregate_key, run
from setlist_etl.adapters import InMemorySink, InMemorySource

DAY = date(2026, 10, 3)
OTHER_DAY = date(2026, 10, 2)


def event(event_type: str = "scan.submitted", **payload: int) -> EventRecord:
    return EventRecord(event_type=event_type, occurred_on=DAY, env="dev", payload=payload)


def test_counts_events_by_type() -> None:
    sink = InMemorySink()
    written = run(
        JobSpec(day=DAY, env="dev"),
        InMemorySource([event(), event(), event("playlist.created")]),
        sink,
    )

    assert [(a.event_type, a.count) for a in written] == [
        ("playlist.created", 1),
        ("scan.submitted", 2),
    ]
    assert sink.written == written


def test_sums_only_the_requested_fields() -> None:
    written = run(
        JobSpec(day=DAY, env="dev", sum_fields=("tracks",)),
        InMemorySource([event(tracks=3, ignored=99), event(tracks=4, ignored=99)]),
        InMemorySink(),
    )
    assert written[0].sums == {"tracks": 7}
    assert "ignored" not in written[0].sums


def test_a_missing_field_is_skipped_rather_than_counted_as_zero() -> None:
    # Summing an absent field as zero and summing it as absent give the same total, but
    # they differ the moment anyone divides by the count of contributing records.
    written = run(
        JobSpec(day=DAY, env="dev", sum_fields=("tracks",)),
        InMemorySource([event(tracks=5), event()]),
        InMemorySink(),
    )
    assert written[0].sums == {"tracks": 5}
    assert written[0].count == 2


def test_an_empty_partition_writes_nothing() -> None:
    sink = InMemorySink()
    assert run(JobSpec(day=DAY, env="dev"), InMemorySource([]), sink) == []
    assert sink.written == []


def test_output_is_deterministic_regardless_of_input_order() -> None:
    spec = JobSpec(day=DAY, env="dev", sum_fields=("tracks",))
    forward = run(
        spec, InMemorySource([event("a", tracks=1), event("b", tracks=2)]), InMemorySink()
    )
    backward = run(
        spec, InMemorySource([event("b", tracks=2), event("a", tracks=1)]), InMemorySink()
    )
    assert forward == backward


def test_rerunning_a_day_overwrites_rather_than_appends() -> None:
    # The key collides on purpose. A scheduled job can be run twice by an operator, and
    # the cheapest defence against a doubled aggregate is a deterministic key.
    spec = JobSpec(day=DAY, env="dev")
    first = run(spec, InMemorySource([event()]), InMemorySink())
    second = run(spec, InMemorySource([event()]), InMemorySink())
    assert first[0].partition_key == second[0].partition_key
    assert first[0].sort_key == second[0].sort_key


def test_the_key_separates_days_and_environments() -> None:
    assert aggregate_key(JobSpec(day=DAY, env="dev"), "x") != aggregate_key(
        JobSpec(day=OTHER_DAY, env="dev"), "x"
    )
    assert aggregate_key(JobSpec(day=DAY, env="dev"), "x") != aggregate_key(
        JobSpec(day=DAY, env="prod"), "x"
    )


def test_a_record_from_the_wrong_day_is_an_error_not_a_filter() -> None:
    # Filtering it out quietly would produce a number that is wrong in a way nothing
    # downstream could detect. The source handed back a partition nobody asked for, and
    # that is a bug in the source.
    stray = EventRecord(event_type="x", occurred_on=OTHER_DAY, env="dev")
    with pytest.raises(JobError, match="2026-10-02"):
        run(JobSpec(day=DAY, env="dev"), _RawSource([stray]), InMemorySink())


def test_a_record_from_the_wrong_env_is_an_error() -> None:
    stray = EventRecord(event_type="x", occurred_on=DAY, env="prod")
    with pytest.raises(JobError, match="prod"):
        run(JobSpec(day=DAY, env="dev"), _RawSource([stray]), InMemorySink())


def test_a_non_integer_payload_is_an_error() -> None:
    bad = EventRecord(event_type="x", occurred_on=DAY, env="dev", payload={"tracks": "3"})  # type: ignore[dict-item]
    with pytest.raises(JobError, match="not an int"):
        run(JobSpec(day=DAY, env="dev", sum_fields=("tracks",)), _RawSource([bad]), InMemorySink())


def test_a_bool_is_not_an_int_for_summing() -> None:
    # bool is a subclass of int in Python, so `isinstance(True, int)` is True and a
    # careless sum would silently add 1 for every True.
    bad = EventRecord(event_type="x", occurred_on=DAY, env="dev", payload={"ok": True})  # type: ignore[dict-item]
    with pytest.raises(JobError, match="bool"):
        run(JobSpec(day=DAY, env="dev", sum_fields=("ok",)), _RawSource([bad]), InMemorySink())


def test_aggregates_carry_no_free_text() -> None:
    # The same rule packages/contracts enforces on the wire: an aggregate outlives the
    # request and ends up in backups, so it holds counts and identifiers only.
    written = run(
        JobSpec(day=DAY, env="dev", sum_fields=("tracks",)),
        InMemorySource([event(tracks=3)]),
        InMemorySink(),
    )
    for value in (written[0].event_type, written[0].env, written[0].partition_key):
        assert " " not in value


class _RawSource:
    """A source that returns exactly what it was given, including bad records."""

    def __init__(self, records: list[EventRecord]) -> None:
        self._records = records

    def read(self, spec: JobSpec) -> list[EventRecord]:
        return list(self._records)
