"""The control-byte half of `tools/check_line_endings.py`.

Both directions, per the house rule. The must-FAIL direction is the one that matters
here: this check exists because two literal NUL bytes reached committed TypeScript and
nothing noticed, so a version of it that silently matched nothing would reproduce exactly
the failure it was written for.

The CRLF half is exercised by `make verify` against the whole tree on every run and by
`--fix`, which is a destructive path better covered by the real file list than by a
fixture.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import check_line_endings as checker


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_a_nul_byte_is_found(tmp_path: Path) -> None:
    # The exact shape that got through twice: a `\u0000` escape decoded into the file by
    # a tool that writes escapes literally.
    path = _write(tmp_path, "metrics.ts", b"const SEPARATOR = '\x00'\n")
    hits = checker.control_bytes(path)
    assert [value for _, value, _ in hits] == [0x00]


def test_a_backspace_is_found(tmp_path: Path) -> None:
    # The other real one: `C:\MinGW\bin` became `C:\MinGW<0x08>in` through a heredoc.
    path = _write(tmp_path, "notes.md", b"C:\\MinGW\x08in\n")
    assert [value for _, value, _ in checker.control_bytes(path)] == [0x08]


def test_clean_text_is_not_flagged(tmp_path: Path) -> None:
    # The control direction. A check that flags everything is indistinguishable from a
    # strict one until it blocks something legitimate.
    path = _write(tmp_path, "clean.ts", b"const x = 1\n\tconst y = 2\r\n")
    assert checker.control_bytes(path) == []


@pytest.mark.parametrize("allowed", [b"\t", b"\n", b"\r"])
def test_tab_newline_and_carriage_return_are_allowed(tmp_path: Path, allowed: bytes) -> None:
    # CR is left to the CRLF check rather than being rejected here, so that one problem
    # is reported by one tool with one fix.
    path = _write(tmp_path, "ws.txt", b"a" + allowed + b"b")
    assert checker.control_bytes(path) == []


def test_every_other_c0_byte_is_rejected(tmp_path: Path) -> None:
    # Enumerated rather than spot-checked: the set is the contract, and a membership bug
    # would otherwise show up only on whichever byte nobody thought to test.
    for value in range(0x00, 0x20):
        if value in (0x09, 0x0A, 0x0D):
            continue
        path = _write(tmp_path, f"b{value}.txt", bytes([0x61, value, 0x62]))
        assert [v for _, v, _ in checker.control_bytes(path)] == [value], hex(value)


def test_del_is_rejected(tmp_path: Path) -> None:
    path = _write(tmp_path, "del.txt", b"a\x7fb")
    assert [v for _, v, _ in checker.control_bytes(path)] == [0x7F]


def test_the_report_names_a_line_rather_than_only_an_offset(tmp_path: Path) -> None:
    # An offset into a minified file is not actionable. The context window is what makes
    # the failure fixable without a hex editor.
    path = _write(tmp_path, "ctx.ts", b"const key = title + '\x00' + artist\n")
    _, _, context = checker.control_bytes(path)[0]
    assert "title" in context
    assert "artist" in context


def test_invalid_utf8_is_reported_rather_than_crashing(tmp_path: Path) -> None:
    # The check that finds the problem must not be the thing that breaks on it. A file
    # that is not valid UTF-8 is exactly the kind this is meant to inspect.
    path = _write(tmp_path, "bad.txt", b"\xff\xfe\x00text")
    assert [v for _, v, _ in checker.control_bytes(path)] == [0x00]


def test_the_repository_itself_is_clean() -> None:
    # The live assertion, so this suite fails if a control byte is committed — not only
    # when someone remembers to run the gate.
    assert checker._files_with_control_bytes() == []
