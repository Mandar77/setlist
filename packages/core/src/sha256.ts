/**
 * SHA-256, from a vetted library (ADR-010).
 *
 * `SourceDocument.digest` is a content hash used as a cache key and to prove a confirmed
 * job is operating on the same text that was previewed. The constraints that shaped this
 * file have not changed:
 *
 * * `node:crypto` is a Node API, and ADR-001 keeps this package runnable on Hermes and
 *   in a browser. The ESLint purity rule rejects the import.
 * * `crypto.subtle.digest` exists in browsers and in modern Node, but it is **async**.
 *   Making it the digest source would make `SourceDocument.fromRaw` async, and from
 *   there the whole extraction pipeline — a synchronous pure function today, called on
 *   the hot preview path (NFR-001, p95 < 6 s) and from React render paths on device.
 *
 * What changed is the conclusion. Those two rule out the platform's hash; they argue for
 * a synchronous pure implementation, not for *ours*. This file used to carry sixty lines
 * of hand-written FIPS 180-4 compression — correct, differential-tested, and still a
 * cryptographic primitive maintained by this project for no reason anyone would defend
 * if asked directly.
 *
 * `@noble/hashes` is audited, has zero dependencies, and is pure JavaScript with no
 * `node:` import and no DOM access anywhere in its shipped files — checked, not assumed.
 * The ESLint purity rule still passes.
 *
 * The UTF-8 encoder below stays hand-written, and that is deliberate: it is not a
 * cryptographic primitive, `TextEncoder` is a platform global rather than a language
 * feature, and this function *defines* the lone-surrogate behaviour the oracle's digests
 * depend on. Replacing it would be a behaviour change wearing a cleanup's clothes.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/**
 * UTF-8 bytes of a string, without TextEncoder.
 *
 * `TextEncoder` is a browser and Node global, not a language feature, and Hermes has
 * historically shipped without it. Encoding by hand is unremarkable and removes the
 * question.
 *
 * Lone surrogates — which a user can paste — are encoded as U+FFFD, matching what
 * Python's `str.encode("utf-8", errors="replace")` would do and, more importantly,
 * matching what the oracle receives: a Python `str` cannot hold a lone surrogate that
 * survived `normalize_document`.
 */
function utf8(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }

    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/** The SHA-256 of `text`'s UTF-8 bytes, lowercase hex — the same string Python's `hexdigest()` returns. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8(text)))
}
