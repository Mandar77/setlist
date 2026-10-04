"""Fail CI on a suppression that has expired, lacks paperwork, or suppresses nothing.

A suppression is a time-boxed decision to accept a finding. Without an expiry check it
becomes a permanent deletion of that finding, and the security gate quietly stops
meaning anything. The expiry half of this script is what keeps that box closed.

The second half exists because the first half was not enough. ``security/suppressions.yaml``
is paperwork, and paperwork that no tool reads is a comment. Trivy reads
``.trivyignore.yaml``; nothing made the two agree. A line added to the generated file
with no entry here would silence a finding with no owner, no reason and no expiry, and
an entry here with no corresponding ignore rule would describe a suppression that was
never applied — both of them the vacuous-gate shape this repository keeps finding.

So ``.trivyignore.yaml`` is generated from this file and checked for staleness, the
same arrangement as the KICS queries and the account bootstrap template. The expiry
then binds twice over: this script fails on an expired entry, and Trivy's own
``expired_at`` stops honouring the rule on the same day, so a forgotten suppression
surfaces as the finding coming back rather than as nothing at all.

``osv-scanner.toml`` is generated the same way from the ``tool: osv`` entries, and for
the same reason — osv-scanner reads its own config and would otherwise be a second
scanner that could be quieted by hand. Its ``ignoreUntil`` carries the expiry across.

Usage:
    python tools/check_suppressions.py [path/to/suppressions.yaml]   # validate + staleness
    python tools/check_suppressions.py --write                       # regenerate
"""

from __future__ import annotations

import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import yaml

#: A parsed suppressions document, and one entry in it. Deliberately loose: this is
#: hand-written YAML whose shape is what `check` exists to validate, so a TypedDict here
#: would be asserting the thing under test.
Document = dict[str, Any]
Entry = dict[str, Any]

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PATH = REPO_ROOT / "security" / "suppressions.yaml"
TRIVYIGNORE_PATH = REPO_ROOT / ".trivyignore.yaml"
OSV_CONFIG_PATH = REPO_ROOT / "osv-scanner.toml"
KICS_EXCLUDE_PATH = REPO_ROOT / "security" / "kics-exclude-queries.txt"

REQUIRED_FIELDS = ("id", "tool", "scope", "reason", "owner", "opened", "expires")
DEFAULT_MAX_AGE_DAYS = 90

#: Trivy splits its ignore file by finding class. The key is what an entry writes as
#: `kind`; the value is the section name Trivy expects.
TRIVY_SECTIONS = {
    "vulnerability": "vulnerabilities",
    "misconfiguration": "misconfigurations",
    "secret": "secrets",
    "license": "licenses",
}

GENERATED_HEADER = """\
# GENERATED FILE - do not edit.
#
# Written from security/suppressions.yaml by tools/check_suppressions.py. Edit the
# suppression there and run `make suppressions-write`; `make verify` fails if this file
# and that one disagree, so a Trivy finding cannot be silenced without an owner, a
# reason and an expiry.
#
# `expired_at` is the same date as the suppression's `expires`. Trivy stops honouring
# the rule on that day, which means a forgotten suppression shows up as the finding
# returning rather than as nothing happening.
"""


def _as_date(value: object, entry: str, field: str, problems: list[str]) -> date | None:
    """Coerce a YAML value to a date, recording a problem if it is not one."""
    if isinstance(value, date):
        return value
    problems.append(f"{entry}: {field!r} must be a YYYY-MM-DD date, got {value!r}")
    return None


def load(path: Path) -> Document:
    """Parse a suppressions file into a plain document."""
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def check(path: Path, today: date | None = None) -> list[str]:
    """Validate a suppressions file, returning a list of problems (empty if clean)."""
    today = today or datetime.now(tz=UTC).date()
    if not path.exists():
        return [f"{path} not found"]

    document: Document = load(path)
    max_age = int(document.get("max_age_days", DEFAULT_MAX_AGE_DAYS))
    # `list[Any]`, not `list[Entry]`: this is whatever the YAML happened to contain, and
    # the `isinstance` below is a real check rather than a formality. Annotating it as a
    # list of mappings made mypy call that branch unreachable, which it is not.
    entries: list[Any] = document.get("suppressions") or []

    problems: list[str] = []
    seen: set[tuple[str, str]] = set()

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

        # Identity is (id, scope), not id. The same rule can legitimately be accepted in
        # two different files for two different reasons, and collapsing those into one
        # entry would hide the second one's expiry behind the first one's.
        identity = (str(entry["id"]), str(entry["scope"]))
        if identity in seen:
            problems.append(f"{label}: duplicate id for scope {entry['scope']!r}")
        seen.add(identity)

        if entry["tool"] == "trivy" and entry.get("kind") not in TRIVY_SECTIONS:
            problems.append(
                f"{label}: tool is trivy, so 'kind' must be one of "
                f"{', '.join(sorted(TRIVY_SECTIONS))}; got {entry.get('kind')!r}"
            )

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


