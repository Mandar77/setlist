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


def main(argv: list[str]) -> int:
    """Entry point: print problems and return non-zero if any exist."""
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_PATH
    problems = check(path)
    if problems:
        print(f"{len(problems)} ledger problem(s) in {path}:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    tasks = document["tasks"]
    counts = Counter(task["status"] for task in tasks)
    print(f"ledger OK: {len(tasks)} tasks, {dict(counts)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
