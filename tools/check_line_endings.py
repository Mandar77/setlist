r"""Keep CRLF out of the working tree.

`.gitattributes` says `* text=auto eol=lf`, which makes the *index* LF. It does not stop
a tool from writing CRLF into the working tree afterwards, and several will:

* Python's `Path.write_text()` and `open(..., "w")` translate ``\n`` to ``\r\n`` on
  Windows unless you pass ``newline=""``. This is the common one, and it is silent.
* Some editors and PowerShell redirection do the same.

Git then hides the damage: it normalises on commit, so `git diff` is clean while the
file on disk is CRLF. What is not hidden:

* a shell script or git hook with CRLF fails as ``bad interpreter: /usr/bin/env bash^M``
* shellcheck refuses the file outright (SC1017)
* the parser computes character spans, so CRLF shifts every offset after the first line

**Which files are text is git's decision, not ours.** This reads `git ls-files --eol`
rather than sniffing bytes or matching extensions: git already applies `.gitattributes`,
so a file marked `binary` there can never be rewritten by this tool. That matters
because `--fix` edits files in place, and a heuristic that guesses wrong corrupts a
binary silently.

Usage:
    python tools/check_line_endings.py          # report, exit non-zero if any CRLF
    python tools/check_line_endings.py --fix    # rewrite them as LF
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _text_files_with_crlf() -> list[Path]:
    """Tracked files that git treats as text and whose working copy has CRLF.

    `git ls-files --eol` emits, per file::

        i/lf    w/crlf  attr/text=auto eol=lf   path/to/file

    ``i/`` is the index, ``w/`` the working tree, ``attr/`` the resolved gitattributes.
    A binary file reports ``w/-text``, which is exactly what we must never rewrite.
    """
    out = subprocess.run(
        ["git", "ls-files", "--eol", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8", errors="replace")

    found: list[Path] = []
    for entry in out.split("\0"):
        if not entry.strip():
            continue
        # The path is separated from the attribute columns by a tab.
        head, _, rel = entry.partition("\t")
        if not rel:
            continue
        fields = head.split()
        worktree = next((f for f in fields if f.startswith("w/")), "")
        if worktree == "w/crlf":
            found.append(ROOT / rel.strip())
    return found


def fix(paths: list[Path]) -> None:
    """Rewrite each file with LF endings, touching nothing else.

    Byte-level, and deliberately not `read_text`/`write_text`: those would re-encode
    and could reintroduce exactly the translation this tool exists to undo.
    """
    for path in paths:
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b"\r\n", b"\n"))


def main(argv: list[str]) -> int:
    """Entry point."""
    offenders = _text_files_with_crlf()

    if not offenders:
        print("line endings: clean (no CRLF in any tracked text file)")
        return 0

    if "--fix" in argv:
        fix(offenders)
        print(f"line endings: rewrote {len(offenders)} file(s) as LF")
        for path in offenders:
            print(f"  - {path.relative_to(ROOT).as_posix()}")
        return 0

    print(f"line endings: {len(offenders)} tracked text file(s) contain CRLF\n")
    for path in offenders:
        print(f"  - {path.relative_to(ROOT).as_posix()}")
    print(
        "\nRun: python tools/check_line_endings.py --fix"
        '\n\nIf a Python script wrote these, pass newline="\\n" to write_text/open —'
        "\nor better, do not author files from a script at all (see CLAUDE.md)."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
