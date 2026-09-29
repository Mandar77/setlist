# HITL queue

Anything Claude Code cannot do lands here **and** as a GitHub issue labelled
`human-needed`. This file is the durable copy: issues can be closed, and a session can
die before it files one.

Claude Code appends; it never rewrites history here.

| Date | Item | Why it needs a human | Issue | Status |
| --- | --- | --- | --- | --- |
| 2026-09-28 | Session 1 — GitHub, AWS account, bootstrap stack, Expo token | Account creation and a console upload; no agent can hold these credentials | not filed yet (no remote) | open |
| 2026-09-28 | Decide the git author identity before the first push | Your commit author email goes into public git history and only you can choose it | not filed yet (no remote) | open |

## Open item: git author identity (decide before the first push)

Nothing has been pushed yet, so this is free to change now and awkward later.

The bootstrap history was scanned (`tools/check_no_secrets.py --history`, plus a
manual pass) and is clean of credentials. One piece of personal data remains by
construction: **your commit author email**, which git records on every commit and
GitHub displays publicly.

Two options, both fine:

1. **Keep your real email.** Normal open-source practice. No action needed.
2. **Use GitHub's noreply address**, which keeps your address off the public record:

   ```bash
   git config user.email "<your-id>+<your-handle>@users.noreply.github.com"
   git commit --amend --reset-author --no-edit     # rewrite the single existing commit
   ```

   Find the exact address at GitHub → Settings → Emails → "Keep my email address
   private". Do this **before** `github-setup.sh` pushes, and the old address never
   reaches GitHub at all.

`tools/check_no_secrets.py` deliberately allowlists `users.noreply.github.com`, so
option 2 also makes the CI hygiene job clean on history forever.

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
