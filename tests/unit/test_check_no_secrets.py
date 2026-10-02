"""Tests for the secret scanner, which until now had none.

That absence is why this file exists. ``scan_tree`` listed only TRACKED files, so a
brand-new file was invisible on the one run that matters most — the ``make verify``
before its first commit, while the file is still untracked. An AWS account id reached
``develop`` that way, and the gate printed "clean" on both runs it was asked for.

Every test here builds a throwaway git repository and points the scanner at it, because
the question is specifically about how git reports files, and a fake in place of git
would answer a different question.

Note the secrets below are assembled by concatenation rather than written out. The
scanner scans this repository, this file included, and a literal twelve-digit account id
in a test fixture would fail the very gate it is testing — as the comment explaining the
fixtures in ``infra/nag/test/fixtures.ts`` already did once.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import check_no_secrets as scanner

#: A value the scanner must flag, built so the literal never appears in this file.
FAKE_ACCOUNT_ARN = "arn:aws:iam::" + "9" * 12 + ":role/example"


def _run(repo: Path, *args: str) -> None:
    # S603: every argument here is a literal in this file, and the point of the test is
    # to drive real git rather than a stand-in that would answer a different question.
    subprocess.run(args, cwd=repo, check=True, capture_output=True)  # noqa: S603


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A real git repository the scanner is pointed at."""
    _run(tmp_path, "git", "init", "-q")
    # Committing needs an identity; a noreply address keeps the scanner's own identity
    # check happy if it is ever pointed here.
    _run(tmp_path, "git", "config", "user.email", "test@users.noreply.github.com")
    _run(tmp_path, "git", "config", "user.name", "Test")

    # Both the module constant and the cwd `_git` passes to subprocess.
    monkeypatch.setattr(scanner, "ROOT", tmp_path)
    return tmp_path


def _findings_for(repo: Path) -> list[str]:
    """The paths flagged, from findings shaped (rule, "path:line", fragment, note)."""
    return [location.rsplit(":", 1)[0] for _, location, _, _ in scanner.scan_tree()]


def test_untracked_file_is_scanned(repo: Path) -> None:
    """The regression: a new file is unscanned exactly when it matters most."""
    (repo / "brand_new.ts").write_text(f"const role = '{FAKE_ACCOUNT_ARN}'\n", newline="\n")

    assert "brand_new.ts" in _findings_for(repo), (
        "an untracked file was not scanned — this is the hole that let an account id "
        "reach develop while `make verify` printed clean"
    )


def test_tracked_file_is_scanned(repo: Path) -> None:
    """The control. Without it, a scanner that found nothing at all would pass above."""
    (repo / "committed.ts").write_text(f"const role = '{FAKE_ACCOUNT_ARN}'\n", newline="\n")
    _run(repo, "git", "add", "committed.ts")
    _run(repo, "git", "commit", "-qm", "add")

    assert "committed.ts" in _findings_for(repo)


def test_clean_untracked_file_is_not_flagged(repo: Path) -> None:
    """The other control: flagging everything is not the same as working."""
    (repo / "harmless.ts").write_text("export const greeting = 'hello'\n", newline="\n")

    assert _findings_for(repo) == []


def test_ignored_files_are_not_scanned(repo: Path) -> None:
    """`.gitignore` is still honoured, or the scan would walk .venv and node_modules.

    Safe as well as fast: a file git refuses to track cannot be committed, so it cannot
    leak through this repository.
    """
    (repo / ".gitignore").write_text("secrets/\n", newline="\n")
    (repo / "secrets").mkdir()
    (repo / "secrets" / "local.ts").write_text(f"const role = '{FAKE_ACCOUNT_ARN}'\n", newline="\n")

    assert _findings_for(repo) == []


def test_a_file_listed_twice_is_reported_once(repo: Path) -> None:
    """Tracked and modified is not two findings for one line."""
    (repo / "both.ts").write_text(f"const role = '{FAKE_ACCOUNT_ARN}'\n", newline="\n")
    _run(repo, "git", "add", "both.ts")

    assert _findings_for(repo).count("both.ts") == 1


def test_a_real_looking_account_id_is_still_flagged(repo: Path) -> None:
    """The documentation-account allowlist must not blunt the rule.

    `123456789012` is AWS's reserved example account and is allowlisted, which gives up
    nothing -- but an allowlist is exactly the kind of change that quietly turns a rule
    off, so this pins the other side of it.
    """
    (repo / "real.ts").write_text(f"const role = '{FAKE_ACCOUNT_ARN}'\n", newline="\n")

    assert "real.ts" in _findings_for(repo)


def test_the_documentation_account_is_allowlisted(repo: Path) -> None:
    """And the example account is not, so AWS's own snippets do not fail the build."""
    doc_arn = "arn:aws:iam::" + "123456789012" + ":role/example"
    (repo / "docs.ts").write_text(f"const role = '{doc_arn}'\n", newline="\n")

    assert _findings_for(repo) == []


def test_the_identities_file_may_hold_an_address(repo: Path) -> None:
    """The file where publishing an address is DECLARED cannot fail the email rule.

    Otherwise the gate objects to its own paperwork. The identity check governs that
    file instead, by requiring every address in commit metadata to appear in it.
    """
    # Composed, not written out, for the reason in this module's docstring: an address
    # the allowlist does not cover would fail the scan of this very file. It also has
    # to be one the allowlist misses, or the test would pass for the wrong reason.
    address = "someone" + "@" + "setlist.invalid"
    (repo / "security").mkdir()
    (repo / "security" / "published-identities.txt").write_text(f"{address}\n", newline="\n")

    assert _findings_for(repo) == []


def test_git_failure_is_not_a_clean_scan(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A gate must not report success because it could not look.

    Empty stdout reads as "nothing found", so a git that is missing or a corrupt
    checkout would otherwise render as a clean scan and a zero exit.

    A real directory that is not a repository, rather than a missing one: a missing
    path makes `subprocess` raise before git runs, which tests the wrong thing — the
    property here is that git EXITING non-zero is not mistaken for silence.
    """
    plain = repo.parent / "not-a-repo"
    plain.mkdir(exist_ok=True)
    monkeypatch.setattr(scanner, "ROOT", plain)

    with pytest.raises(scanner.GitUnavailableError):
        scanner.scan_tree()
