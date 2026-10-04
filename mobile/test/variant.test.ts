// The three variants (M1-01, PED §292).
//
// FR-M-015 is "all 3 install side by side", and on Android that is true exactly when the
// application ids differ. So the interesting assertions here are not that each row equals
// the PED's text — though they do — but that the three rows are pairwise distinct in the
// fields the OS uses to tell apps apart.

import { describe, expect, it } from 'vitest'

import { VARIANTS, apiUrlFrom, configFor, variantFrom } from '../src/variant.js'

describe('the PED table', () => {
  it('matches §292 field for field', () => {
    expect(configFor('dev')).toMatchObject({
      androidPackage: 'com.setlist.app.dev',
      scheme: 'setlist-dev',
      updateChannel: 'dev',
    })
    expect(configFor('stage')).toMatchObject({
      androidPackage: 'com.setlist.app.stage',
      scheme: 'setlist-stage',
      updateChannel: 'stage',
    })
    expect(configFor('prod')).toMatchObject({
      androidPackage: 'com.setlist.app',
      scheme: 'setlist-prod',
      updateChannel: 'production',
    })
  })

  it("calls prod's channel `production`, not `prod`", () => {
    // Asserted on its own because it reads like a typo and is not. "Fixing" it would
    // point production builds at a channel nothing ever publishes to, and the symptom
    // would be updates that silently never arrive.
    expect(configFor('prod').updateChannel).toBe('production')
    expect(configFor('prod').variant).toBe('prod')
  })
})

describe('installing side by side', () => {
  const configs = VARIANTS.map(configFor)

  it('gives every variant a distinct Android package', () => {
    // This is FR-M-015. Two variants sharing an application id do not coexist — the
    // second install replaces the first.
    expect(new Set(configs.map(c => c.androidPackage)).size).toBe(VARIANTS.length)
  })

  it('gives every variant a distinct scheme', () => {
    // Shared schemes do not fail to install; they fail at the moment a deep link is
    // opened, by routing to whichever app the OS picked. Worse to debug than a clash.
    expect(new Set(configs.map(c => c.scheme)).size).toBe(VARIANTS.length)
  })

  it('gives every variant a distinct name, so three icons are tellable apart', () => {
    expect(new Set(configs.map(c => c.name)).size).toBe(VARIANTS.length)
  })

  it('namespaces dev and stage under the production id', () => {
    // Not cosmetic: it keeps one Play listing's id free while the other two are clearly
    // derived from it, which is what the store expects.
    expect(configFor('dev').androidPackage.startsWith('com.setlist.app')).toBe(true)
    expect(configFor('stage').androidPackage.startsWith('com.setlist.app')).toBe(true)
  })
})

describe('reading APP_VARIANT', () => {
  it('accepts the three', () => {
    for (const variant of VARIANTS) expect(variantFrom(variant)).toBe(variant)
  })

  it('throws when it is missing rather than defaulting', () => {
    // The whole reason this function exists. Defaulting to dev ships the wrong package
    // id; defaulting to prod points a developer at production. Both are quiet.
    expect(() => variantFrom(undefined)).toThrow(/must be one of/)
    expect(() => variantFrom(null)).toThrow(/must be one of/)
    expect(() => variantFrom('')).toThrow(/must be one of/)
  })

  it('throws on a value that is close but wrong', () => {
    expect(() => variantFrom('production')).toThrow(/must be one of/)
    expect(() => variantFrom('DEV')).toThrow(/must be one of/)
    expect(() => variantFrom('development')).toThrow(/must be one of/)
  })

  it('says what it got, so the build log names the mistake', () => {
    expect(() => variantFrom('staging')).toThrow(/"staging"/)
    expect(() => variantFrom(undefined)).toThrow(/nothing/)
  })
})

describe('the API URL', () => {
  it('is null when nothing set it', () => {
    // There is no backend URL to hard-code: the distribution does not exist until the
    // platform stack deploys, and the project has no custom domain by design. A plausible
    // placeholder would be an identifier nobody can resolve.
    expect(apiUrlFrom({})).toBeNull()
    expect(apiUrlFrom({ SETLIST_API_URL: '' })).toBeNull()
    expect(apiUrlFrom({ SETLIST_API_URL: '   ' })).toBeNull()
  })

  it('is whatever the build injected', () => {
    expect(apiUrlFrom({ SETLIST_API_URL: 'https://example.invalid/api' })).toBe(
      'https://example.invalid/api',
    )
  })
})
