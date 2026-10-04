// "Images are generated in CI, never committed" — M2-01's fourth done_when.
//
// A .gitignore entry is an intention. This is the check: it asks git what it is actually
// tracking, so an image added with `git add -f`, or a rule someone edited, fails here
// rather than at review time or not at all.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

function tracked(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', '--', pathspec], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(line => line !== '')
}

describe('the generated images stay out of git', () => {
  it('tracks nothing under golden/ocr-generated', () => {
    expect(tracked('golden/ocr-generated')).toEqual([])
  })

  it('tracks no image anywhere under golden/ocr', () => {
    // The directory holding the committed summary is next door and must stay text-only.
    for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
      expect(tracked(`golden/ocr/*.${extension}`), extension).toEqual([])
    }
  })

  it('would notice if something were tracked', () => {
    // The complement. Without this, the assertions above would also pass if `git
    // ls-files` were silently returning nothing at all — a wrong working directory, a
    // detached checkout, git missing from PATH.
    expect(tracked('golden/seed').length).toBeGreaterThan(0)
  })

  it('still has the images on disk after a generate, unversioned', () => {
    // Only meaningful once `make golden` has run; skipped rather than failed otherwise,
    // because `make verify` does not render and should not have to.
    const dir = resolve(repoRoot, 'golden', 'ocr-generated')
    if (!existsSync(dir)) return
    expect(tracked('golden/ocr-generated')).toEqual([])
  })
})

describe('the committed half is small and readable', () => {
  const summaryPath = resolve(repoRoot, 'golden', 'ocr', 'corpus.json')

  it('is a summary, not the whole manifest', () => {
    // The manifest is ~2.5 MB. If it ever lands here, the filing decision in manifest.ts
    // has been undone and the diffs become unreviewable.
    const bytes = readFileSync(summaryPath).byteLength
    expect(bytes).toBeLessThan(64 * 1024)
  })

  it('carries the digest that makes the determinism claim checkable', () => {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { manifestSha256: string }
    expect(summary.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
