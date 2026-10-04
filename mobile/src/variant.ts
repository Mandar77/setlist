/**
 * The three app variants (M1-01, PED §292 and FR-M-015).
 *
 * dev, stage and prod must install side by side on one device, which means three
 * distinct Android application ids and three distinct URL schemes. Everything that
 * differs between them is here, as data, so `app.config.ts` stays a lookup and the
 * table itself can be tested without starting Expo.
 */

export const VARIANTS = ['dev', 'stage', 'prod'] as const

export type Variant = (typeof VARIANTS)[number]

export interface VariantConfig {
  readonly variant: Variant
  /** Android `applicationId`. Distinct per variant so all three can coexist. */
  readonly androidPackage: string
  /** Deep-link scheme. Also distinct, or the OS routes a link to whichever installed last. */
  readonly scheme: string
  /** Display name, so a user with three icons can tell them apart. */
  readonly name: string
  /** The EAS Update channel this build subscribes to. */
  readonly updateChannel: string
}

/**
 * PED §292, copied field for field.
 *
 * Note prod's channel is `production` while its variant is `prod`. That asymmetry is in
 * the PED and is not a typo here, so a test asserts it — otherwise the obvious "fix"
 * would silently point production builds at a channel nothing publishes to.
 */
const CONFIGS: Readonly<Record<Variant, VariantConfig>> = {
  dev: {
    variant: 'dev',
    androidPackage: 'com.setlist.app.dev',
    scheme: 'setlist-dev',
    name: 'Setlist (dev)',
    updateChannel: 'dev',
  },
  stage: {
    variant: 'stage',
    androidPackage: 'com.setlist.app.stage',
    scheme: 'setlist-stage',
    name: 'Setlist (stage)',
    updateChannel: 'stage',
  },
  prod: {
    variant: 'prod',
    androidPackage: 'com.setlist.app',
    scheme: 'setlist-prod',
    name: 'Setlist',
    updateChannel: 'production',
  },
}

/**
 * Read `APP_VARIANT`, refusing anything that is not one of the three.
 *
 * Positively matched with the miss handled explicitly, per the CLAUDE.md rule — and here
 * the explicit handling is to **throw rather than default**. Both defaults are wrong in
 * a way that is expensive and quiet: defaulting to `dev` ships a build whose package id
 * is not the one the store expects, and defaulting to `prod` points a developer's device
 * at production data. A build that does not say which variant it is has a bug in its
 * invocation, and the right time to find out is before the APK exists.
 */
export function variantFrom(raw: string | undefined | null): Variant {
  for (const candidate of VARIANTS) {
    if (raw === candidate) return candidate
  }
  throw new Error(
    `APP_VARIANT must be one of ${VARIANTS.join(', ')}; got ${raw === undefined || raw === null ? 'nothing' : JSON.stringify(raw)}. ` +
      'Builds set it explicitly — there is no default, because both plausible defaults ship the wrong app.',
  )
}

export function configFor(variant: Variant): VariantConfig {
  return CONFIGS[variant]
}

/**
 * Where this build talks to the backend, or `null` when nothing has told it.
 *
 * Deliberately not a per-variant hard-coded domain. The API is reached through a
 * CloudFront distribution that does not exist until the platform stack is deployed, and
 * the project has no custom domain by design (PED: no Route 53, no paid plan). Inventing
 * `api.dev.setlist.example` here would be writing down an identifier nobody can resolve
 * and then building retry logic against it.
 *
 * So it is injected at build time and absent until then. M1-07 runs entirely offline and
 * never reads this, which is the property that lets the app ship useful before any
 * backend exists at all.
 */
export function apiUrlFrom(env: Readonly<Record<string, string | undefined>>): string | null {
  const url = env['SETLIST_API_URL']
  return url === undefined || url.trim() === '' ? null : url
}
