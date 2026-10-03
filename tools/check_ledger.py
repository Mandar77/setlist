"""Validate the autopilot ledger.

The ledger is the autopilot's memory across sessions. A dependency cycle, a typo in a
task id, or a task marked `done` with no evidence all fail the same way: silently, by
making the loop pick the wrong next task or skip work that was never actually done.
This runs in CI so that cannot happen.

Usage:
    python tools/check_ledger.py [path/to/TASKS.yaml]
"""

from __future__ import annotations

import sys
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import yaml

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "docs" / "plan" / "TASKS.yaml"
VALID_STATUS = {"todo", "doing", "blocked", "done", "needs-rethink"}
REQUIRED_FIELDS = ("id", "milestone", "title", "deps", "status", "done_when", "verify")


def _check_cycles(graph: dict[str, list[str]], problems: list[str]) -> None:
    """Depth-first search for dependency cycles."""
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str, path: list[str]) -> None:
        if node in visiting:
            problems.append(f"dependency cycle: {' -> '.join([*path, node])}")
            return
        if node in visited:
            return
        visiting.add(node)
        for dep in graph.get(node, []):
            visit(dep, [*path, node])
        visiting.discard(node)
        visited.add(node)

    for task_id in graph:
        visit(task_id, [])


def check(path: Path) -> list[str]:
    """Validate a ledger file, returning a list of problems (empty if clean)."""
    if not path.exists():
        return [f"{path} not found"]

    document: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    tasks: list[dict[str, Any]] = document.get("tasks") or []
    humans: dict[str, Any] = document.get("humans") or {}

    problems: list[str] = []
    if not tasks:
        return ["ledger has no tasks"]

    ids = [str(task.get("id", f"#{index}")) for index, task in enumerate(tasks)]
    for task_id, count in Counter(ids).items():
        if count > 1:
            problems.append(f"duplicate task id {task_id!r} ({count} times)")

    known = set(ids)
    by_id = {task["id"]: task for task in tasks if "id" in task}
    for task in tasks:
        problems += _check_task(task, known, by_id, humans)

    _check_cycles({task["id"]: task["deps"] for task in tasks if "id" in task}, problems)
    return problems


def _check_task(
    task: dict[str, Any],
    known: set[str],
    by_id: dict[str, dict[str, Any]],
    humans: dict[str, Any],
) -> list[str]:
    """Validate one task entry."""
    label = task.get("id", "<no id>")

    missing = [field for field in REQUIRED_FIELDS if field not in task]
    if missing:
        return [f"{label}: missing field(s): {', '.join(missing)}"]

    problems: list[str] = []
    status = task["status"]
    if status not in VALID_STATUS:
        problems.append(f"{label}: invalid status {status!r}")

    if not task["done_when"]:
        problems.append(f"{label}: done_when is empty - nothing would prove this task")

    problems += [f"{label}: unknown dependency {dep!r}" for dep in task["deps"] if dep not in known]

    blocked_on = task.get("blocked_on")
    if status == "blocked" and not blocked_on:
        problems.append(f"{label}: status is blocked but blocked_on is empty")
    if blocked_on and str(blocked_on).startswith("H") and str(blocked_on) not in humans:
        problems.append(f"{label}: blocked_on {blocked_on!r} is not a declared human session")

    if status == "done":
        # The whole point of the ledger: a task is only done if it can be shown to be,
        # and it cannot be done before the work it depends on.
        if not task.get("evidence"):
            problems.append(f"{label}: marked done with no evidence")
        problems += [
            f"{label}: done, but dependency {dep} is not done"
            for dep in task["deps"]
            if by_id.get(dep, {}).get("status") != "done"
        ]
    return problems


def selectable(tasks: list[dict[str, Any]], today: date | None = None) -> list[dict[str, Any]]:
    """Tasks the autopilot loop could pick up right now.

    A task is selectable when there is nothing left to wait for: it is not finished, it
    is not parked on a human session or an open ADR, every dependency is `done`, and any
    `not_before` date has passed.

    `needs-rethink` counts as selectable on purpose. It is work that still has to happen
    and it has no `blocked_on` to explain itself, so letting it read as "not selectable"
    would be exactly the silent stall this file exists to prevent.
    """
    # UTC rather than local time. `not_before` is a bare ISO date with no zone, and the
    # same ledger is read by CI on a Linux runner and locally on a Windows machine; a
    # local-time "today" would make a task selectable in one place and not the other
    # for several hours a day.
    today = today or datetime.now(tz=UTC).date()
    by_id = {task["id"]: task for task in tasks if "id" in task}
    ready = []
    for task in tasks:
        if task["status"] not in {"todo", "doing", "needs-rethink"}:
            continue
        if any(by_id.get(dep, {}).get("status") != "done" for dep in task["deps"]):
            continue
        not_before = task.get("not_before")
        if not_before and _as_date(not_before) > today:
            continue
        ready.append(task)
    return ready


def _as_date(value: date | datetime | str) -> date:
    """Coerce a ledger `not_before` to a date. PyYAML already parses bare ISO dates."""
    # datetime first: it is a subclass of date, so the order here is load-bearing.
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _print_status(tasks: list[dict[str, Any]]) -> None:
    """Counts by status, then every task the loop could take right now."""
    counts = Counter(task["status"] for task in tasks)
    print(f"ledger: {len(tasks)} tasks, {dict(counts)}\n")

    ready = selectable(tasks)
    if not ready:
        print("selectable tasks: none")
        print("  every task is done, blocked, or waiting on a not_before date")
        return

    print(f"selectable tasks: {len(ready)}")
    for task in ready:
        print(f"  {task['id']:10} {task['status']:14} {task['title']}")


def main(argv: list[str]) -> int:
    """Entry point: print problems and return non-zero if any exist."""
    args = [arg for arg in argv[1:] if not arg.startswith("--")]
    flags = {arg for arg in argv[1:] if arg.startswith("--")}
    path = Path(args[0]) if args else DEFAULT_PATH

    problems = check(path)
    if problems:
        print(f"{len(problems)} ledger problem(s) in {path}:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    tasks = document["tasks"]

    if "--status" in flags:
        _print_status(tasks)
        return 0

    counts = Counter(task["status"] for task in tasks)
    print(f"ledger OK: {len(tasks)} tasks, {dict(counts)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
