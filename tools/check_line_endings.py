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

## Control bytes, same idea and the same file list

A text file should not contain a NUL, a backspace, or any other C0 control byte. This has
now happened twice in this repository, both times the same way: a ``\u0000`` escape
written through a file-authoring tool that decodes escapes, leaving a literal 0x00 in
committed TypeScript. It is invisible in review, it survives every other gate, and the
code keeps working - which is what makes it worth a check rather than a habit.

The earlier instance was a 0x08 backspace: ``C:\MinGW\bin`` became ``C:\MinGW<0x08>in``
when a heredoc ate the escape.

Tab, LF and CR are allowed; CR on its own is left to the CRLF check above. Everything
else in 0x00-0x1F, plus DEL, is rejected. There is no ``--fix``: deleting a control byte
is a guess about what was meant, and the two real cases wanted different repairs.

Usage:
    python tools/check_line_endings.py          # report; non-zero if anything is wrong
    python tools/check_line_endings.py --fix    # rewrite CRLF as LF (never control bytes)
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


#: C0 controls minus tab, LF and CR, plus DEL. Bytes, not characters: this reads files as
#: bytes so that a file which is not valid UTF-8 is reported rather than crashing the
#: check that was supposed to find the problem.
FORBIDDEN_BYTES = frozenset(range(0x00, 0x20)) - {0x09, 0x0A, 0x0D} | {0x7F}

#: How many hits to print per file before summarising. One decoded escape usually means
#: many, and a wall of identical lines buries the filename that is the actionable part.
MAX_HITS_SHOWN = 5


def _tracked_text_files() -> list[Path]:
    """Every tracked file git resolves as text.

    Shares `git ls-files --eol` with the CRLF check for the same reason: which files are
    text is git's decision, and a separate heuristic here would eventually disagree with
    the one above on some file and make one of the two checks wrong.
    """
    out = subprocess.run(
        ["git", "ls-files", "--eol", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8", errors="replace")

    files: list[Path] = []
    for entry in out.split("\0"):
        if not entry.strip():
            continue
        head, _, rel = entry.partition("\t")
        if not rel:
            continue
        fields = head.split()
        worktree = next((f for f in fields if f.startswith("w/")), "")
        # `w/-text` is git's marker for binary. Never inspected: a PNG is full of these
        # bytes by definition and reporting it would train people to ignore this check.
        if worktree != "w/-text":
            files.append(ROOT / rel.strip())
    return files


def control_bytes(path: Path) -> list[tuple[int, int, str]]:
    """Forbidden bytes in one file, as (offset, byte, printable context)."""
    try:
        raw = path.read_bytes()
    except OSError:
        return []

    found: list[tuple[int, int, str]] = []
    for offset, value in enumerate(raw):
        if value in FORBIDDEN_BYTES:
            # A window of surrounding text, so the report names the LINE rather than just
            # an offset nobody can act on. Decoded leniently: the file may not be valid
            # UTF-8, and that is not this function's problem to raise.
            window = raw[max(0, offset - 30) : offset + 30]
            context = window.decode("utf-8", errors="replace").replace("\n", "\\n")
            found.append((offset, value, context))
    return found


def _files_with_control_bytes() -> list[tuple[Path, list[tuple[int, int, str]]]]:
    """Tracked text files containing a forbidden control byte."""
    offenders = []
    for path in _tracked_text_files():
        hits = control_bytes(path)
        if hits:
            offenders.append((path, hits))
    return offenders


def fix(paths: list[Path]) -> None:
    """Rewrite each file with LF endings, touching nothing else.

    Byte-level, and deliberately not `read_text`/`write_text`: those would re-encode
    and could reintroduce exactly the translation this tool exists to undo.
    """
    for path in paths:
        raw = path.read_bytes()
        path.write_bytes(raw.replace(b"\r\n", b"\n"))


def _report_control_bytes() -> int:
    """Report forbidden control bytes. Never auto-fixed; see the module docstring."""
    offenders = _files_with_control_bytes()
    if not offenders:
        print("control bytes: clean (no NUL or C0 control in any tracked text file)")
        return 0

    total = sum(len(hits) for _, hits in offenders)
    print(f"control bytes: {total} forbidden byte(s) in {len(offenders)} tracked text file(s)\n")
    for path, hits in offenders:
        print(f"  {path.relative_to(ROOT).as_posix()}")
        for offset, value, context in hits[:MAX_HITS_SHOWN]:
            print(f"    byte 0x{value:02X} at offset {offset}: ...{context}...")
        if len(hits) > MAX_HITS_SHOWN:
            print(f"    ... and {len(hits) - MAX_HITS_SHOWN} more")
    print(
        "\nNot auto-fixed: removing a control byte is a guess about what was meant."
        "\n\nThe usual cause is a `\\u0000`-style escape written through a tool that"
        "\ndecodes escapes, leaving a literal byte in the source. Build the character"
        "\ninstead — `String.fromCharCode(0)`, `chr(0)` — so the file stays readable."
    )
    return 1


def main(argv: list[str]) -> int:
    """Entry point: CRLF first, then control bytes. Both must pass."""
    offenders = _text_files_with_crlf()

    if offenders and "--fix" in argv:
        fix(offenders)
        print(f"line endings: rewrote {len(offenders)} file(s) as LF")
        for path in offenders:
            print(f"  - {path.relative_to(ROOT).as_posix()}")
        offenders = []

    if offenders:
        print(f"line endings: {len(offenders)} tracked text file(s) contain CRLF\n")
        for path in offenders:
            print(f"  - {path.relative_to(ROOT).as_posix()}")
        print(
            "\nRun: python tools/check_line_endings.py --fix"
            '\n\nIf a Python script wrote these, pass newline="\\n" to write_text/open —'
            "\nor better, do not author files from a script at all (see CLAUDE.md)."
        )
    else:
        print("line endings: clean (no CRLF in any tracked text file)")

    # Both run, and both report, before the exit code is decided: fixing one and being
    # told about the other on the next run is two round trips for one commit.
    control = _report_control_bytes()
    return 1 if offenders or control else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
