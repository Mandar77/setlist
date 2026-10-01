"""Report ledger tasks whose `not_before` date has arrived.

Some work is gated on time rather than on another task: a soak period, a beta window,
a quota increase that takes a week. The ledger records those as `not_before`, and
without something to read it, a soak period nobody is reminded about is a soak period
that never ends.

Usage:
    python tools/check_due_tasks.py [--format text|github] [--today YYYY-MM-DD]

Exit code is 0 whether or not anything is due. This is a notifier, not a gate --
nightly jobs that go red for a non-problem teach people to ignore nightly jobs.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "docs" / "plan" / "TASKS.yaml"

#: Statuses worth resuming. A `done` task with a date has already happened.
PENDING = {"todo", "blocked", "doing"}


def due_tasks(ledger: Path, today: dt.date) -> list[tuple[str, str, dt.date]]:
    """Tasks whose not_before has passed and which are not finished."""
    data = yaml.safe_load(ledger.read_text(encoding="utf-8"))
    tasks = data["tasks"] if isinstance(data, dict) and "tasks" in data else data

    due: list[tuple[str, str, dt.date]] = []
    for task in tasks:
        raw = task.get("not_before")
        if raw is None or task.get("status") not in PENDING:
            continue
        # PyYAML parses an unquoted ISO date into a date already; a quoted one stays a
        # string. Accept both rather than depending on how it was written.
        when = raw if isinstance(raw, dt.date) else dt.date.fromisoformat(str(raw))
        if when <= today:
            due.append((task["id"], task.get("title", ""), when))

    return sorted(due, key=lambda item: item[2])


def main(argv: list[str]) -> int:
    """Entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("text", "github"), default="text")
    parser.add_argument("--today", default=None, help="Override today's date, for tests.")
    args = parser.parse_args(argv)

    # UTC explicitly. The nightly job runs on a UTC runner and a developer may not,
    # so a local-time "today" would make a task due a day early or late depending on
    # who asked -- and a soak period is exactly the thing that should not shift.
    today = dt.date.fromisoformat(args.today) if args.today else dt.datetime.now(tz=dt.UTC).date()
    due = due_tasks(LEDGER, today)

    lines = [f"- `{task_id}` {title} (due {when.isoformat()})" for task_id, title, when in due]

    if args.format == "github":
        # Multi-line output needs a random delimiter: a task title containing the
        # delimiter would otherwise let it terminate early, and GitHub rejects the step.
        output = os.environ.get("GITHUB_OUTPUT")
        body = "\n".join(lines)
        if output:
            delimiter = f"due_{os.urandom(8).hex()}"
            with Path(output).open("a", encoding="utf-8") as handle:
                handle.write(f"due<<{delimiter}\n{body}\n{delimiter}\n")
        print(body or "nothing due")
        return 0

    if not due:
        print("due tasks: none")
        return 0

    print(f"due tasks: {len(due)}")
    for line in lines:
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
