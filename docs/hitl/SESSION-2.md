# Session 2 — Google/YouTube, test account, Firebase, optional Spotify

**About 45 minutes. Due after the first dev deploy**, because the OAuth clients need
redirect URIs that only exist once the CloudFront distribution is up. Claude Code will
put the exact URIs in the deploy job summary and link them from the `human-needed`
issue for H2.

Run scripts in a terminal, not in the Claude chat. Close the H2 issue when done and
type `/autopilot`.

> Before this session Claude Code re-checks Google's current rules on refresh-token
> expiry in Testing mode and on unverified apps in production, and writes the answer
> here. **Check the issue for that note before choosing a publishing status** — the
> rules have changed more than once.

---

## 1. Google Cloud and YouTube (20 min)

No billing account is needed.

1. **Create a project** at `console.cloud.google.com`. Any name.
2. **Enable YouTube Data API v3** (APIs & Services → Library).
3. **OAuth consent screen**:
   - User type: **External**
   - Scope: `https://www.googleapis.com/auth/youtube.force-ssl` — this is a
     *sensitive* scope
   - Add **yourself** and the **test account** from step 2 below as test users
   - Leave it in **Testing** unless the issue note says otherwise
4. **Create three Web OAuth clients** — one each for dev, stage and prod. Use the
   redirect URIs from the latest deploy job summary **exactly as printed**; a
   trailing-slash mismatch is the single most common failure here.

**Quota reality check:** 10,000 units/day cannot be bought, and prod's share is 7,000
— about 8 playlists a day. That is the binding constraint on the whole product, not
AWS. Do not create extra projects to get more quota: Google's policy allows separate
credentials per environment but exactly one project per API client, and multiple
projects for the same use case is a terms violation.

## 2. Test Google account (10 min)

1. Create a **free, separate** Google account for E2E tests. Do not use your own —
   the tests create and delete playlists.
2. **Create its YouTube channel** (visit YouTube once and accept the prompt).
   Playlist creation fails without a channel.
3. Add it as a test user on the consent screen (step 1.3).
4. Open the one-time consent link from the **stage** deploy summary and approve it.
   That stores the refresh token CI needs.

## 3. Firebase for push (10 min)

Free **Spark** plan; no billing.

1. Create a Firebase project (it can reuse the Google Cloud project).
2. Add **three Android apps** with these package names:
   - `com.setlist.app.dev`
   - `com.setlist.app.stage`
   - `com.setlist.app`
3. Download the **FCM v1 service-account key** and upload it in Expo under
   **Project → Credentials → Android**.

iOS push needs the paid Apple program, so the iOS PWA uses Web Push instead.

## 4. Store the secrets (3 min)

```bash
bash scripts/hitl/set-provider-secrets.sh google
```

Hidden prompts, stored as GitHub environment secrets, copied into SSM SecureString by
CI. **Never paste a secret into the Claude chat.**

## 5. Spotify — only if you have Premium (5 min, optional)

Spotify dev mode requires the **app owner to hold an active Premium subscription**,
and caps the app at **5 users**. Without Premium, skip this entirely; the Spotify
adapter (SPOT-01) stays unbuilt and nothing else is affected.

If you do have Premium:
1. Create an app at `developer.spotify.com`.
2. Add the redirect URI from the **prod** deploy summary. Prod only — dev and stage
   use the simulator.
3. `bash scripts/hitl/set-provider-secrets.sh spotify`

**Answer this either way**, since the ledger is waiting on it: *do you have Spotify
Premium?* Put the answer in the H2 issue.

## 6. Android signing (varies)

Claude Code tries Expo-managed credentials first, which needs nothing from you. If a
step does need you, the issue will give you one command to run.

**Save the keystore and its password in your password manager.** If it is lost, the
app can never be updated under the same identity again.

## 7. CloudFront flat-rate Free plan (2 min, only if asked)

CDK has no native support for enrolling a distribution in the flat-rate Free plan, so
this may need a console visit: **CloudFront → your prod distribution → enroll in the
Free plan**. It bundles WAF and has no overages, which is why prod uses it.

Claude Code will only raise this if it could not automate it.

---

## Done

Close the H2 issue and type `/autopilot`.
