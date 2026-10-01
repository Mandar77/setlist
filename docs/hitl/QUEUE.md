# HITL queue

Anything Claude Code cannot do lands here **and** as a GitHub issue labelled
`human-needed`. This file is the durable copy: issues can be closed, and a session can
die before it files one.

Claude Code appends; it never rewrites history here.

| Date | Item | Why it needs a human | Issue | Status |
| --- | --- | --- | --- | --- |
| 2026-09-28 | Session 1 — GitHub, AWS account, bootstrap stack, Expo token | Account creation and a console upload; no agent can hold these credentials | not filed yet (no remote) | open |
| 2026-09-28 | Decide the git author identity before the first push | Your commit author email goes into public git history and only you can choose it | not filed yet (no remote) | open |

## Open item: git author identity — **blocks the first push**

`scripts/hitl/scan-secrets.sh` now refuses to push until this is decided, so it is a
hard gate rather than a note.

The history is clean of credentials. One piece of personal data remains by
construction: **the commit author email**, which git records on every commit and GitHub
publishes. It is the only such datum here that no scanner catches — 2MS reads diff
content and never looks at author or committer headers, so before this gate existed the
scan printed "clean" about the one thing it could not see.

Two options, both legitimate. Full instructions in
[SESSION-1.md step 1b](SESSION-1.md).

| | What to do | Effect |
| --- | --- | --- |
| **A. Publish it** | Add the address to `security/published-identities.txt` | Normal open-source practice; becomes a recorded decision rather than an accident |
| **B. Keep it private** | Switch to the GitHub noreply address, then rewrite history with `git filter-repo` | The address never reaches GitHub |

For option B, note that `git commit --amend` rewrites **only the tip commit** — not the
earlier ones, and not `main`. SESSION-1.md gives the `git filter-repo` command that
rewrites all of them.

Either way, decide before the first push. Afterwards neither option exists: the address
is permanent in forks, clones and the GitHub events API.

## Recurring reasons an item appears here

Per AUTOPILOT §2.4, Claude Code stops and files an issue when:

- an action costs money, upgrades a plan, or accepts third-party terms;
- an account, app, OAuth client or key must be created, or a secret entered;
- a cost, quality or security gate would be relaxed — including the kill switch,
  budgets, IAM guardrails or any PED target (an ADR proposal with evidence is attached);
- a high or critical finding would be suppressed beyond the PED suppression rules;
- anything would touch prod, or the prod kill switch needs resetting;
- auto mode blocks the same action repeatedly.

The last one is worth watching: a rule that blocks legitimate work every day is a rule
worth discussing, and the queue is where that pattern becomes visible.
