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

import { apiUrlFrom, configFor, variantFrom } from './src/variant'

export default (): ExpoConfig => {
  const variant = variantFrom(process.env['APP_VARIANT'])
  const config = configFor(variant)

  return {
    name: config.name,
    slug: 'setlist',
    scheme: config.scheme,
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
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
      apiUrl: apiUrlFrom(process.env),
    },
  }
}
