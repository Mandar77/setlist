# Human-in-the-loop checkpoints

Claude Code cannot do any of these. Each one blocks the phase it belongs to, and
several have long external lead times — start those on day one.

Work through them in order; tick the box and record the date when done.

## M0 — account and repository

- [ ] **AWS Free-plan account**, root MFA enabled, an admin IAM user, region `us-east-1`.
      Do **not** join an AWS Organization: doing so upgrades the account to a paid plan
      and expires its Free Tier credits immediately (PED D15).
      Record here whether this account is **new** (post-2025-07-15, credits-based) or
      **legacy** — the answer changes which services are free. → _answer:_
- [ ] **Three budgets**, one with an IAM-deny budget action, plus a Cost Anomaly
      Detection monitor. The first two action-enabled budgets are free; never create a
      third.
- [ ] **Lambda concurrency quota** — request a free increase if the account starts low.
- [ ] **Enrol the prod CloudFront distribution in the flat-rate Free plan** in the
      console. CDK has no native support for this, so it cannot be automated.
- [ ] **GitHub repository**, public, with rulesets, environments (`dev`/`stage`/`prod`
      with a prod reviewer), and the OIDC role trust policy scoped to
      `environment:<env>`.

## M1–M2 — app shell and OCR

- [ ] **Expo account** and the three update channels (`dev`, `stage`, `production`).
- [ ] **Consented golden set** — 150 handwritten pages from ≥10 writers, 100 flyers,
      100 screenshots. Written consent for each contributor. **Stored outside this
      repository**: it is public. `golden/` holds pointers only.
- [ ] **Test devices** — ideally a Gemini Nano-capable Android (Pixel 10 or similar)
      plus any iPhone for the PWA path.

## M4 — YouTube

- [ ] **Google Cloud project** with the YouTube Data API enabled, consent screen in
      Testing, and **three** web OAuth clients (one per environment). Policy allows
      separate credentials per environment but **exactly one project per API client** —
      never create extra projects to gain quota.
- [ ] Client IDs and secrets written into SSM under `/setlist/<env>/secrets/`.
      Never into the repository.
- [ ] **Google verification of the sensitive `youtube` scope** — start at M6; duration
      unknown, treat as the long pole.

## M5 — push

- [ ] **Firebase (Spark plan)** project and FCM credentials for Expo push.

## Release

- [ ] **Android keystore** generated offline, stored as a `prod` environment secret,
      with an offline backup. Losing it means never updating the app again.
- [ ] **Beta testers** — at least 10 for M7.
- [ ] **Paid-plan upgrade approval**, month 4–5, after M4 shows 30 days at $0.00.
      A Free-plan account closes at 6 months or when credits run out.
- [ ] **Approve each stage and prod deployment** in GitHub Environments.

## Conditional / deferred

- [ ] **Spotify** — only if the owner holds an active Premium subscription. Dev mode
      caps the app at 5 users. → _owner has Premium?_
- [ ] **Checkmarx One** secrets — only if a licence or trial materialises. The gate
      runs on KICS + 2MS until then.
- [ ] **Google Play** ($25 one-time) — unlocks store distribution; APK on GitHub
      Releases until then.
- [ ] **Apple Developer Program** ($99/yr) — unlocks iOS, TestFlight and MusicKit. Until
      then iOS is PWA-only and Apple Music is out of scope entirely.
- [ ] **Amazon Music** — closed beta, requires a BD contact. Assume never.
