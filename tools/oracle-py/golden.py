"""Freeze the oracle's output over the golden inputs, byte for byte.

The accuracy gate in ``tests/accuracy`` scores normalized (title, artist) pairs against
a tolerance band, on purpose: an extractor is allowed to move "(Live)" into hints or
transliterate an accent, and asserting on exact strings there would turn every
legitimate improvement into a failing test.

This is the opposite instrument, for the opposite reason. ``tools/oracle-py`` is the
reference implementation CORE-04's TypeScript port will be diffed against, and a
reference that drifts proves nothing — "the port matches the oracle" is only a claim
about the port if the oracle is a fixed point. So every byte is pinned: spans,
confidences to the last digit, hint fields that are null, the order the residual comes
out in. Anything that changes any of them fails here, and the fix is to decide whether
the change was meant and run `make -C tools/oracle-py golden-write` if it was.

Usage:
    python tools/oracle-py/golden.py            # check; non-zero if anything moved
    python tools/oracle-py/golden.py --write    # regenerate, deliberately
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INPUT_DIR = REPO_ROOT / "golden" / "extraction"
OUTPUT_DIR = REPO_ROOT / "golden" / "oracle"

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from setlist_core.cli import dumps, render  # noqa: E402
from setlist_core.pipeline import extract_deterministic  # noqa: E402


def cases() -> list[tuple[str, str, str]]:
    """Every golden case as ``(id, source_kind, text)``, in a stable order.

    Sorted by id rather than by file order so that adding a case in the middle of
    ``printed.json`` does not reshuffle anything already frozen.
    """
    found: list[tuple[str, str, str]] = []
    for path in sorted(INPUT_DIR.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document.get("cases", []):
            found.append((case["id"], case.get("kind", "printed"), case["text"]))
    found.sort()

    identifiers = [identifier for identifier, _, _ in found]
    duplicates = {i for i in identifiers if identifiers.count(i) > 1}
    if duplicates:
        msg = f"golden case ids must be unique across files; repeated: {sorted(duplicates)}"
        raise ValueError(msg)
    return found


def expected(text: str, source_kind: str) -> str:
    """What the oracle produces for one case, as the bytes that get committed."""
    result = extract_deterministic(text)
    return dumps(render(result, source_kind=source_kind)) + "\n"


def write() -> int:
    """Regenerate every frozen output."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    known = set()
    for identifier, source_kind, text in cases():
        path = OUTPUT_DIR / f"{identifier}.json"
        # newline="\n" because these are committed and `make verify` rejects CRLF;
        # Python's default translation would write it on Windows.
        path.write_text(expected(text, source_kind), encoding="utf-8", newline="\n")
        known.add(path.name)

    # A case removed from the input must lose its frozen output too, or the tree keeps
    # a file that nothing generates and nothing checks.
    stale = [p for p in OUTPUT_DIR.glob("*.json") if p.name not in known]
    for path in stale:
        path.unlink()

    print(f"oracle golden: wrote {len(known)} case(s), removed {len(stale)} stale")
    return 0


def problems() -> list[str]:
    """Every way the committed outputs differ from what the oracle produces now."""
    found: list[str] = []
    known = set()
    for identifier, source_kind, text in cases():
        path = OUTPUT_DIR / f"{identifier}.json"
        known.add(path.name)
        if not path.exists():
            found.append(
                f"{identifier}: no frozen output - run `make -C tools/oracle-py golden-write`"
            )
            continue
        actual = path.read_text(encoding="utf-8")
        if actual != expected(text, source_kind):
            found.append(f"{identifier}: the oracle no longer reproduces its frozen output")

    if OUTPUT_DIR.exists():
        for path in sorted(OUTPUT_DIR.glob("*.json")):
            if path.name not in known:
                found.append(f"{path.name}: frozen output for a case that no longer exists")

    if not known:
        found.append(f"no golden cases found under {INPUT_DIR} - this check read nothing")
    return found


def main(argv: list[str]) -> int:
    """Entry point: check, or regenerate with ``--write``."""
    if "--write" in argv[1:]:
        return write()

    found = problems()
    if found:
        print(f"oracle golden: {len(found)} problem(s):")
        for problem in found:
            print(f"  - {problem}")
        return 1
    print(f"oracle golden: {len(cases())} case(s) reproduce byte for byte")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
