"""Verify that every relative link in the repo's markdown actually resolves.

The docs are load-bearing here: CLAUDE.md, the ledger and the ADRs cite each other and
the specs, and the autopilot loop follows those citations to decide what to do. A dead
link is a silent instruction to read something that does not exist.

Checks relative links and anchors. External URLs are not fetched — that would be a
network dependency in a gate that must run offline.

Usage:
    python tools/check_links.py [--anchors]
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# [text](target) — the target may carry an #anchor and/or a "title".
LINK_RE = re.compile(r"\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
# ATX headings, for anchor resolution.
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
EXTERNAL = ("http://", "https://", "mailto:", "tel:", "#")


def _git_markdown() -> list[str]:
    """Every tracked markdown file."""
    out = subprocess.run(
        ["git", "ls-files", "*.md"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8", errors="replace")
    return [line for line in out.splitlines() if line.strip()]


def _slug(heading: str) -> str:
    """GitHub's heading-to-anchor transformation, closely enough for our docs."""
    text = re.sub(r"`([^`]*)`", r"\1", heading)  # strip inline code markers
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links -> their text
    text = re.sub(r"[*_~]", "", text)  # emphasis
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    return re.sub(r"\s+", "-", text)


def _anchors(path: Path) -> set[str]:
    """Every anchor a markdown file defines."""
    found: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        match = HEADING_RE.match(line)
        if match:
            found.add(_slug(match.group(2)))
    return found


def check(*, verify_anchors: bool = False) -> tuple[int, list[str]]:
    """Return (links checked, problems)."""
    problems: list[str] = []
    checked = 0
    anchor_cache: dict[Path, set[str]] = {}

    for rel in _git_markdown():
        source = ROOT / rel
        if not source.exists():
            continue
        for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
            for match in LINK_RE.finditer(line):
                raw = match.group(1).strip("<>")
                if raw.startswith(EXTERNAL):
                    continue
                checked += 1

                target, _, anchor = raw.partition("#")
                if not target:
                    continue

                resolved = (source.parent / target).resolve()
                if not resolved.exists():
                    problems.append(f"{rel}:{number}: {raw!r} -> missing {target}")
                    continue

                if verify_anchors and anchor and resolved.suffix == ".md":
                    if resolved not in anchor_cache:
                        anchor_cache[resolved] = _anchors(resolved)
                    if _slug(anchor) not in anchor_cache[resolved]:
                        problems.append(f"{rel}:{number}: {raw!r} -> no such heading #{anchor}")

    return checked, problems


def main(argv: list[str]) -> int:
    """Entry point."""
    checked, problems = check(verify_anchors="--anchors" in argv)
    if problems:
        print(f"link check: {len(problems)} problem(s) across {checked} relative links\n")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"link check: clean ({checked} relative links)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
