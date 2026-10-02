"""Scan the working tree, full git history and commit messages for leaked material.

This is **not** a replacement for 2MS — that runs in CI over full history with a far
larger rule set. This exists because `make verify` must work without Docker
(AUTOPILOT §2.6), and because ADR-005 bans more than just credentials from a public
repository: account ids, ARNs, emails and personal data are equally out of bounds and
most secret scanners do not look for them.

Usage:
    python tools/check_no_secrets.py [--history] [--staged]

    (no flags)  working tree only — the fast path for `make verify`
    --staged    also scan the lines the staged diff ADDS
    --history   also scan every blob ever committed, all commit messages, and every
                commit's author/committer identity

A note on identities. `git log --format=%B` is the commit *body*; it never includes
`%ae`/`%ce`. 2MS reads diff content, so it does not see identity headers either. That
leaves the author email — which git stamps on every commit and GitHub publishes — as
the one piece of personal data in this repository that no scanner looks at, while the
gate prints "clean". `--history` therefore checks identities against
`security/published-identities.txt`, so publishing your real address is a decision
recorded in a reviewed file rather than something nobody noticed.
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
            # `support@github.com` appears in every Dependabot commit message, in the
            # boilerplate about triggering it by comment. It is GitHub's own published
            # address and identifies nobody -- but the rule is right to look at commit
            # messages, so the answer is to name the address rather than stop looking.
            r"(?:noreply|support)@github\.com",
            r"users\.noreply\.github\.com",
            r"example\.(?:com|org)",
            r"<[^>]*>",
            r"@fontsource",
            r"@aws-sdk",
            r"@?your[-_]?(?:account|handle|email)",
            # AWS's reserved documentation account. It appears in every AWS example and
            # cannot be a real account, so allowlisting this exact value gives up
            # nothing: a genuinely leaked id will never be these twelve digits. Narrow
            # on purpose - the rule still fires on any other 12-digit run next to AWS
            # context, which is what it is for.
            r"\b123456789012\b",
        )
    )
)

#: Rules that must not fire inside a given path, because that path's whole purpose is
#: to hold the thing the rule looks for.
#:
#: `security/published-identities.txt` is the file where publishing an address is
#: declared. The email rule flagging it is the gate objecting to its own paperwork --
#: and the identity check below governs that file properly, by requiring every address
#: in commit metadata to appear in it.
RULE_EXEMPT_PATHS: tuple[tuple[str, str], ...] = (("email", "security/published-identities.txt"),)


#: One finding: (rule name, "where:line", the matched fragment, why it matters).
Finding = tuple[str, str, str, str]


def _findings(label: str, text: str) -> list[Finding]:
    """Return a finding for every unallowlisted match."""
    out: list[Finding] = []
    for rule in RULES:
        if any(rule.name == name and path in label for name, path in RULE_EXEMPT_PATHS):
            continue
        for match in rule.pattern.finditer(text):
            fragment = match.group(0)
            if ALLOWLIST.search(fragment):
                continue
            line = text.count("\n", 0, match.start()) + 1
            out.append((rule.name, f"{label}:{line}", fragment[:80], rule.note))
    return out


class GitUnavailableError(RuntimeError):
    """A git command this scan depends on failed."""


def _git(*args: str, allow_failure: bool = False) -> str:
    """Run a git command and decode its output as UTF-8.

    Never `text=True`: that decodes with the platform locale codec, which on Windows
    is cp1252 and raises on any non-Latin-1 byte. This project's whole subject matter
    is Unicode text, so that failure is guaranteed rather than theoretical.

    Raises on a non-zero exit unless `allow_failure`. A swallowed git failure is the
    worst outcome available here: empty stdout reads as "nothing found", so a missing
    checkout, a git that is not on PATH, or a corrupt pack would each render as a clean
    scan and a zero exit — a gate reporting success precisely because it could not look.
    """
    completed = subprocess.run(list(args), cwd=ROOT, capture_output=True, check=False)
    if completed.returncode != 0 and not allow_failure:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        msg = f"`{' '.join(args)}` failed with exit {completed.returncode}: {detail}"
        raise GitUnavailableError(msg)
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


def scan_tree() -> list[Finding]:
    """Scan every tracked file in the working tree, plus every new one.

    `--others` is not an optimisation, it closes a hole that this check fell into
    itself. `git ls-files` with no flags lists only TRACKED files, so a brand-new file
    was invisible to the scan on the one run that matters most - the `make verify`
    before its first commit, while it is still untracked. An account id reached
    `develop` that way, and `make verify` printed "clean" both times it was asked.

    `--exclude-standard` keeps .gitignore honoured, so build output and .venv are
    still skipped. Files that are ignored cannot be committed, so they cannot leak.
    """
    tracked = _git("git", "ls-files", "-z")
    untracked = _git("git", "ls-files", "-z", "--others", "--exclude-standard")

    results: list[Finding] = []
    seen: set[str] = set()
    for path in filter(None, tracked.split("\0") + untracked.split("\0")):
        if path in seen or _skip(path):
            continue
        seen.add(path)
        text = _decode((ROOT / path).read_bytes()) if (ROOT / path).exists() else None
        if text is not None:
            results += _findings(path, text)
    return results


def scan_staged() -> list[Finding]:
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


IDENTITIES_FILE = ROOT / "security" / "published-identities.txt"

#: Identities that are inherently non-identifying, so they never need declaring.
_ALWAYS_OK_IDENTITY = re.compile(
    r"(users\.noreply\.github\.com|noreply@github\.com|noreply@anthropic\.com)$",
    re.IGNORECASE,
)


def _published_identities() -> set[str]:
    """Email addresses the repository has deliberately chosen to publish."""
    if not IDENTITIES_FILE.exists():
        return set()
    declared: set[str] = set()
    for line in IDENTITIES_FILE.read_text(encoding="utf-8").splitlines():
        entry = line.split("#", 1)[0].strip().lower()
        if entry:
            declared.add(entry)
    return declared


def scan_identities() -> list[Finding]:
    """Check every commit's author and committer address against the allowlist.

    This is separate from the pattern rules because it is not pattern matching: the
    question is not "does this look like an email" but "did anyone decide to publish
    this one".
    """
    raw = _git("git", "log", "--all", "--format=%ae%n%ce")
    addresses = {line.strip().lower() for line in raw.splitlines() if line.strip()}
    declared = _published_identities()

    findings: list[Finding] = []
    for address in sorted(addresses):
        if _ALWAYS_OK_IDENTITY.search(address) or address in declared:
            continue
        count = sum(
            1
            for line in _git("git", "log", "--all", "--format=%ae%n%ce").splitlines()
            if line.strip().lower() == address
        )
        findings.append(
            (
                "commit-identity",
                f"git history ({count} author/committer header(s))",
                address,
                "an undeclared identity in commit metadata — no scanner sees this, and "
                "it cannot be changed after a push",
            )
        )
    return findings


def scan_history() -> list[Finding]:
    """Scan every blob ever committed on any ref, plus all commit messages."""
    listing = _git("git", "rev-list", "--objects", "--all").splitlines()

    results: list[Finding] = []
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
    return results + _findings("commit-message", messages) + scan_identities()


def main(argv: list[str]) -> int:
    """Entry point."""
    try:
        findings = scan_tree()
        if "--staged" in argv:
            findings += scan_staged()
        if "--history" in argv:
            findings += scan_history()
    except GitUnavailableError as exc:
        # Fail loudly rather than reporting a clean scan we never performed.
        print(f"no-secrets check: could not run — {exc}")
        return 1

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

    if any(rule == "commit-identity" for rule, _, _, _ in unique):
        print(
            "\nFor a commit-identity finding the value is in commit metadata, so there is"
            "\nnothing to 'remove' from a file. Choose one, before the first push:"
            "\n"
            "\n  Publish it      — add the address to security/published-identities.txt."
            "\n                    Normal open-source practice; it becomes a recorded"
            "\n                    decision rather than an accident."
            "\n"
            "\n  Keep it private — switch to GitHub's noreply address and rewrite the"
            "\n                    commits that already carry it. See docs/hitl/SESSION-1.md"
            "\n                    step 1b; note that `commit --amend` rewrites only the tip,"
            "\n                    so it is not enough on its own."
            "\n"
            "\nAfter a push neither option is available: the address is permanent in forks,"
            "\nclones and the GitHub events API."
        )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
