# Session 4 — Beta testers

**About 15 minutes. Due at M7.**

---

## 1. Add testers to the Google consent screen (10 min)

If the OAuth consent screen is still in **Testing**, every tester's Google address has
to be listed as a test user or their sign-in fails with an unhelpful error.

1. Google Cloud console → **APIs & Services → OAuth consent screen → Test users**.
2. Add each tester's Google address.
3. Note Google's cap on test users; if you have more testers than places, tell Claude
   Code and it will propose a publishing-status change with the current rules attached.

**If Spotify is enabled**, add them there too — `developer.spotify.com` → your app →
**User Management**. Dev mode allows **5 users total**, including you.

## 2. Send the invite (5 min)

Claude Code drafts it and attaches it to the H4 issue. It contains:
- the APK link (GitHub Releases) and how to allow installing it;
- the PWA link for iPhone users;
- what to report, and where;
- what the app does with their photos — nothing is stored server-side, and EXIF/GPS is
  stripped on the device.

Read it before sending, then send it yourself. Claude Code does not email anyone.

---

## Done

Close the H4 issue and type `/autopilot`.
