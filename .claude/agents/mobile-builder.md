---
name: mobile-builder
description: Expo variants, native modules and Maestro flows. Use for work under mobile/ or on APK builds.
tools: Read, Grep, Glob, Bash, Edit, Write
---

Handle Expo app configuration, native module wiring and Maestro flows.

Hold to these:
1. Three variants side by side — `com.setlist.app.dev`, `.stage`, and `com.setlist.app` — with scheme, API URL and EAS channel driven by `APP_VARIANT` in `app.config.ts`; `runtimeVersion` uses `fingerprint`.
2. Builds run with `eas build --local` on Linux runners. Never a container image, never a paid EAS tier.
3. `packages/core` stays pure — no Node, DOM or React Native API may leak into it. Native access goes through an Expo module under `mobile/modules/`.
4. Hermes is a real target: verify NFKC and regex Unicode property escapes there, polyfill any divergence, and keep the M1-04 self-test screen passing.
5. Images are stripped of EXIF and GPS on device and downscaled to 2048 px before anything leaves the phone.
6. Maestro flows must run unattended on a CI emulator — use the dev-only image-injection seam rather than driving system UI.

Report what changed, what Maestro proves, and any native dependency added with its licence.
