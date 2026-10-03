"""The oracle's two promises: the CLI is callable from outside, and it does not move.

Both are about CORE-04. The TypeScript port will be checked against this implementation
by running both over the same text and diffing, which only works if the oracle can be
driven from another language — a subprocess reading stdin and printing JSON — and only
means anything if the oracle's output is a fixed point rather than whatever it happens
to produce today.

So the subprocess is exercised for real here rather than through `run()` directly. The
import path, the argument parsing, the stdin decoding and the trailing newline are all
part of the contract a Vitest suite will depend on, and none of them are covered by
calling the function.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ORACLE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ORACLE))

import golden  # noqa: E402

from setlist_core.cli import SCHEMA_VERSION, dumps, render  # noqa: E402
from setlist_core.pipeline import extract_deterministic  # noqa: E402

SAMPLE = "1. Daft Punk - One More Time\n2. Justice - Genesis (Live)\n"


def _cli(text: str, *args: str) -> subprocess.CompletedProcess[bytes]:
    """Run the CLI as a real subprocess, the way another language would."""
    return subprocess.run(
        [sys.executable, "-m", "setlist_core.cli", *args],
        input=text.encode("utf-8"),
        capture_output=True,
        check=False,
    )


# ------------------------------------------------------------------ the interface


def test_the_cli_reads_stdin_and_prints_json() -> None:
    done = _cli(SAMPLE, "--source-kind", "printed")
    assert done.returncode == 0, done.stderr.decode()
    payload = json.loads(done.stdout.decode("utf-8"))
    assert [item["title"] for item in payload["items"]] == ["One More Time", "Genesis"]


def test_the_output_is_utf8_with_one_trailing_newline() -> None:
    # A port diffing bytes has to know exactly what it is comparing against. One
    # trailing newline, so the file is POSIX-clean, and no second one.
    done = _cli("Sigur Rós - Hoppípolla\n", "--source-kind", "printed")
    assert done.stdout.endswith(b"}\n")
    assert not done.stdout.endswith(b"}\n\n")
    assert "Hoppípolla".encode() in done.stdout


def test_source_kind_is_required() -> None:
    # Not optional even though nothing branches on it yet. A flag that appears later is
    # a breaking change to every caller; a flag that is ignored for now is not.
    done = _cli(SAMPLE)
    assert done.returncode != 0
    assert b"--source-kind" in done.stderr


def test_an_unknown_source_kind_is_refused() -> None:
    done = _cli(SAMPLE, "--source-kind", "interpretive-dance")
    assert done.returncode != 0


def test_oversized_input_exits_two_rather_than_crashing() -> None:
    done = _cli("x" * 200, "--source-kind", "printed", "--max-input-bytes", "100")
    assert done.returncode == 2
    assert b"limit is 100" in done.stderr
    assert done.stdout == b""


def test_the_schema_version_is_carried_in_the_output() -> None:
    # So that a shape change cannot be mistaken for a behaviour change by whatever is
    # diffing against this.
    payload = json.loads(_cli(SAMPLE, "--source-kind", "printed").stdout)
    assert payload["schema"] == SCHEMA_VERSION


# ------------------------------------------------------------------ determinism


def test_two_runs_agree_byte_for_byte() -> None:
    first = _cli(SAMPLE, "--source-kind", "printed").stdout
    second = _cli(SAMPLE, "--source-kind", "printed").stdout
    assert first == second


def test_keys_are_sorted_at_every_level() -> None:
    payload = json.loads(_cli(SAMPLE, "--source-kind", "printed").stdout)

    def check(node: object, path: str = "$") -> None:
        if isinstance(node, dict):
            keys = list(node)
            assert keys == sorted(keys), f"{path} is not sorted: {keys}"
            for key, value in node.items():
                check(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                check(value, f"{path}[{index}]")

    check(payload)


def test_qualifiers_are_sorted_rather_than_set_ordered() -> None:
    # `Hints.qualifiers` is a frozenset. Whatever order Python iterates it in is a
    # hash-table detail, and a TypeScript port has no way to reproduce it — nor should
    # it have to.
    text = "Queen - Bohemian Rhapsody (Live) (Remastered)\n"
    payload = json.loads(_cli(text, "--source-kind", "printed").stdout)
    qualifiers = payload["items"][0]["hints"]["qualifiers"]
    assert qualifiers == sorted(qualifiers)
    assert len(qualifiers) >= 2, "this case is meant to produce more than one qualifier"


def test_non_ascii_is_emitted_literally() -> None:
    # ensure_ascii=False. Otherwise a transliteration bug and an escaping difference
    # look identical in a diff, and only one of them is a bug.
    rendered = dumps(render(extract_deterministic("Björk - Hyperballad\n"), source_kind="printed"))
    assert "Björk" in rendered
    assert "\\u00f6" not in rendered


# ------------------------------------------------------------------ the freeze


def test_every_golden_case_reproduces_byte_for_byte() -> None:
    assert golden.problems() == []


def test_there_is_something_to_reproduce() -> None:
    # The control. `problems()` reports by absence, so a bug that made it read no cases
    # would return an empty list and pass the test above while checking nothing.
    assert len(golden.cases()) >= 8


@pytest.mark.parametrize("identifier", [c[0] for c in golden.cases()])
def test_each_frozen_output_is_committed(identifier: str) -> None:
    assert (golden.OUTPUT_DIR / f"{identifier}.json").exists()
