"""Glue **Catalog** definitions, and nothing else.

The distinction this module exists to hold:

* `AWS::Glue::Database` and `AWS::Glue::Table` are Data Catalog metadata. They are free,
  and they are what lets Athena describe the aggregates if anyone ever needs to.
* `AWS::Glue::Job`, `AWS::Glue::Crawler` and `AWS::Glue::Trigger` are compute. The
  cheapest Python shell job bills 1/16 DPU-hour at a one-minute minimum, so a daily job
  doing thirty seconds of work bills a minute a day forever. None of them reaches $0.

The never-use list bans the second group and the nag pack enforces it on synthesized
templates. `test_catalog.py` asserts it again from this side, because the nag rule can
only see what CDK emits — a definition added here and never synthesized would pass the
infrastructure gate while still being the wrong thing to have written.
"""

from __future__ import annotations

from typing import Any

#: Catalog resource types this package may declare.
ALLOWED_TYPES = frozenset({"AWS::Glue::Database", "AWS::Glue::Table"})

#: Compute resource types it may never declare, at any profile.
BANNED_TYPES = frozenset({"AWS::Glue::Job", "AWS::Glue::Crawler", "AWS::Glue::Trigger"})


def database(env: str) -> dict[str, Any]:
    """The Catalog database holding the aggregate table."""
    return {
        "Type": "AWS::Glue::Database",
        "Properties": {
            "DatabaseInput": {
                "Name": f"setlist_{env}",
                "Description": "Setlist daily aggregates. Catalog metadata only; no Glue compute.",
            }
        },
    }


def aggregates_table(env: str) -> dict[str, Any]:
    """The Catalog table describing `AGG#` items.

    Columns are counts and identifiers. There is no title or artist column, and that is
    deliberate rather than an omission: the aggregates carry none, so a column for one
    would be an invitation to start.
    """
    return {
        "Type": "AWS::Glue::Table",
        "Properties": {
            "DatabaseName": f"setlist_{env}",
            "TableInput": {
                "Name": "aggregates",
                "TableType": "EXTERNAL_TABLE",
                "PartitionKeys": [{"Name": "occurred_on", "Type": "date"}],
                "StorageDescriptor": {
                    "Columns": [
                        {"Name": "env", "Type": "string"},
                        {"Name": "event_type", "Type": "string"},
                        {"Name": "count", "Type": "bigint"},
                        {"Name": "sums", "Type": "map<string,bigint>"},
                    ]
                },
            },
        },
    }


def catalog(env: str) -> dict[str, dict[str, Any]]:
    """Every resource this package contributes, by logical id."""
    return {
        "SetlistGlueDatabase": database(env),
        "SetlistAggregatesTable": aggregates_table(env),
    }


def declared_types(resources: dict[str, dict[str, Any]]) -> set[str]:
    """The CloudFormation types a catalog declares."""
    return {str(resource["Type"]) for resource in resources.values()}
