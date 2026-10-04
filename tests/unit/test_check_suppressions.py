"""Tests for the suppressions checker, and in particular for the generated ignore file.

The expiry half of this checker was already the point of the file: a suppression with no
deadline is a deleted finding. What it could not do was notice that the deadline applied
to nothing. ``security/suppressions.yaml`` was paperwork no scanner read, so an entry
here and the rule Trivy actually honoured were free to disagree in either direction — a
documented suppression that was never applied, or an applied one with no owner, no
reason and no expiry.

So the tests below come in pairs. For each property there is a document that must be
accepted and one that must be rejected, because a validator that accepts everything
passes every test written only from the happy side.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import check_suppressions as checker

TODAY = date(2026, 10, 2)


def _entry(**overrides: object) -> dict[str, object]:
    """A complete, valid suppression; override one field to make it invalid."""
    base: dict[str, object] = {
        "id": "AWS-0095",
        "tool": "trivy",
        "kind": "misconfiguration",
        "scope": "infra/bootstrap/account-bootstrap.yaml",
        "reason": "Encrypting it needs a customer-managed key, which is $1/month forever.",
        "owner": "someone",
        "opened": date(2026, 10, 2),
        "expires": date(2026, 12, 31),
    }
    base.update(overrides)
    return base


def _write(tmp_path: Path, *entries: dict[str, object], max_age: int = 90) -> Path:
    path = tmp_path / "suppressions.yaml"
    document = {"version": 1, "max_age_days": max_age, "suppressions": list(entries)}
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8", newline="\n")
    return path


# --------------------------------------------------------------------- validation


def test_a_complete_entry_is_accepted(tmp_path: Path) -> None:
    assert checker.check(_write(tmp_path, _entry()), today=TODAY) == []


def test_an_expired_entry_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _entry(opened=date(2026, 6, 1), expires=date(2026, 8, 30)))
    problems = checker.check(path, today=TODAY)
    assert len(problems) == 1
    assert "expired on 2026-08-30" in problems[0]


def test_an_entry_expiring_today_is_still_live(tmp_path: Path) -> None:
    # The boundary matters: `expires` is the last day it holds, not the first day it
    # does not, and Trivy's own `expired_at` is read the same way.
    path = _write(tmp_path, _entry(opened=date(2026, 7, 4), expires=TODAY))
    assert checker.check(path, today=TODAY) == []


def test_a_window_longer_than_the_limit_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _entry(opened=date(2026, 10, 2), expires=date(2027, 10, 2)))
    problems = checker.check(path, today=TODAY)
    assert len(problems) == 1
    assert "limit is 90" in problems[0]


@pytest.mark.parametrize("field", checker.REQUIRED_FIELDS)
def test_every_required_field_is_required(tmp_path: Path, field: str) -> None:
    path = _write(tmp_path, _entry(**{field: None}))
    problems = checker.check(path, today=TODAY)
    assert len(problems) == 1
    assert field in problems[0]


def test_scope_is_required(tmp_path: Path) -> None:
    # Called out separately from the parametrised case above because this is the field
    # that makes a suppression answerable: without it an entry silences a rule
    # everywhere, and the generated ignore file would have no `paths` to write.
    assert "scope" in checker.REQUIRED_FIELDS


def test_the_same_rule_in_two_files_is_two_suppressions(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        _entry(scope="infra/bootstrap/account-bootstrap.yaml"),
        _entry(scope="infra/lib/other.yaml"),
    )
    assert checker.check(path, today=TODAY) == []


def test_the_same_rule_twice_in_one_file_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, _entry(), _entry(reason="a different story, same finding"))
    problems = checker.check(path, today=TODAY)
    assert len(problems) == 1
    assert "duplicate" in problems[0]


def test_a_trivy_entry_without_a_valid_kind_is_rejected(tmp_path: Path) -> None:
    # `kind` picks the section of .trivyignore.yaml the rule lands in. Guessing it from
    # the id would work until the day it did not, and the failure would be a suppression
    # written into a section Trivy never consults for that finding.
    path = _write(tmp_path, _entry(kind="typo"))
    problems = checker.check(path, today=TODAY)
    assert len(problems) == 1
    assert "kind" in problems[0]


def test_kind_is_not_demanded_of_other_tools(tmp_path: Path) -> None:
    entry = _entry(tool="kics", id="KICS-a1b2c3d4")
    del entry["kind"]
    assert checker.check(_write(tmp_path, entry), today=TODAY) == []


# ----------------------------------------------------------------- generated file


def _render(*entries: dict[str, object]) -> Any:
    return yaml.safe_load(checker.render_trivyignore({"suppressions": list(entries)}))


def test_a_trivy_entry_becomes_an_ignore_rule() -> None:
    rendered = _render(_entry())
    assert rendered["misconfigurations"] == [
        {
            "id": "AWS-0095",
            "paths": ["infra/bootstrap/account-bootstrap.yaml"],
            "statement": "accepted by @someone until 2026-12-31 - see security/suppressions.yaml",
            "expired_at": date(2026, 12, 31),
        }
    ]


def test_the_ignore_rule_expires_on_the_suppression_s_own_date() -> None:
    # The two deadlines are one deadline. Trivy stops honouring the rule on the same day
    # this checker starts failing, so a forgotten suppression surfaces as the finding
    # coming back rather than as nothing happening at all.
    rendered = _render(_entry(expires=date(2026, 11, 15)))
    assert rendered["misconfigurations"][0]["expired_at"] == date(2026, 11, 15)


def test_kind_chooses_the_section() -> None:
    rendered = _render(_entry(kind="vulnerability", id="CVE-2026-0001"))
    assert [r["id"] for r in rendered["vulnerabilities"]] == ["CVE-2026-0001"]
    assert rendered["misconfigurations"] == []


def test_entries_for_other_tools_are_not_written_to_trivy() -> None:
    entry = _entry(tool="kics", id="KICS-a1b2c3d4")
    del entry["kind"]
    rendered = _render(entry)
    assert all(section == [] for section in rendered.values())


def test_every_section_is_present_even_when_empty() -> None:
    # Dropping an empty section would make "Trivy suppresses no secrets here" and "this
    # file has nothing to say about secrets" look identical.
    rendered = _render()
    assert set(rendered) == set(checker.TRIVY_SECTIONS.values())


def test_the_rendering_is_stable_across_entry_order() -> None:
    # The file is checked for staleness by comparing bytes, so a generator whose output
    # depended on input order would report drift every time two entries were swapped.
    one = _entry(id="AWS-0001")
    two = _entry(id="AWS-0002", scope="infra/lib/other.yaml")
    assert checker.render_trivyignore({"suppressions": [one, two]}) == checker.render_trivyignore(
        {"suppressions": [two, one]}
    )


def test_the_checked_in_ignore_file_matches_the_checked_in_suppressions() -> None:
    # The staleness check that `make suppressions` runs, as a test, so that a
    # hand-edited .trivyignore.yaml fails the unit suite too rather than only the gate
    # someone might not have run yet.
    expected = checker.render_trivyignore(checker.load(checker.DEFAULT_PATH))
    assert checker.TRIVYIGNORE_PATH.read_text(encoding="utf-8") == expected


# ------------------------------------------------------------------ kics exclusions


def _kics_exclude(*entries: dict[str, object]) -> str:
    return checker.render_kics_exclude({"suppressions": list(entries)})


def test_a_kics_entry_becomes_an_excluded_query_id() -> None:
    rendered = _kics_exclude(_entry(tool="kics", id="c8dee387-a2e6-4a73-a942-183c975549ac"))
    assert rendered == "c8dee387-a2e6-4a73-a942-183c975549ac\n"


def test_entries_for_other_tools_are_not_excluded_from_kics() -> None:
    # The must-fail direction: a Trivy suppression must NOT silence a KICS query. The
    # two scanners share this file and nothing else, and an id that leaked across would
    # disable a gate nobody asked to disable.
    assert _kics_exclude(_entry(tool="trivy")) == "\n"


def test_no_kics_entries_excludes_nothing() -> None:
    # An empty list must stay empty rather than becoming a stray token: the file's whole
    # contents are substituted into `--exclude-queries`, so a header line or a `-` would
    # be read by KICS as a query id and silently match nothing.
    assert _kics_exclude() == "\n"


def test_the_exclusion_list_is_stable_across_entry_order() -> None:
    # Sorted and de-duplicated, so the generated file does not churn when a suppression
    # is inserted above another and `make verify` does not fail on a reordering.
    first = _kics_exclude(_entry(tool="kics", id="bbb"), _entry(tool="kics", id="aaa", scope="x"))
    second = _kics_exclude(_entry(tool="kics", id="aaa", scope="x"), _entry(tool="kics", id="bbb"))
    assert first == second == "aaa,bbb\n"


def test_the_checked_in_kics_exclusions_match_the_checked_in_suppressions() -> None:
    # Same staleness guarantee as the Trivy file. A hand-edited exclusion list is how a
    # HIGH finding gets silenced with no owner and no expiry — and KICS's flag has
    # nowhere to carry a date, so this file and `check()` are the only things enforcing
    # one.
    expected = checker.render_kics_exclude(checker.load(checker.DEFAULT_PATH))
    assert checker.KICS_EXCLUDE_PATH.read_text(encoding="utf-8") == expected
