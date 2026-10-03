// Keep golden/diff-allowlist.yaml a list of deliberate decisions, not a list of bugs.
//
//   node tools/check_diff_allowlist.js
//
// ADR-001 permits the TypeScript core to differ from the frozen Python oracle only where
// the difference is listed here and is an ADR-002 orientation change. That sentence has
// two halves and they fail in opposite directions:
//
//   * an unlisted difference is caught by the differential suite, which compares every
//     golden case field for field and ten thousand generated inputs by digest;
//   * a *listed* difference is caught by nothing at all unless something reads the list.
//
// This is that something. It checks the file's schema and its scope — what an entry must
// say, and that what it says is an orientation change and not a rounding difference
// wearing the word "orientation". Whether an allowlisted case actually still diverges is
// checked where the divergence is visible, in packages/core/test/pipeline-differential.
//
// The scope check is the one that matters. An allowlist nobody polices accumulates the
// differences that were inconvenient to fix, and this port has already produced three
// that would have looked eminently allowlistable: a `\p{Lu}` lookahead that broke a
// Greek tracklist, an uncompensated float sum, and a pydantic whitespace strip. Each was
// a real bug. "Small difference" is what a porting bug looks like from the inside.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// pnpm hoists nothing; `yaml` is a dependency of infra. Same resolution trick as
// tools/check_workflows.js, and for the same reason.
const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml')

const ALLOWLIST = join(repoRoot, 'golden', 'diff-allowlist.yaml')
const ORACLE_DIR = join(repoRoot, 'golden', 'oracle')

/** ADR-001: orientation is the only permitted kind. */
const PERMITTED_KIND = 'orientation'
/** ...and ADR-002 is the only decision that permits one. */
const PERMITTED_ADR = 'ADR-002'

const REQUIRED_FIELDS = ['case', 'kind', 'adr', 'opened', 'owner', 'reason', 'items']

/** A reason shorter than this is a label, not an explanation. */
const MIN_REASON = 40

const problems = []
const fail = message => problems.push(message)

const document = parse(readFileSync(ALLOWLIST, 'utf8'))

;(() => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('the file must be a mapping with a single `entries` key')
    return
  }

  const keys = Object.keys(document)
  const extra = keys.filter(k => k !== 'entries')
  if (extra.length) fail(`unknown top-level keys: ${extra.join(', ')}`)
  if (!keys.includes('entries')) {
    fail('missing the `entries` key — an empty allowlist is written `entries: []`')
    return
  }

  const entries = document.entries
  if (!Array.isArray(entries)) {
    fail('`entries` must be a list')
    return
  }

  // Golden case ids are the names of the frozen oracle outputs. An entry naming anything
  // else cannot be checked against a committed answer, which is the whole point of
  // requiring the entry to carry one.
  const goldenIds = new Set(
    readdirSync(ORACLE_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/u, '')),
  )

  const seen = new Set()
  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${where}: must be a mapping`)
      return
    }

    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) fail(`${where}: missing \`${field}\``)
    }
    const unknown = Object.keys(entry).filter(k => !REQUIRED_FIELDS.includes(k))
    if (unknown.length) fail(`${where}: unknown fields: ${unknown.join(', ')}`)

    if (entry.kind !== PERMITTED_KIND) {
      fail(
        `${where}: kind is "${entry.kind}". ADR-001 permits only "${PERMITTED_KIND}" — ` +
          'every other difference between the port and the oracle is a porting bug, ' +
          'and allowlisting one hides it behind a green differential.',
      )
    }
    if (entry.adr !== PERMITTED_ADR) {
      fail(`${where}: adr is "${entry.adr}"; only ${PERMITTED_ADR} permits an orientation change`)
    }

    if (typeof entry.case !== 'string' || !entry.case.trim()) {
      fail(`${where}: \`case\` must be a golden case id`)
    } else if (entry.case.startsWith('pipeline:')) {
      fail(
        `${where}: \`case\` names a generated pipeline input. golden/diff/pipeline.jsonl ` +
          'stores a digest, not the oracle output, so there is nothing to compare an ' +
          'orientation swap against. CORE-05 must extend pipeline_diff.py to carry items.',
      )
    } else if (!goldenIds.has(entry.case)) {
      fail(`${where}: no frozen oracle output named "${entry.case}" in golden/oracle/`)
    } else if (seen.has(entry.case)) {
      fail(`${where}: "${entry.case}" is listed twice`)
    } else {
      seen.add(entry.case)
    }

    if (typeof entry.owner !== 'string' || !entry.owner.trim()) {
      fail(`${where}: \`owner\` must name someone who can answer for this`)
    }
    if (typeof entry.opened !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.opened)) {
      fail(`${where}: \`opened\` must be an ISO date (YYYY-MM-DD)`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON) {
      fail(`${where}: \`reason\` must explain the difference in at least ${MIN_REASON} characters`)
    }

    // The confidence is required because swapping a pair moves it: the penalties are
    // computed on the title and the artist, so reading "Justice - Genesis" the other way
    // round makes "Justice" a single-token title and costs 0.05. Excusing confidence on
    // an allowlisted case would hide a scoring bug, so it is pinned here instead — these
    // numbers become the authority the oracle no longer is for this case.
    if (!Array.isArray(entry.items) || entry.items.length === 0) {
      fail(`${where}: \`items\` must list the TypeScript reading, so the swap can be verified`)
    } else {
      entry.items.forEach((item, i) => {
        const shape = `items[${i}] must be { title: <string>, artist: <string|null>, confidence: <0..1> }`
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          fail(`${where}: ${shape}`)
          return
        }
        if (typeof item.title !== 'string' || !item.title) fail(`${where}: ${shape}`)
        if (!('artist' in item) || (item.artist !== null && typeof item.artist !== 'string')) {
          fail(`${where}: ${shape}`)
        }
        if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1) {
          fail(`${where}: ${shape}`)
        }
      })
    }
  })
})()

if (problems.length) {
  console.error('diff allowlist:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const count = Array.isArray(document?.entries) ? document.entries.length : 0
console.log(
  count === 0
    ? 'diff allowlist: empty — the port matches the oracle exactly'
    : `diff allowlist: ${count} permitted orientation difference(s)`,
)
