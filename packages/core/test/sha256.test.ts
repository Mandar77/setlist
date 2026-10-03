/**
 * SHA-256 against published answers.
 *
 * The core implements its own (ADR-001: `node:crypto` is a Node API and
 * `crypto.subtle.digest` is async, which would make the whole extraction pipeline
 * async), and the differential checks it against Python's `hashlib` on 4,903 strings.
 * Neither of those is a *known* answer: the first compares the implementation to itself,
 * and the second compares it to another implementation that could, in principle, be
 * wrong in the same way.
 *
 * Mutation testing is what surfaced this. 96 of 127 mutants in `sha256.ts` survived the
 * hand-written suite, because the only test that touched it asserted
 * `document.digest === sha256Hex(normalizeDocument(raw))` — both sides call the mutated
 * function, so corrupting a round constant changes both and the assertion still holds.
 * A test that cannot fail is worse than no test, because it occupies the space where a
 * real one would go.
 *
 * Three of these are the published FIPS 180-4 §B vectors — "abc", the 56-byte string,
 * and a million 'a' — which are the answers rather than another opinion about them. The
 * rest were computed with OpenSSL through Python's `hashlib`, and are anchored by the
 * published three: an OpenSSL that disagreed with FIPS on "abc" would be caught here
 * before any value it produced was trusted.
 */

import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../src/sha256.js'

describe('SHA-256 reproduces the published vectors', () => {
  it.each([
    // FIPS 180-4 §B.1 — one block.
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    // The empty string: the padding-only path, where an off-by-one in the length block
    // is the whole computation.
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    // FIPS 180-4 §B.2 — 56 bytes, which forces a second block for the length field.
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    // 64 bytes exactly: the boundary where padding spills into a block of its own.
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno',
      '2ff100b36c386c65a1afc462ad53e25479bec9498ed00aa5a04de584bc25301b',
    ],
    // FIPS 180-4 §B.3 — a million 'a', which exercises the multi-block loop properly.
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ])('hashes %#', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })
})

describe('SHA-256 encodes its input as UTF-8 first', () => {
  // The core hashes a string, and a string has no bytes until an encoding is chosen.
  // These are the answers for the UTF-8 encoding of each, so a hand-rolled `utf8()` that
  // mishandled a continuation byte or a surrogate pair fails here rather than silently
  // producing a stable-but-wrong cache key.
  it.each([
    // Two-byte sequence.
    ['é', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
    // Three-byte sequence (CJK).
    ['世界', '33650a369521ec29f2e26c43d25967535bcb26436755f536735d1ef6e84a1ec5'],
    // Four-byte sequence: an astral-plane code point, i.e. a surrogate pair in a
    // JavaScript string. `for (const ch of text)` iterates code points and
    // `charCodeAt` would not — that is the distinction this case exists for.
    ['🎵', 'bd51e4b323e4c72b4e1b1533aae5cd793da84e155eef30e7edb8c5aab34177e3'],
  ])('hashes %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it('does not collide across encodings of different text', () => {
    expect(sha256Hex('世界')).not.toBe(sha256Hex('世 界'))
  })
})

describe('the output shape', () => {
  it('is 64 lowercase hex characters', () => {
    expect(sha256Hex('Daft Punk - Da Funk')).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('pads a leading zero byte rather than dropping it', () => {
    // `(byte).toString(16)` gives "7" for 0x07, and a digest missing a nibble is a
    // digest that silently stops being 64 characters. The schema would catch it; a
    // length assertion alone would not say which end lost a character.
    const digests = Array.from({ length: 200 }, (_, i) => sha256Hex(`probe-${i}`))
    expect(digests.every(d => d.length === 64)).toBe(true)
  })
})
