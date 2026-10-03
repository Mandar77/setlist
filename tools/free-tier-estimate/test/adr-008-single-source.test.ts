// ADR-008's undecided numbers must each be defined exactly once.
//
// ADR-008 is open and is the human's call. The project's answer to that (AUTOPILOT §2.3)
// is to build around it rather than wait: pin the values it decides into one place each,
// finish everything that does not depend on them, and leave `make estimate` reporting the
// real conflict.
//
// That only works if "one place each" stays true. The failure this guards against is
// mundane and likely: someone adds a fourth environment, or copies a volumes block, and
// the 250 is suddenly in two files. Then the one-line decision is a three-line decision
// with one line missed, and the gate goes on failing for a reason nobody can find.
//
// So each value is asserted to appear exactly once as a literal across the whole
// free-tier config, and the aliases are asserted to point at the anchors rather than at
// copies of them.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const configDir = join(here, '..', '..', '..', 'infra', 'free-tier')

const usageModelPath = join(configDir, 'usage-model.yaml')
const usageModelText = readFileSync(usageModelPath, 'utf8')
const usageModel = parse(usageModelText) as {
  adr008_playlists_per_month: Record<string, number>
  volumes: Record<string, Record<string, number>>
}

/** Every line that is neither blank nor a comment — literals only live in these. */
function configLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/#.*$/, ''))
    .filter(line => line.trim() !== '')
}

describe('ADR-008: the undecided values are single-sourced', () => {
  const environments = ['prod', 'stage', 'dev'] as const

  it('declares one anchor per environment', () => {
    expect(Object.keys(usageModel.adr008_playlists_per_month).sort()).toEqual(
      [...environments].sort(),
    )
  })

  it.each(environments)('volumes.%s resolves to the anchor, not a copy', env => {
    // The alias has to actually resolve. If someone replaces `*adr008_dev_playlists`
    // with a literal 30 this still passes on value — which is why the literal-count test
    // below exists as well. The two together are what pin it.
    expect(usageModel.volumes[env]!['playlist_job_15_songs']).toBe(
      usageModel.adr008_playlists_per_month[env],
    )
  })

  it.each(environments)('volumes.%s uses an alias rather than a number', env => {
    // Read from the text, because the parsed document cannot tell an alias from a value.
    const block = usageModelText.split(`  ${env}:`)[2] ?? ''
    const line = block.split('\n').find(l => l.includes('playlist_job_15_songs'))
    expect(line, `no playlist_job_15_songs under volumes.${env}`).toBeDefined()
    expect(line).toMatch(/\*adr008_\w+_playlists/)
  })

  it('no playlist volume is written as a literal outside the anchor block', () => {
    // Counting the bare number across the config does not work and the first draft of
    // this test tried it: 30 is also `days_per_month`, and 50 is a per-operation cost.
    // The invariant is not "the digits 250 appear once", it is "every consumer of this
    // value refers to the anchor instead of restating it".
    const offenders: string[] = []
    for (const file of readdirSync(configDir).filter(name => name.endsWith('.yaml'))) {
      for (const line of configLines(readFileSync(join(configDir, file), 'utf8'))) {
        if (!/playlist_job_15_songs\s*:/.test(line)) continue
        const value = line.split(':').slice(1).join(':').trim()
        // An empty value is the operation's own definition under `operations:`, whose
        // cost fields are nested beneath it. That line names the operation; it does not
        // state a volume, so it is not a place the ADR-008 number could hide.
        if (value === '') continue
        if (!value.startsWith('*')) offenders.push(`${file}: ${line.trim()}`)
      }
    }
    expect(offenders, 'these restate an ADR-008 value instead of aliasing it').toEqual([])
  })

  it('the anchor block holds exactly one literal per environment', () => {
    const block =
      usageModelText.split('adr008_playlists_per_month:')[1]?.split('\nvolumes:')[0] ?? ''
    const anchors = block.match(/&adr008_\w+_playlists\s+\d+/g) ?? []
    expect(anchors).toHaveLength(environments.length)
  })

  it('gate_pct is declared exactly once', () => {
    const budget = readFileSync(join(configDir, 'budget.yaml'), 'utf8')
    const declarations = configLines(budget).filter(line => /^\s*gate_pct\s*:/.test(line))
    expect(declarations).toHaveLength(1)
  })

  it('the anchor block is not itself wired into the estimator', () => {
    // `adr008_playlists_per_month` is a holding pen, not a schema addition: the loader
    // reads named fields and ignores it. Asserting that keeps it from quietly becoming
    // load-bearing, which would make removing it after ADR-008 lands a breaking change
    // rather than a tidy-up.
    const modelSource = readFileSync(join(here, '..', 'src', 'model.ts'), 'utf8')
    expect(modelSource).not.toContain('adr008')
  })
})
