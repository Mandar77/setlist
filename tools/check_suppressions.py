"""Fail CI when a security suppression has expired or is missing its paperwork.

A suppression is a time-boxed decision to accept a finding. Without an expiry check it
becomes a permanent deletion of that finding, and the security gate quietly stops
meaning anything. This script is what keeps the box closed.

Usage:
    python tools/check_suppressions.py [path/to/suppressions.yaml]
"""

from __future__ import annotations

import sys
from datetime import UTC, date, datetime
from pathlib import Path

import yaml

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "security" / "suppressions.yaml"
REQUIRED_FIELDS = ("id", "tool", "reason", "owner", "opened", "expires")
DEFAULT_MAX_AGE_DAYS = 90


def _as_date(value: object, entry: str, field: str, problems: list[str]) -> date | None:
    """Coerce a YAML value to a date, recording a problem if it is not one."""
    if isinstance(value, date):
        return value
    problems.append(f"{entry}: {field!r} must be a YYYY-MM-DD date, got {value!r}")
    return None


def check(path: Path, today: date | None = None) -> list[str]:
    """Validate a suppressions file, returning a list of problems (empty if clean)."""
    today = today or datetime.now(tz=UTC).date()
    if not path.exists():
        return [f"{path} not found"]

    document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    max_age = int(document.get("max_age_days", DEFAULT_MAX_AGE_DAYS))
    entries = document.get("suppressions") or []

    problems: list[str] = []
    seen: set[str] = set()

    for index, entry in enumerate(entries):
        label = f"suppression[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{label}: must be a mapping")
            continue

        label = f"suppression {entry.get('id', f'#{index}')!r}"
        missing = [field for field in REQUIRED_FIELDS if not entry.get(field)]
        if missing:
            problems.append(f"{label}: missing required field(s): {', '.join(missing)}")
            continue

        identifier = str(entry["id"])
        if identifier in seen:
            problems.append(f"{label}: duplicate id")
        seen.add(identifier)

        opened = _as_date(entry["opened"], label, "opened", problems)
        expires = _as_date(entry["expires"], label, "expires", problems)
        if opened is None or expires is None:
            continue

        if expires < today:
            problems.append(f"{label}: expired on {expires} - re-review it or fix the finding")
        if (expires - opened).days > max_age:
            problems.append(
                f"{label}: window is {(expires - opened).days} days, limit is {max_age}"
            )

    return problems


def main(argv: list[str]) -> int:
    """Entry point: print problems and return a non-zero exit code if any exist."""
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_PATH
    problems = check(path)
    if problems:
        print(f"{len(problems)} suppression problem(s) in {path}:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"suppressions OK ({path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
