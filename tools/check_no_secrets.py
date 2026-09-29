"""Scan the working tree, full git history and commit messages for leaked material.

This is **not** a replacement for 2MS — that runs in CI over full history with a far
larger rule set. This exists because `make verify` must work without Docker
(AUTOPILOT §2.6), and because ADR-005 bans more than just credentials from a public
repository: account ids, ARNs, emails and personal data are equally out of bounds and
most secret scanners do not look for them.

Usage:
    python tools/check_no_secrets.py [--history] [--staged]

    (no flags)  working tree only — the fast path for `make verify`
    --staged    also scan the staged diff
    --history   also scan every blob ever committed, plus all commit messages
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

BINARY_SUFFIXES = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
        ".pdf",
        ".onnx",
        ".zip",
        ".age",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".ico",
        ".keystore",
        ".jks",
    }
)
#: Lockfiles are full of long digit runs that trip the account-id heuristic and
#: contain nothing secret by construction.
SKIP_PATHS = ("uv.lock", "pnpm-lock.yaml", "package-lock.json", "poetry.lock")


@dataclass(frozen=True)
class Rule:
    """One detection rule."""

    name: str
    pattern: re.Pattern[str]
    note: str


RULES: tuple[Rule, ...] = (
    Rule(
        "aws-access-key",
        re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"),
        "AWS access key id",
    ),
    Rule(
        "aws-secret-key",
        re.compile(r"(?i)aws.{0,20}secret.{0,20}['\"][0-9a-zA-Z/+]{40}['\"]"),
        "AWS secret access key",
    ),
    # Only flag a 12-digit run when AWS context sits next to it; a bare 12-digit
    # number is almost always a file size or a hash fragment.
    Rule(
        "aws-account-id",
        re.compile(r"(?i)(?:arn:aws[^\s\"']*:|account[_\- ]?id\D{0,12}|:iam::)\s*(\d{12})\b"),
        "AWS account id (ADR-005: these live in GitHub secrets)",
    ),
    Rule("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"), "GitHub token"),
    Rule("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"), "Google API key"),
    Rule("slack-token", re.compile(r"\bxox[abprs]-[0-9A-Za-z\-]{10,}\b"), "Slack token"),
    Rule(
        "private-key",
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
        "private key block",
    ),
    Rule(
        "jwt",
        re.compile(r"\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
        "JSON Web Token",
    ),
    Rule(
        "assigned-secret",
        re.compile(
            r"(?i)\b(?:password|passwd|secret|api_?key|client_?secret|access_?token)"
            r"\s*[:=]\s*['\"][^'\"\s{}$<>]{8,}['\"]"
        ),
        "hardcoded credential",
    ),
    Rule("webhook", re.compile(r"https://hooks\.(?:slack|discord)\.com/\S+"), "webhook URL"),
    Rule(
        "email",
        re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        "email address (ADR-005: no personal data in a public repo)",
    ),
)

#: Documented placeholders and genuinely public identifiers.
ALLOWLIST = re.compile(
    "|".join(
        (
            r"noreply@anthropic\.com",
            r"noreply@github\.com",
            r"users\.noreply\.github\.com",
            r"example\.(?:com|org)",
            r"<[^>]*>",
            r"@fontsource",
            r"@aws-sdk",
            r"@?your[-_]?(?:account|handle|email)",
        )
    )
)


def _findings(label: str, text: str) -> list[tuple[str, str, str, int]]:
    """Return (rule, note, fragment, line) for every unallowlisted match."""
    out: list[tuple[str, str, str, int]] = []
    for rule in RULES:
        for match in rule.pattern.finditer(text):
            fragment = match.group(0)
            if ALLOWLIST.search(fragment):
                continue
            line = text.count("\n", 0, match.start()) + 1
            out.append((rule.name, f"{label}:{line}", fragment[:80], rule.note))  # type: ignore[arg-type]
    return out  # type: ignore[return-value]


def _git(*args: str) -> str:
    """Run a git command and decode its output as UTF-8.

    Never `text=True`: that decodes with the platform locale codec, which on Windows
    is cp1252 and raises on any non-Latin-1 byte. This project's whole subject matter
    is Unicode text, so that failure is guaranteed rather than theoretical.
    """
    completed = subprocess.run(list(args), cwd=ROOT, capture_output=True, check=False)
    return completed.stdout.decode("utf-8", errors="replace")


def _decode(raw: bytes) -> str | None:
    """Decode a blob as UTF-8, or return None if it is binary."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _skip(path: str) -> bool:
    """Whether a path is excluded from scanning."""
    return path.endswith(tuple(BINARY_SUFFIXES)) or any(s in path for s in SKIP_PATHS)


def scan_tree() -> list[tuple[str, str, str, str]]:
    """Scan every tracked file in the working tree."""
    listed = _git("git", "ls-files", "-z")
    results: list[tuple[str, str, str, str]] = []
    for path in filter(None, listed.split("\0")):
        if _skip(path):
            continue
        text = _decode((ROOT / path).read_bytes()) if (ROOT / path).exists() else None
        if text is not None:
            results += _findings(path, text)
    return results


def scan_staged() -> list[tuple[str, str, str, str]]:
    """Scan only the lines the staged diff ADDS.

    Removed lines still appear in a diff, so scanning the raw output would fail the
    build for deleting a secret - exactly the change that should pass.
    """
    diff = _git("git", "diff", "--cached")
    added = "\n".join(
        line[1:]
        for line in diff.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    )
    return _findings("staged-addition", added)


def scan_history() -> list[tuple[str, str, str, str]]:
    """Scan every blob ever committed on any ref, plus all commit messages."""
    listing = _git("git", "rev-list", "--objects", "--all").splitlines()

    results: list[tuple[str, str, str, str]] = []
    for entry in listing:
        sha, _, path = entry.partition(" ")
        if not path or _skip(path):
            continue
        raw = subprocess.run(
            ["git", "cat-file", "-p", sha], cwd=ROOT, capture_output=True, check=False
        ).stdout
        text = _decode(raw)
        if text is not None:
            results += _findings(f"history:{path}", text)

    messages = _git("git", "log", "--all", "--format=%B")
    return results + _findings("commit-message", messages)


def main(argv: list[str]) -> int:
    """Entry point."""
    findings = scan_tree()
    if "--staged" in argv:
        findings += scan_staged()
    if "--history" in argv:
        findings += scan_history()

    seen: set[tuple[str, str]] = set()
    unique = []
    for rule, where, fragment, note in findings:
        key = (rule, fragment)
        if key not in seen:
            seen.add(key)
            unique.append((rule, where, fragment, note))

    if not unique:
        print("no-secrets check: clean")
        return 0

    print(f"no-secrets check: {len(unique)} finding(s)\n")
    for rule, where, fragment, note in unique:
        print(f"  [{rule}] {where}\n      {fragment}\n      {note}\n")
    print("This repository is public. Remove the value, then rotate it if it was ever real.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
