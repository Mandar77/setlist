// Prove the zero-cost KICS queries actually fire — and only on the right things.
//
//   node tools/check_kics_queries.js
//
// `make kics` scanning the real templates and finding nothing is the result we want and
// also exactly what a pack of broken queries produces. A query with a typo'd resource
// type, a Rego compile error, or a path KICS never loaded is silent, and silence is
// indistinguishable from compliance. So this runs the pack against samples where the
// answer is known:
//
//   positives/  one template per query that MUST be flagged — every query id must appear
//   negatives/  the compliant counterpart of each, which together must produce NOTHING
//
// The negative direction is not a formality. A query written `resource.Type` instead of
// `resource.Type == "..."` matches every resource in the document and still passes any
// test that only checks the positive case.
//
// Samples are written out by `tools/gen_kics_queries.js` next to each query; this copies
// them into two flat directories because KICS scans a path, and positives and negatives
// have to be scanned apart.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const queriesDir = join(repoRoot, 'security', 'kics-queries', 'zero-cost')
// Inside the repo, because the Docker mount is the repo root. Gitignored.
const workDir = join(repoRoot, '.kics-samples')

const KICS_IMAGE = 'checkmarx/kics:latest'

class KicsError extends Error {}

/** Collect each query's slug and the SZC rule it enforces. */
function queries() {
  return readdirSync(queriesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const meta = JSON.parse(readFileSync(join(queriesDir, e.name, 'metadata.json'), 'utf8'))
      return { slug: e.name, rule: meta.szcRule, queryName: meta.queryName }
    })
}

/**
 * Run KICS over one sample directory and return the findings.
 *
 * `--no-progress` and a JSON report rather than reading the exit code: KICS exits
 * non-zero *because* it found something, which is the expected outcome for positives
 * and an error for negatives. Parsing the report tells those apart; an exit code does
 * not.
 */
function scan(sampleDir, label) {
  const reportDir = join(workDir, `report-${label}`)
  mkdirSync(reportDir, { recursive: true })

  const rel = p =>
    `/path/${p
      .slice(repoRoot.length + 1)
      .split('\\')
      .join('/')}`
  const args = [
    'run',
    '--rm',
    '-v',
    `${repoRoot}:/path`,
    KICS_IMAGE,
    'scan',
    '-p',
    rel(sampleDir),
    '-q',
    rel(join(repoRoot, 'security', 'kics-queries')),
    '-o',
    rel(reportDir),
    '--report-formats',
    'json',
    '--no-progress',
    '--no-color',
    // Without this KICS exits 50 on any finding, which `execFileSync` raises on.
    '--ignore-on-exit',
    'results',
  ]

  let output = ''
  try {
    output = execFileSync('docker', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    })
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new KicsError('docker is not on PATH — `make kics` needs a running daemon')
    }
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new KicsError(`kics exited ${error.status}:\n${output.trim().slice(0, 1500)}`)
  }

  const reportPath = join(reportDir, 'results.json')
  if (!existsSync(reportPath)) {
    // A missing report means KICS never got as far as scanning. Treating that as "no
    // findings" is how this check would pass while running nothing at all.
    throw new KicsError(
      `kics produced no report for ${label}. Output was:\n${output.trim().slice(0, 1500)}`,
    )
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  return { report, output }
}

const all = queries()
if (all.length === 0) {
  console.error('kics queries: none found — run `node tools/gen_kics_queries.js`')
  process.exit(1)
}

console.log(`kics queries: ${all.length} queries, each must fire on its positive sample\n`)

rmSync(workDir, { recursive: true, force: true })
const positives = join(workDir, 'positives')
const negatives = join(workDir, 'negatives')
mkdirSync(positives, { recursive: true })
mkdirSync(negatives, { recursive: true })

for (const { slug } of all) {
  copyFileSync(join(queriesDir, slug, 'test', 'positive.json'), join(positives, `${slug}.json`))
  copyFileSync(join(queriesDir, slug, 'test', 'negative.json'), join(negatives, `${slug}.json`))
}

let failures = 0
const fail = message => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

try {
  // 1. Every query must flag its own positive sample.
  const { report: positiveReport, output: positiveOutput } = scan(positives, 'positives')
  const fired = new Set((positiveReport.queries ?? []).map(q => q.query_name))

  // A pack that failed to load produces an empty result set that looks like compliance.
  if (fired.size === 0) {
    fail(
      'no query fired on ANY positive sample — the pack did not load, or every query ' +
        `has a Rego error. KICS said:\n${positiveOutput.trim().slice(0, 1200)}`,
    )
  }

  for (const { rule, queryName } of all) {
    if (!fired.has(queryName)) {
      fail(`${rule} (${queryName}) did not fire on its positive sample`)
    }
  }
  if (failures === 0) console.log(`  ok    all ${all.length} queries fired on their positives`)

  // 2. The compliant counterparts must produce nothing at all. This is what separates a
  //    working query from one that matches every resource in the document.
  const { report: negativeReport } = scan(negatives, 'negatives')
  const found = negativeReport.queries ?? []
  if (found.length > 0) {
    for (const q of found) {
      const where = (q.files ?? []).map(f => f.file_name.split('/').pop()).join(', ')
      fail(`${q.query_name} fired on compliant samples (${where}) — it matches too much`)
    }
  } else {
    console.log('  ok    no query fired on any compliant sample')
  }
} catch (error) {
  if (error instanceof KicsError) {
    console.error(`\nkics queries: ${error.message}`)
    process.exit(1)
  }
  throw error
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nkics queries: ${failures} check(s) failed`)
  process.exit(1)
}

console.log('\nkics queries: the pack discriminates in both directions')
