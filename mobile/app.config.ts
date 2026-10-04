/**
 * The Expo config, computed from `APP_VARIANT` (M1-01, PED §300).
 *
 * A function rather than an object because every field below depends on which variant is
 * being built, and the variant arrives as an environment variable at build time. There is
 * no default: `variantFrom` throws when `APP_VARIANT` is unset, so a build that forgot to
 * say which app it is fails here rather than producing an APK with the wrong package id.
 *
 * `runtimeVersion: { policy: 'fingerprint' }` is the PED's requirement and is the one
 * that matters for updates. A fingerprint is computed from the native project itself, so
 * an update can only be delivered to a build whose native layer actually matches it —
 * which is the difference between an over-the-air update and a crash on launch.
 */

import type { ExpoConfig } from 'expo/config'

import variants from './variants.json'

/**
 * Reads `variants.json` directly rather than importing `src/variant.ts`.
 *
 * Not a preference. Expo transpiles this file and then lets Node `require` whatever it
 * imports, and Node cannot resolve a `.ts` file — importing the typed module killed
 * `expo prebuild` with "Cannot find module './src/variant'". JSON is the format both
 * loaders read, so the table is shared and only the lookup is repeated here.
 *
 * `test/app-config.test.ts` asserts this function agrees with `configFor` for all three
 * variants, which is what keeps the repetition from becoming a divergence.
 */
export default (): ExpoConfig => {
  const variant = process.env['APP_VARIANT']
  if (variant !== 'dev' && variant !== 'stage' && variant !== 'prod') {
    throw new Error(
      `APP_VARIANT must be one of dev, stage, prod; got ${variant === undefined ? 'nothing' : JSON.stringify(variant)}. ` +
        'Builds set it explicitly — there is no default, because both plausible defaults ship the wrong app.',
    )
  }
  const config = variants[variant]

  return {
    name: config.name,
    slug: 'setlist',
    scheme: config.scheme,
    version: '0.1.0',
    orientation: 'portrait',
    // No `userInterfaceStyle`: it needs expo-system-ui, which is not installed, and
    // prebuild warns that the field does nothing without it. The screen reads the system
    // scheme through React Native's own `useColorScheme` instead.
    // No `jsEngine` field: SDK 57 removed it because Hermes is the only engine left.
    // M1-07 and M1-04 both make claims specifically about Hermes, so it is worth saying
    // where that guarantee comes from — the SDK, not a flag this file could get wrong.
    runtimeVersion: { policy: 'fingerprint' },
    android: {
      package: config.androidPackage,
      // Distinct per variant so three icons are distinguishable on one device.
      adaptiveIcon: { backgroundColor: variant === 'prod' ? '#101114' : '#2d4a7c' },
    },
    updates: {
      // The channel is set per build profile in eas.json, which is what EAS actually
      // reads. It is recorded here too so the running app can report which channel it
      // believes it is on — a mismatch between the two is otherwise invisible until an
      // update fails to arrive.
      enabled: true,
    },
    extra: {
      variant,
      updateChannel: config.updateChannel,
      // Absent until a deploy injects it. There is no CloudFront distribution yet and
      // the project has no custom domain by design, so a per-variant default here would
      // be an identifier nobody can resolve. M1-07 runs offline and never reads it.
      apiUrl: process.env['SETLIST_API_URL']?.trim() || null,
    },
  }
}
