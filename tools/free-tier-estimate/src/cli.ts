#!/usr/bin/env node
/**
 * The free-tier gate.
 *
 *   node --import tsx src/cli.ts                 # every environment
 *   node --import tsx src/cli.ts --env prod      # one of them
 *   node --import tsx src/cli.ts --out report.md # also write the markdown
 *
 * Exits non-zero when any modelled limit is above `gate_pct` of its environment's
 * share. That exit code is the whole point: `make preflight` runs this before an
 * infrastructure change is pushed, and a forecast nobody fails on is a report.
 */

import { writeFileSync } from 'node:fs'
import { ENV_NAMES, type EnvName } from '../../../infra/lib/config/budget.js'
import { estimate } from './estimate.js'
import { toMarkdown } from './report.js'

interface Args {
  env: EnvName | undefined
  out: string | undefined
}

function parseArgs(argv: readonly string[]): Args {
  let env: EnvName | undefined
  let out: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--env') {
      if (value === undefined) throw new Error('--env needs a value')
      // Unknown environments fail rather than silently matching nothing — a typo that
      // reports zero rows would look like a pass.
      if (!ENV_NAMES.includes(value as EnvName)) {
        throw new Error(`unknown env '${value}'. Known: ${ENV_NAMES.join(', ')}`)
      }
      env = value as EnvName
      i += 1
    } else if (flag === '--out') {
      if (value === undefined) throw new Error('--out needs a path')
      out = value
      i += 1
    } else if (flag !== undefined) {
      throw new Error(`unknown argument '${flag}'`)
    }
  }
  return { env, out }
}

let args: Args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`free-tier-estimate: ${(error as Error).message}`)
  process.exit(2)
}

const full = estimate()

// Narrowing to one environment filters the rows but keeps the gate percentage and the
// thresholds, so `--env prod` and the full run cannot disagree about what passes.
const scoped =
  args.env === undefined
    ? full
    : {
        ...full,
        rows: full.rows.filter(row => row.env === args.env),
        breaches: full.breaches.filter(row => row.env === args.env),
        planDrift: full.planDrift.filter(drift => drift.env === args.env),
        bindsFirst: full.rows.find(row => row.env === args.env && row.modelled),
      }

const markdown = toMarkdown(scoped)
console.log(markdown)

if (args.out !== undefined) {
  writeFileSync(args.out, `${markdown}\n`, { encoding: 'utf8' })
  console.log(`\nwritten to ${args.out}`)
}

if (scoped.breaches.length > 0) {
  const label = args.env ?? 'any environment'
  console.error(
    `\nfree-tier-estimate: ${scoped.breaches.length} limit(s) above the ` +
      `${full.gatePct}% gate in ${label}. Relaxing the gate is a human-needed issue ` +
      'with an ADR proposal, not an edit to budget.yaml.',
  )
  process.exit(1)
}

console.log(`\nfree-tier-estimate: every modelled limit is under the ${full.gatePct}% gate`)
