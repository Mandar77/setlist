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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const RETRIES = 4

/**
 * Where publish dates are remembered between runs.
 *
 * A version's publish time is immutable — 1.2.3 was published when it was published, and
 * no later event changes that — so an entry here never needs invalidating and the cache
 * never needs a TTL. That is also why it cannot mask a changed lockfile: entries are
 * keyed by `name@version`, so a lockfile that moves to a version introduces a key that
 * is not in the cache and gets fetched. There is no key under which a stale answer and
 * a new question could collide.
 *
 * A miss falls through to the registry. It never falls through to "assume mature".
 */
const DEFAULT_CACHE = join(repoRoot, '.cache', 'lockfile-maturity.json')
const CACHE_SCHEMA = 1

function parseArgs(argv) {
  const args = { lockfile: null, floorMinutes: null, cache: DEFAULT_CACHE }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--lockfile') {
      args.lockfile = argv[(i += 1)]
    } else if (flag === '--cache') {
      args.cache = argv[(i += 1)]
    } else if (flag === '--no-cache') {
      args.cache = null
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
 * Read the publish-date cache. Any problem returns an empty cache rather than throwing:
 * a corrupt or truncated file should cost a slower run, not a red build, and the only
 * consequence of starting empty is that everything is fetched.
 */
function loadCache(path) {
  if (!path) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.schema !== CACHE_SCHEMA) return {}
    return parsed.published ?? {}
  } catch {
    return {}
  }
}

/** Write the cache back. A failure here is not worth failing the check over. */
function saveCache(path, published) {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Keys sorted so the file is stable between runs: an unordered dump would churn on
    // every write and make the CI cache miss far more often than it needs to.
    const sorted = Object.fromEntries(
      Object.entries(published).sort(([a], [b]) => (a < b ? -1 : 1)),
    )
    writeFileSync(path, `${JSON.stringify({ schema: CACHE_SCHEMA, published: sorted }, null, 2)}\n`)
  } catch (error) {
    console.warn(`could not write ${path}: ${error.message}`)
  }
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

/**
 * Fetch one packument, retrying what is worth retrying.
 *
 * The distinction that matters: a 404 is an ANSWER — the package is not there — and is
 * returned immediately, because retrying it four times would only delay a real failure.
 * A 5xx, a 429 or a socket reset is not an answer, it is registry weather, and failing
 * the build on it would teach everyone to re-run the job without reading it. Those get
 * exponential backoff with jitter.
 *
 * What never happens is a transient error turning into a pass. After the last attempt
 * this throws, the caller records "cannot establish age", and the check fails closed.
 */
async function fetchPackument(name) {
  // A scoped name is one path segment, so the slash has to be escaped.
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`
  let lastError = null
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
      if (response.status === 404) return null
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < RETRIES - 1) {
      // Exponential, plus jitter so twelve workers hitting a rate limit together do not
      // all come back at the same instant and trip it again.
      const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 100)
      await new Promise(resolve => setTimeout(resolve, backoff))
    }
  }
  throw new Error(`${name}: ${lastError?.message ?? 'unreachable'} (after ${RETRIES} attempts)`)
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

  // Resolve from the cache first, and only go to the registry for names that still have
  // an unanswered version. On a run where the lockfile has not moved that is no names at
  // all; on a normal dependency bump it is the handful that changed.
  const cache = loadCache(args.cache)
  const resolved = new Map()
  let fromCache = 0
  for (const [name, versions] of wanted) {
    const missing = new Set()
    for (const version of versions) {
      const cached = cache[`${name}@${version}`]
      if (cached) {
        resolved.set(`${name}@${version}`, cached)
        fromCache += 1
      } else {
        missing.add(version)
      }
    }
    if (missing.size > 0) wanted.set(name, missing)
    else wanted.delete(name)
  }

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
        if (!published || !Number.isFinite(Date.parse(published))) {
          unknown.push({
            name,
            version,
            why: packument === null ? 'not in the registry' : 'no publish time',
          })
          continue
        }
        resolved.set(`${name}@${version}`, published)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Age every version the same way, whether it came from the cache or the network. The
  // cache stores the publish DATE, never the verdict — a cached "mature" would be a
  // cached answer to a question whose answer depends on when it is asked.
  for (const [spec, published] of resolved) {
    const { name, version } = splitSpec(spec)
    const ageMs = now - Date.parse(published)
    if (ageMs < floorMs) {
      tooYoung.push({ name, version, published, ageDays: ageMs / 86_400_000 })
    }
  }

  saveCache(args.cache, Object.fromEntries(resolved))

  const floorDays = (floorMinutes / 1440).toFixed(1)
  console.log(
    `checked ${specs.length} locked versions against a ${floorMinutes}-minute ` +
      `(${floorDays}-day) floor — ${fromCache} from cache, ${resolved.size - fromCache} fetched ` +
      `across ${names.length} packages`,
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
