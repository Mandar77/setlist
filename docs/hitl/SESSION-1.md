# Session 1 — GitHub, AWS account, bootstrap stack, Expo

**About 40 minutes. Nothing deploys to the cloud until this is done**, but everything
that can be built offline carries on in the meantime, so there is no rush.

Run the scripts in an ordinary terminal in the repo folder — **not** in the Claude
chat. Every script supports `--dry-run`; use it first if you want to see what it will
do.

When you finish, close the `human-needed` issue for H1 and type `/autopilot`.

---

## 1. Tools (5 min)

Install whatever is missing. Docker is optional — it is only needed to run the KICS
security scan locally, and CI runs it anyway.

| Tool | Check | Status on this machine |
| --- | --- | --- |
| git | `git --version` | present |
| GitHub CLI | `gh --version` | present, already authenticated |
| Node LTS | `node --version` | present (v24) |
| uv | `uv --version` | present |

If `gh auth status` ever shows you as logged out, run `gh auth login`.

## 1b. Decide your public git identity (1 min, before anything is pushed)

Git stamps your author email on every commit, and GitHub shows it publicly. Nothing
has been pushed yet, so this is free to change now and awkward afterwards.

Keeping your real address is normal open-source practice — if that is fine, skip this.

To keep it private instead, before running the next step:

```bash
git config user.email "<your-id>+<your-handle>@users.noreply.github.com"
git commit --amend --reset-author --no-edit
```

The exact address is at GitHub → Settings → Emails → "Keep my email address private".

## 2. GitHub (5 min)

Your repository **already exists**, is **public**, and is **empty**:
`github.com/<your-account>/setlist`. The script adopts it rather than creating a new one.

```bash
bash scripts/hitl/github-setup.sh --dry-run   # look first
bash scripts/hitl/github-setup.sh
```

It will:
- push `main` and `develop`;
- add rulesets — `main` requires a pull request and forbids force pushes; `develop`
  forbids force pushes;
- create the `dev`, `stage` and `prod` environments, with `prod` restricted to `main`
  and requiring your review;
- add the `human-needed`, `autopilot` and `quarantine` labels;
- enable Dependabot auto-merge into `develop` and the required Actions settings.

**Then restart Claude Code.** Auto mode does not trust a remote that appeared
mid-session.

## 3. AWS account (10 min)

1. Create an AWS account **on the Free plan**. Do **not** join it to an AWS
   Organization — that instantly upgrades it to a paid plan and expires its Free Tier
   credits.
2. Work in **us-east-1**.
3. Turn on **MFA for the root user**, then stop using root.

If you already have an AWS account from before **2025-07-15**, use that instead and
say so — it has the older perpetual free tier, which is strictly better, and the
design does not depend on credits either way.

## 4. Bootstrap stack (10 min)

This is the only thing you ever upload by hand. It creates the OIDC trust that lets CI
deploy without any long-lived keys, plus the budgets and the deny guardrails.

1. Open the **CloudFormation** console → **Create stack** → **With new resources**.
2. Upload `infra/bootstrap/account-bootstrap.yaml` from this repo.
3. Fill in the parameters:
   - `GitHubOwner` — your GitHub username
   - `GitHubRepo` — `setlist`
   - `AlertEmail` — where billing alarms should go
4. Tick **"I acknowledge that AWS CloudFormation might create IAM resources"**, then
   **Create stack**.
5. **Check your email and confirm the SNS subscription.** An unconfirmed subscription
   means the billing alarm fires into a void — this step is load-bearing.

## 5. Free Tier alerts (2 min)

**Billing and Cost Management → Preferences → Free Tier usage alerts** → enable.

This is a second, independent warning path from the budgets in the stack. Both are free.

## 6. Tell CI the account id (2 min)

```bash
bash scripts/hitl/session1-finish.sh
```

It prompts for the 12-digit AWS account id and stores it as a **GitHub secret**. It is
never written to disk and never committed — the repository is public.

## 7. Expo (5 min)

1. Create a free Expo account at `expo.dev`.
2. Create an **access token** (Account settings → Access tokens).
3. Store it:

```bash
bash scripts/hitl/set-provider-secrets.sh expo
```

The script reads the token from a hidden prompt. **Never paste a token into the Claude
chat.**

---

## Done

Close the `human-needed` issue for H1 and type `/autopilot` in Claude Code. It will
verify the bootstrap stack through the read-only `diagnostics` workflow (M0B-01) and
carry on from there.

## What this session deliberately does not do

- **No AWS credentials on your machine, or Claude Code's.** CI assumes a role through
  OIDC. There is no access key to leak.
- **No paid plan, no Organization, no custom domain, no Route 53.**
- **No Google, Firebase or Spotify setup** — that is Session 2, and only after the
  first dev deploy has produced the redirect URIs those clients need.
