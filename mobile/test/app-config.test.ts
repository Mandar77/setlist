// `app.config.ts` repeats a lookup that `src/variant.ts` already does. This is what makes
// the repetition safe.
//
// It exists because of a build-system constraint rather than a design choice: Expo
// transpiles app.config.ts and then lets Node `require` its imports, and Node cannot
// resolve a `.ts` file, so the config cannot import the typed module. Both read the same
// `variants.json`, and these tests assert they reach the same answer — so a change to one
// without the other fails here rather than in an APK.

import { afterEach, describe, expect, it } from 'vitest'

import appConfig from '../app.config.js'
import { VARIANTS, configFor } from '../src/variant.js'

const original = process.env['APP_VARIANT']

afterEach(() => {
  if (original === undefined) delete process.env['APP_VARIANT']
  else process.env['APP_VARIANT'] = original
  delete process.env['SETLIST_API_URL']
})

describe('the config agrees with the variant table', () => {
  it.each(VARIANTS)('%s', variant => {
    process.env['APP_VARIANT'] = variant
    const config = appConfig()
    const expected = configFor(variant)

    expect(config.name).toBe(expected.name)
    expect(config.scheme).toBe(expected.scheme)
    expect(config.android?.package).toBe(expected.androidPackage)
    expect(config.extra?.['updateChannel']).toBe(expected.updateChannel)
    expect(config.extra?.['variant']).toBe(variant)
  })
})

describe('what every build carries regardless of variant', () => {
  it('uses the fingerprint runtime version policy', () => {
    // PED §300. A fingerprint is computed from the native project, so an update can only
    // reach a build whose native layer matches it — the difference between an OTA update
    // and a crash on launch.
    process.env['APP_VARIANT'] = 'dev'
    expect(appConfig().runtimeVersion).toEqual({ policy: 'fingerprint' })
  })

  it('does not set jsEngine, because SDK 57 has only Hermes', () => {
    process.env['APP_VARIANT'] = 'dev'
    expect(appConfig()).not.toHaveProperty('jsEngine')
  })
})

describe('APP_VARIANT', () => {
  it('throws when unset rather than picking one', () => {
    delete process.env['APP_VARIANT']
    expect(() => appConfig()).toThrow(/must be one of/)
  })

  it('throws on a value that is close but wrong', () => {
    process.env['APP_VARIANT'] = 'production'
    expect(() => appConfig()).toThrow(/must be one of/)
  })
})

describe('the API URL', () => {
  it('is null when no deploy injected one', () => {
    process.env['APP_VARIANT'] = 'prod'
    expect(appConfig().extra?.['apiUrl']).toBeNull()
  })

  it('is whatever was injected', () => {
    process.env['APP_VARIANT'] = 'prod'
    process.env['SETLIST_API_URL'] = 'https://example.invalid/api'
    expect(appConfig().extra?.['apiUrl']).toBe('https://example.invalid/api')
  })
})
