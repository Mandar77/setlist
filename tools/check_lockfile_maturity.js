// Every version in the committed pnpm lockfile must be older than `minimumReleaseAge`.
//
//   node tools/check_lockfile_maturity.js
//   node tools/check_lockfile_maturity.js --lockfile <path> --floor-minutes <n>
//
// `minimumReleaseAge` in pnpm-workspace.yaml is a *resolution-time* rule. It decides
// which versions pnpm is willing to pick while it is building a lockfile, and it has no
// opinion whatsoever about a lockfile that already exists. Once a version is written
// down it is replayed by every `--frozen-lockfile` install forever, and the setting that
// would now reject it is never consulted again.
//
// The `resolvable` job in ci.yml was built for this and does not catch it. It deletes
// the lockfile and resolves from nothing, which proves that *a* compliant lockfile could
// exist — it proves nothing about the one in the repository, because the first thing it
// does is throw that one away. The two answers come apart precisely when it matters: on
// 2026-10-01 the lockfile took rolldown 1.2.12 the day after it was published, against a
// seven-day floor. A fresh resolve kept choosing the mature 1.2.11 and the job stayed
// green for two days while Dependabot — whose update preserves existing resolutions and
// so meets the real pin — died on every single run. Dependency updates had stopped, and
// the gate for that was passing.
//
// So this checks the artifact rather than the procedure: every `name@version` in
// `packages:`, against the registry's own publish time.
//
// Two rules here are deliberately harsher than they look, because both are the shape of
// a gate that passes while measuring nothing:
//
//   * a version whose publish time cannot be established FAILS. Unknown is not mature.
//     The silent-skip version of this check would have reported success over an entire
//     lockfile the day the registry changed a response shape.
//   * a missing or unparseable `minimumReleaseAge` FAILS rather than falling back to a
//     built-in default. A gate that invents its own threshold when the configured one
//     disappears is a gate that cannot notice the configuration being deleted.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// pnpm hoists nothing; `yaml` is a dependency of infra. Same resolution trick as
// tools/check_diff_allowlist.js, and for the same reason.
const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml')

const REGISTRY = process.env['NPM_CONFIG_REGISTRY'] ?? 'https://registry.npmjs.org'

/** Parallel packument fetches. The registry is fine with this; it is ~350 requests. */
const CONCURRENCY = 12
/** A transient 5xx or socket reset should not read as a policy violation. */
const RETRIES = 3

function parseArgs(argv) {
  const args = { lockfile: null, floorMinutes: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--lockfile') {
      args.lockfile = argv[(i += 1)]
    } else if (flag === '--floor-minutes') {
      args.floorMinutes = Number(argv[(i += 1)])
      if (!Number.isFinite(args.floorMinutes) || args.floorMinutes < 0) {
        throw new Error(`--floor-minutes needs a non-negative number, got ${argv[i]}`)
      }
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return args
}

/**
 * The configured floor, in minutes. Throws rather than defaulting — see the header.
 */
function configuredFloorMinutes() {
  const workspacePath = join(repoRoot, 'pnpm-workspace.yaml')
  const workspace = parse(readFileSync(workspacePath, 'utf8'))
  const value = workspace?.minimumReleaseAge
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `pnpm-workspace.yaml has no usable \`minimumReleaseAge\` (found ${JSON.stringify(value)}). ` +
        'This check will not substitute a default for a policy that is supposed to be declared.',
    )
  }
  return value
}

/**
 * Split a pnpm `packages:` key into name and version. The name may itself start with
 * `@scope/`, so the separator is the LAST `@`, not the first.
 */
function splitSpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

async function fetchPackument(name) {
  // A scoped name is one path segment, so the slash has to be escaped.
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`
  let lastError = null
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
      // 404 is an answer, not a glitch: the package is not there. Do not retry it.
      if (response.status === 404) return null
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  throw new Error(`${name}: ${lastError?.message ?? 'unreachable'}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const floorMinutes = args.floorMinutes ?? configuredFloorMinutes()
  const floorMs = floorMinutes * 60 * 1000
  const lockfilePath = args.lockfile ?? join(repoRoot, 'pnpm-lock.yaml')

  const lockfile = parse(readFileSync(lockfilePath, 'utf8'))
  const specs = Object.keys(lockfile?.packages ?? {})
  if (specs.length === 0) {
    console.error(`${lockfilePath} has no \`packages:\` entries — nothing was checked.`)
    process.exit(1)
  }

  // One packument per name, however many versions of it the lockfile holds.
  const wanted = new Map()
  const malformed = []
  for (const spec of specs) {
    const split = splitSpec(spec)
    if (split === null) {
      malformed.push(spec)
      continue
    }
    if (!wanted.has(split.name)) wanted.set(split.name, new Set())
    wanted.get(split.name).add(split.version)
  }

  const now = Date.now()
  const tooYoung = []
  const unknown = []
  const names = [...wanted.keys()]

  let cursor = 0
  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++]
      let packument
      try {
        packument = await fetchPackument(name)
      } catch (error) {
        // Could not ask. That is not permission to assume the answer.
        for (const version of wanted.get(name)) {
          unknown.push({ name, version, why: error.message })
        }
        continue
      }
      const times = packument?.time ?? {}
      for (const version of wanted.get(name)) {
        const published = times[version]
        const at = published ? Date.parse(published) : Number.NaN
        if (!Number.isFinite(at)) {
          unknown.push({
            name,
            version,
            why: packument === null ? 'not in the registry' : 'no publish time',
          })
          continue
        }
        const ageMs = now - at
        if (ageMs < floorMs) {
          tooYoung.push({ name, version, published, ageDays: ageMs / 86_400_000 })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const floorDays = (floorMinutes / 1440).toFixed(1)
  console.log(
    `checked ${specs.length} locked versions across ${names.length} packages ` +
      `against a ${floorMinutes}-minute (${floorDays}-day) floor`,
  )

  if (malformed.length === 0 && tooYoung.length === 0 && unknown.length === 0) {
    console.log('every locked version clears minimumReleaseAge')
    return
  }

  for (const spec of malformed) {
    console.error(`unparseable \`packages:\` key: ${spec}`)
  }
  for (const entry of tooYoung.sort((a, b) => a.ageDays - b.ageDays)) {
    console.error(
      `too young: ${entry.name}@${entry.version} published ${entry.published} ` +
        `(${entry.ageDays.toFixed(1)} days old, floor is ${floorDays})`,
    )
  }
  for (const entry of unknown) {
    console.error(`cannot establish age: ${entry.name}@${entry.version} — ${entry.why}`)
  }

  console.error(
    '\nThe committed lockfile holds versions the configured policy would refuse to ' +
      'resolve. Re-resolve it (delete pnpm-lock.yaml, `pnpm install --lockfile-only`) ' +
      'and commit the result; do not lower the floor to match the lockfile.',
  )
  process.exit(1)
}

await main()
