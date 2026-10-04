"""Glue Catalog definitions only — no compute, at any profile (M6-01).

The nag pack already bans `AWS::Glue::Job`, `AWS::Glue::Crawler` and
`AWS::Glue::Trigger` on synthesized templates, and `infra/test/never-use.test.ts` proves
that rule fires. This asserts the same thing from the other side, because the nag rule
can only see what CDK emits: a Glue job defined here and not yet synthesized would pass
the infrastructure gate while already being the wrong thing to have written.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest
from setlist_etl import ALLOWED_TYPES, BANNED_TYPES, catalog, declared_types
from setlist_etl import catalog as catalog_module


def test_declares_only_catalog_metadata() -> None:
    types = declared_types(catalog("dev"))
    assert types <= ALLOWED_TYPES
    assert types == {"AWS::Glue::Database", "AWS::Glue::Table"}


@pytest.mark.parametrize("banned", sorted(BANNED_TYPES))
def test_declares_no_glue_compute(banned: str) -> None:
    # No Glue option reaches $0: the cheapest Python shell job bills 1/16 DPU-hour at a
    # one-minute minimum, so a daily job doing thirty seconds of work bills a minute a
    # day forever.
    assert banned not in declared_types(catalog("dev"))


@pytest.mark.parametrize("env", ["dev", "stage", "prod"])
def test_the_ban_holds_in_every_environment(env: str) -> None:
    assert declared_types(catalog(env)).isdisjoint(BANNED_TYPES)


def test_the_banned_set_is_not_empty() -> None:
    # The control. If BANNED_TYPES were empty every assertion above would pass while
    # checking nothing, which is the shape of failure this repository keeps finding.
    assert BANNED_TYPES
    assert "AWS::Glue::Job" in BANNED_TYPES


def test_no_glue_compute_type_appears_anywhere_in_the_package() -> None:
    # Stronger than inspecting the returned dict: a type string present in the source at
    # all is a type somebody was part-way through adding.
    source_dir = Path(inspect.getfile(catalog_module)).parent
    for path in source_dir.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for banned in BANNED_TYPES:
            # catalog.py names them in BANNED_TYPES itself, which is the point of it.
            if path.name == "catalog.py":
                continue
            assert banned not in text, f"{path.name} mentions {banned}"


def test_the_table_has_no_column_for_song_text() -> None:
    # The aggregates carry none, so a column for one would be an invitation to start.
    table = catalog("dev")["SetlistAggregatesTable"]
    columns = {
        str(c["Name"]) for c in table["Properties"]["TableInput"]["StorageDescriptor"]["Columns"]
    }
    assert columns.isdisjoint({"title", "artist", "track", "song", "email", "user_name"})
