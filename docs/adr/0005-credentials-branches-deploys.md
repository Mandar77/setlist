# ADR-005 — Credentials, branches, and who deploys

- **Status:** Accepted
- **Date:** 2026-09-28
- **Authority:** `docs/plan/AUTOPILOT.md` §1 — **this ADR and the $0 rules outrank
  everything else in the repository**

## Context

An agent working unattended against a public repository and a zero-budget AWS account
has three ways to cause irreversible harm: leak a secret into public history, spend
money, or deploy something unreviewed to production. Each needs a structural block,
not a guideline — a guideline is only as good as the agent's attention on a long run.

## Decision

### No local cloud credentials

Claude Code never holds AWS credentials or provider secrets. Every AWS action runs in
GitHub Actions through OIDC. To inspect deployed state, Claude Code dispatches the
read-only `diagnostics` workflow and reads its output.

Enforced by `.claude/settings.json` denying `Bash(aws *)` and by
`.claude/hooks/guard-bash.sh`, which catches the same commands when phrased in ways a
prefix rule misses (pipelines, `env` prefixes, command substitution).

### Branches

| Branch | Who | Effect |
| --- | --- | --- |
| `task/*` | Claude Code pushes | CI runs |
| `develop` | Claude Code fast-forwards once CI is green | Deploys to dev, then the same artifact to stage |
| `main` | **Only the human merges** | Deploys to prod the artifact that passed stage, built from the PR head commit — not rebuilt |

Claude Code never merges pull requests and never pushes to `main`.

### Secrets

The human types them into hidden prompts from `scripts/hitl/*.sh`, which store them as
GitHub environment secrets; CI copies them into SSM SecureString. **A secret is never
pasted into the Claude chat** — chat transcripts are not a secret store.

### Public-repo hygiene

No account IDs, ARNs, emails or personal data in commits, issues or pull requests.
They live in GitHub secrets and variables. CDK reads the account from the CI session.
Redirect URIs and domains appear in deploy job summaries, never in committed files.

### Only free APIs in automation

**Banned:** Cost Explorer, CloudWatch `GetMetricData`, CloudWatch Logs Insights
queries. Each is billed per call, so a monitoring loop would itself break the $0
guarantee it was watching.

**Use instead:** `GetMetricStatistics`, Describe/List calls, and the kill switch's own
alert record as evidence of a $0 bill.

Before adding any other AWS API call, check its pricing page and cite it in the commit.

## Consequences

- Claude Code cannot verify a deploy by looking at it directly; the `diagnostics`
  workflow is the only window, so it has to return enough detail to be useful.
- Every environment-affecting change is reviewable in a CI log before it is real.
- Prod is a human decision on a specific commit, every time.
- The guard hook will occasionally produce a false positive — a commit message
  containing "cdk deploy" gets blocked. Rephrase; do not weaken the rule.
