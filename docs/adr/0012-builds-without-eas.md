# ADR-012 — APKs are built with `expo prebuild` + Gradle, not EAS

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decided by:** the human
- **Amends:** `M1-01`'s third `done_when`; takes [issue #18](https://github.com/Mandar77/setlist/issues/18) off the critical path
- **Context:** the whole of M1 blocked behind a credential nothing technical needed

## Context

M1-01's third `done_when` read *"CI builds three APKs on Linux with `eas build --local`"*.
`eas build --local` needs an Expo account and an `EXPO_TOKEN`, which only a human can
create (`docs/hitl/SESSION-1.md` §7). By [AUTOPILOT §2.4](../plan/AUTOPILOT.md#24-stop-rules-these-go-to-the-human)
that is a stop rule — an account has to be created — so M1-01 went `blocked`, and with it
M1-07, M1-04, M2-02 and everything downstream of the app. One line of a `done_when` put
the entire mobile milestone behind a login.

Nothing about the artifact required it. CI already builds all three variants with
`expo prebuild --platform android --clean --no-install` followed by Gradle
`assembleRelease`, installs them side by side on the emulator, and drives them with
Maestro. Expo's generated `release` block signs with the debug keystore, which is correct
for a build that only ever reaches an emulator and is never distributed. That path needs
no account, no credential, and no third-party build service, and it has been green:
**[run 37183436407](https://github.com/Mandar77/setlist/actions/runs/37183436407)**.

So the two halves of M1-01 were doing different jobs. Three APKs that install side by side
is a claim about the *app* — it is FR-M-015, it is what M1-01 exists to prove, and it was
met. "Built by EAS" is a claim about the *toolchain*, and nothing in the PED or the PRD
asks for it.

## Decision

1. **CI builds release APKs with `expo prebuild` + Gradle.** No account, no credential, no
   third-party build service. This is the supported path, not a workaround: `prebuild`
   generates the same native project EAS would build, from the same `app.config.ts`.
2. **M1-01's third `done_when` is amended to say exactly that**, and M1-01 and M1-07 close
   on the evidence already in the ledger.
3. **EAS comes back only if we adopt EAS Update** for over-the-air JavaScript updates.
   That is its own task (`M1-08`), blocked on issue #18, and it is a product decision about
   shipping fixes without a store review — not a build-system decision.
4. **Issue #18 comes off the critical path.** It stays open against M1-08 alone.
5. **A real release keystore is still needed before beta.** EAS is not managing credentials,
   so nothing else is. `docs/hitl/SESSION-2.md` §6 becomes a concrete `scripts/hitl` step
   rather than "Claude Code tries Expo-managed credentials first".

### This is not a gate relaxation

The threshold did not move. Three APKs, three application ids, installed simultaneously,
asserted by Maestro on a real emulator — every one of those is still required and still
proven. What changed is which tool produces the artifact the same gate judges, and the
replacement is strictly more available: it runs on any Linux runner with the Android SDK,
with no account that can expire, be rate-limited, or change its terms.

If anything it is the stricter choice. `eas build --local` would have been one more service
in the path between a commit and an APK, and [ADR-011](0011-dependency-policy.md) exists
because this project has already been bitten twice by supply-chain state it did not control.

## What we give up, recorded rather than waved past

- **EAS Update** — over-the-air JS updates without a store round trip. This is the real
  loss and it is why M1-08 exists. `runtimeVersion` already uses `fingerprint`, so the
  field the update channel keys on is in place.
- **EAS-managed credentials** — the keystore is now ours to create, store and never lose.
  Hence the SESSION-2 §6 change: if that keystore is lost, the app can never be updated
  under the same identity again, and no service is holding a copy.
- **EAS Submit** — store upload stays manual. It was always going to be, for a project
  whose release step is a human merging `develop` → `main`.
- **Build reproducibility across machines** — `prebuild` + Gradle pins the toolchain by the
  runner image rather than by EAS's build profile. CI is the only place that builds, which
  bounds it.

## Consequences

- M1-01 and M1-07 close. M1-04, M2-02 and the rest of the mobile path become selectable
  without a human session, which is most of what this ADR buys.
- The release-signing problem is now visible and scheduled instead of being implicitly
  somebody else's. A debug-signed APK is fine for an emulator and is not shippable; the
  gap between those two facts is exactly what SESSION-2 §6 now names.
- Issue #18 is no longer the reason anything is blocked, so a stale "blocked on #18" in the
  ledger is now a bug rather than a status.