def render_trivyignore(document: Document) -> str:
    """Render the `.trivyignore.yaml` that the `tool: trivy` entries describe.

    Every section Trivy understands is emitted even when empty, so that removing the
    last suppression of a class leaves a file that still says what it covers rather than
    one that silently stops mentioning it.
    """
    entries: list[Entry] = [
        entry
        for entry in (document.get("suppressions") or [])
        if isinstance(entry, dict) and entry.get("tool") == "trivy"
    ]

    body: dict[str, list[Entry]] = {name: [] for name in TRIVY_SECTIONS.values()}
    for entry in sorted(entries, key=lambda e: (str(e.get("id")), str(e.get("scope")))):
        section = TRIVY_SECTIONS[str(entry["kind"])]
        body[section].append(
            {
                "id": str(entry["id"]),
                "paths": [str(entry["scope"])],
                # A pointer, not a copy. Trivy prints this beside the finding, where
                # what a reader needs is where the decision lives and who owns it; the
                # argument itself is in suppressions.yaml, reviewed, and reproducing it
                # here would be one more pair of strings free to drift apart.
                "statement": (
                    f"accepted by @{entry['owner']} until {entry['expires']}"
                    " - see security/suppressions.yaml"
                ),
                "expired_at": entry["expires"],
            }
        )

    dumped = yaml.safe_dump(
        body, sort_keys=False, default_flow_style=False, width=100, allow_unicode=True
    )
    return f"{GENERATED_HEADER}\n{dumped}"


OSV_GENERATED_HEADER = """\
# GENERATED FILE - do not edit.
#
# Written from security/suppressions.yaml by tools/check_suppressions.py. Edit the
# suppression there and run `make suppressions-write`; `make verify` fails if this file
# and that one disagree, so an OSV finding cannot be silenced without an owner, a reason
# and an expiry.
#
# `ignoreUntil` is the same date as the suppression's `expires`. osv-scanner stops
# honouring the entry on that day, so a forgotten suppression shows up as the finding
# coming back rather than as nothing happening.
"""


def render_osv_config(document: Document) -> str:
    """Render the `osv-scanner.toml` that the `tool: osv` entries describe.

    Written as text rather than through a TOML writer because the shape is three scalars
    per entry and the standard library has no TOML serializer — adding a dependency to
    emit nine lines would be the larger risk.

    `ignoreUntil` is spelled as a full RFC 3339 instant: osv-scanner parses it into a
    `time.Time`, and a bare date leaves the interpretation to the TOML library rather
    than to this file.
    """
    entries: list[Entry] = [
        entry
        for entry in (document.get("suppressions") or [])
        if isinstance(entry, dict) and entry.get("tool") == "osv"
    ]

    lines: list[str] = [OSV_GENERATED_HEADER]
    for entry in sorted(entries, key=lambda e: (str(e.get("id")), str(e.get("scope")))):
        # A pointer, not a copy, for the same reason as the Trivy statement above: the
        # argument lives in suppressions.yaml where it was reviewed.
        reason = (
            f"accepted by @{entry['owner']} until {entry['expires']}"
            " - see security/suppressions.yaml"
        )
        lines.append("[[IgnoredVulns]]")
        lines.append(f'id = "{entry["id"]}"')
        lines.append(f"ignoreUntil = {entry['expires']}T00:00:00Z")
        lines.append(f'reason = "{reason}"')
        lines.append("")

    return "\n".join(lines)


def render_kics_exclude(document: Document) -> str:
    """Render the KICS `--exclude-queries` list the `tool: kics` entries describe.

    A bare comma-separated line of query UUIDs, because that is exactly what the flag
    takes and the Makefile and CI substitute the file's contents directly. No header:
    anything else in the file would be passed to KICS as a query id.

    The expiry therefore cannot be enforced by KICS the way Trivy's `expired_at` and
    osv-scanner's `ignoreUntil` are — the flag has nowhere to put a date. `check()` is
    what enforces it instead: an expired entry fails this script, which fails
    `make verify`, which fails CI. The suppression stops working because the build stops
    working, rather than by quietly becoming permanent.
    """
    entries: list[Entry] = [
        entry
        for entry in (document.get("suppressions") or [])
        if isinstance(entry, dict) and entry.get("tool") == "kics"
    ]
    ids = sorted({str(entry["id"]) for entry in entries})
    return ",".join(ids) + "\n" if ids else "\n"


def main(argv: list[str]) -> int:
    """Entry point: validate the suppressions, then write or verify the generated file."""
    args = [a for a in argv[1:] if not a.startswith("--")]
    write = "--write" in argv[1:]
    path = Path(args[0]) if args else DEFAULT_PATH

    problems = check(path)
    if problems:
        print(f"{len(problems)} suppression problem(s) in {path}:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    document = load(path)
    generated = (
        (TRIVYIGNORE_PATH, render_trivyignore(document)),
        (OSV_CONFIG_PATH, render_osv_config(document)),
        (KICS_EXCLUDE_PATH, render_kics_exclude(document)),
    )

    if write:
        for target, expected in generated:
            # newline="\n" because these files are checked in and `make verify` rejects
            # CRLF; Python's default translation would write it on Windows.
            target.write_text(expected, encoding="utf-8", newline="\n")
        names = ", ".join(target.name for target, _ in generated)
        print(f"suppressions OK ({path}); wrote {names}")
        return 0

    for target, expected in generated:
        actual = target.read_text(encoding="utf-8") if target.exists() else None
        if actual is None:
            print(f"{target.name} is missing - run `make suppressions-write`")
            return 1
        if actual != expected:
            print(
                f"{target.name} does not match {path.name}. Either it was edited by "
                "hand, which is how a finding gets silenced with no owner and no expiry, "
                "or the suppression changed and the file was not regenerated. Run "
                "`make suppressions-write`."
            )
            return 1

    names = ", ".join(target.name for target, _ in generated)
    print(f"suppressions OK ({path}); {names} are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
