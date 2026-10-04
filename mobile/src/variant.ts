/**
 * The three app variants (M1-01, PED §292 and FR-M-015).
 *
 * dev, stage and prod must install side by side on one device, which means three
 * distinct Android application ids and three distinct URL schemes. Everything that
 * differs between them is here, as data, so `app.config.ts` stays a lookup and the
 * table itself can be tested without starting Expo.
 */

import variants from '../variants.json'

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
 * PED §292, read from `variants.json` rather than written out here.
 *
 * The table is data because two loaders need it and they do not agree on what they can
 * load. Vitest and Metro resolve TypeScript; `expo prebuild` transpiles `app.config.ts`
 * and then hands its relative imports to Node's `require`, which cannot resolve a `.ts`
 * file at all — the first version of this file was imported by `app.config.ts` and
 * prebuild died with "Cannot find module './src/variant'". JSON is the one format both
 * reach, so the table lives there and this module supplies the types and the validation.
 *
 * Note prod's channel is `production` while its variant is `prod`. That asymmetry is in
 * the PED and is not a typo, so a test asserts it — otherwise the obvious "fix" would
 * silently point production builds at a channel nothing publishes to.
 */
/**
 * Read the table, checking it rather than casting it.
 *
 * TypeScript types a JSON import structurally, so `variant: "dev"` arrives as `string`
 * and the obvious `as Record<Variant, VariantConfig>` would make the compiler agree with
 * whatever the file happens to contain. Since this is now a data file that a human can
 * edit without the compiler watching, validating it is the cheaper half of the trade —
 * and the check runs at import time, so a malformed table fails the build rather than
 * producing an APK with an empty package id.
 */
export function readTable(source: unknown): Readonly<Record<Variant, VariantConfig>> {
  if (typeof source !== 'object' || source === null) {
    throw new TypeError('variants.json must be an object')
  }
  const rows = source as Record<string, unknown>
  const table = {} as Record<Variant, VariantConfig>

  for (const variant of VARIANTS) {
    const entry = rows[variant]
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`variants.json has no entry for ${variant}`)
    }
    const row = entry as Record<string, unknown>

    const field = (name: string): string => {
      const value = row[name]
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`variants.json: ${variant}.${name} must be a non-empty string`)
      }
      return value
    }

    // The entry names itself, so a copy-pasted row that was never re-labelled is caught
    // here instead of shipping two variants with one package id.
    if (row['variant'] !== variant) {
      throw new TypeError(
        `variants.json: the ${variant} entry declares variant ${JSON.stringify(row['variant'])}`,
      )
    }

    table[variant] = {
      variant,
      androidPackage: field('androidPackage'),
      scheme: field('scheme'),
      name: field('name'),
      updateChannel: field('updateChannel'),
    }
  }
  return Object.freeze(table)
}

const CONFIGS: Readonly<Record<Variant, VariantConfig>> = readTable(variants)

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
