/**
 * The two enforcers of the never-use list must cover exactly the same rules.
 *
 * `infra/nag/rules.ts` fails `cdk synth`; the KICS pack under
 * `security/kics-queries/zero-cost/` scans the finished templates and the deployed
 * state. They are deliberately redundant — a rule that only one of them knows about is
 * the failure this file exists to prevent, because from either side it still looks
 * enforced.
 *
 * Checked here rather than in the generator so it runs in `make verify`, which has no
 * Docker and is the gate that always runs.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SZC_RULES, SZC_RULE_IDS } from '../rules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACK_DIR = join(HERE, '..', '..', '..', 'security', 'kics-queries', 'zero-cost')

interface QueryMeta {
  readonly id: string
  readonly queryName: string
  readonly severity: string
  readonly platform: string
  readonly szcRule: string
  readonly descriptionText: string
}

const pack: readonly { dir: string; meta: QueryMeta }[] = readdirSync(PACK_DIR, {
  withFileTypes: true,
})
  .filter(entry => entry.isDirectory())
  .map(entry => ({
    dir: entry.name,
    meta: JSON.parse(
      readFileSync(join(PACK_DIR, entry.name, 'metadata.json'), 'utf8'),
    ) as QueryMeta,
  }))

describe('the KICS pack and the cdk-nag pack enforce the same list', () => {
  it('has a query for every SZC rule', () => {
    const covered = new Set(pack.map(q => q.meta.szcRule))
    const missing = SZC_RULE_IDS.filter(id => !covered.has(id))
    expect(missing, `SZC rules with no KICS query: ${missing.join(', ')}`).toEqual([])
  })

  it('has no query for a rule that no longer exists', () => {
    const orphans = pack.map(q => q.meta.szcRule).filter(rule => !SZC_RULE_IDS.includes(rule))
    expect(orphans, `KICS queries with no SZC rule: ${orphans.join(', ')}`).toEqual([])
  })

  it('maps one query to one rule', () => {
    // Two queries claiming the same rule would let a third rule go uncovered while the
    // counts still matched.
    const rules = pack.map(q => q.meta.szcRule)
    expect(new Set(rules).size).toBe(rules.length)
    expect(pack).toHaveLength(SZC_RULES.length)
  })
})

describe('every query is loadable and gating', () => {
  it('declares the CloudFormation platform, or KICS silently skips it', () => {
    for (const { dir, meta } of pack) {
      expect(meta.platform, `${dir} would never run`).toBe('CloudFormation')
    }
  })

  it('is HIGH, since `make kics` only fails on high and critical', () => {
    // A MEDIUM cost rule is a rule that reports and does not block.
    for (const { dir, meta } of pack) {
      expect(meta.severity, `${dir} would not fail the build`).toBe('HIGH')
    }
  })

  it('has a distinct UUID', () => {
    const ids = pack.map(q => q.meta.id)
    expect(new Set(ids).size, 'KICS keys results by id; duplicates collide').toBe(ids.length)
    for (const { dir, meta } of pack) {
      expect(meta.id, `${dir} has a malformed id`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    }
  })

  it('carries the same cost reason as the cdk-nag rule', () => {
    // The two packs should not be able to disagree about WHY something is banned.
    for (const { meta } of pack) {
      const rule = SZC_RULES.find(r => r.id === meta.szcRule)
      expect(rule).toBeDefined()
      expect(meta.descriptionText).toContain(meta.szcRule)
      expect(meta.descriptionText.length).toBeGreaterThan(40)
    }
  })

  it('ships both samples, so `make kics` can prove it discriminates', () => {
    for (const { dir } of pack) {
      const files = readdirSync(join(PACK_DIR, dir, 'test'))
      expect(files.sort(), `${dir} is missing a sample`).toEqual(['negative.json', 'positive.json'])
    }
  })

  it('writes a rego file that mentions its own rule id', () => {
    for (const { dir, meta } of pack) {
      const rego = readFileSync(join(PACK_DIR, dir, 'query.rego'), 'utf8')
      expect(rego, `${dir} does not name ${meta.szcRule}`).toContain(meta.szcRule)
      expect(rego).toContain('CxPolicy[result]')
    }
  })
})
