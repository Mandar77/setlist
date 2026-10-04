// Properties of the workflows that actionlint does not check.
//
//   node tools/check_workflows.js
//
// actionlint validates syntax, expressions and action inputs. It has nothing to say
// about the things that would actually hurt here, every one of which is a property of
// what the workflow is allowed to do rather than whether it parses:
//
//   1. **Every action pinned to a commit SHA.** A tag is mutable. `@v4` is a promise by
//      whoever owns the repository that they will not move it, and tag-moving is the
//      delivery mechanism for most action supply-chain attacks.
//   2. **No `pull_request_target` with a checkout of the PR head.** That combination
//      runs untrusted code with a write-scoped token on a public repository. It is the
//      single most exploited GitHub Actions pattern there is.
//   3. **Every AWS job gated on `vars.AWS_ENABLED`.** A fork inherits no repository
//      variables, so an ungated job fails on every fork's first push for a reason its
//      owner cannot fix. It is also the switch that keeps the repo green before
//      Session 1.
//   4. **The kill-switch drill never offers prod.** One `if` is a typo away from none.
//   5. **Deploy never triggers on `pull_request`.** A deploy that runs from a PR branch
//      deploys unreviewed code.
//   6. **Explicit `permissions`.** The default token is write-scoped on a repository
//      that has not changed the org default, and a workflow that never says otherwise
//      hands that to every step it runs.
//
// Parsed as YAML rather than grepped: `uses:` inside a comment should not pass, and a
// permissions block nested under the wrong key should not count.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const workflowDir = join(repoRoot, '.github', 'workflows')

// pnpm hoists nothing; `yaml` is a dependency of infra.
const { parse } = createRequire(join(repoRoot, 'infra', 'package.json'))('yaml')

const SHA_PINNED = /^[^@]+@[0-9a-f]{40}$/
/** Local composite actions and Docker references are not tag-mutable. */
const EXEMPT_USES = /^(\.\/|docker:\/\/)/

/** Anything that reaches AWS. A job doing these without the gate breaks every fork. */
const AWS_MARKERS = [
  'aws-actions/configure-aws-credentials',
  'secrets.AWS_DEPLOY_ROLE',
  'secrets.AWS_DIAGNOSTICS_ROLE',
]

/**
 * Every directory a `skip-dirs` glob actually resolves to, as repo-relative POSIX paths.
 *
 * Expanded segment by segment rather than by walking the repository and testing each
 * path: a glob can only reach what its literal segments lead to, so following it is both
 * exact and cheap, and it never has to decide whether node_modules counts.
 *
 * `*` matches within one segment, as it does for Trivy. `**` is not supported, and a
 * glob containing one is reported rather than silently treated as `*` — guessing at a
 * pattern's reach is precisely the mistake this check exists to prevent.
 */
function expandDirGlob(root, glob) {
  if (glob.includes('**')) throw new Error(`skip-dirs glob ${glob} uses ** , which is not checked`)
  const isDir = p => existsSync(p) && statSync(p).isDirectory()

  let found = ['']
  for (const segment of glob.split('/').filter(Boolean)) {
    const next = []
    for (const prefix of found) {
      const base = prefix === '' ? root : join(root, prefix)
      if (!segment.includes('*')) {
        if (isDir(join(base, segment))) next.push(prefix === '' ? segment : `${prefix}/${segment}`)
        continue
      }
      if (!isDir(base)) continue
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !segmentMatches(segment, entry.name)) continue
        next.push(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
      }
    }
    found = next
  }
  return found
}

/**
 * Does one glob segment match one path segment? `*` matches any run of characters,
 * including none, and never crosses a `/` because it is only ever asked about a single
 * directory name.
 *
 * Written out rather than compiled to a RegExp: building a pattern from a string is how
 * a ReDoS gets in, and Semgrep flags it on sight. Anchoring at both ends and walking the
 * literal parts left to right is the whole algorithm, and it cannot backtrack.
 */
function segmentMatches(pattern, name) {
  if (!pattern.includes('*')) return pattern === name
  const parts = pattern.split('*')
  const head = parts[0]
  const tail = parts[parts.length - 1]
  if (!name.startsWith(head) || !name.endsWith(tail)) return false

  let at = head.length
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at)
    if (found === -1) return false
    at = found + part.length
  }
  // The head and tail must not have consumed the same characters: `a*a` matches `aba`
  // but not `a`.
  return at <= name.length - tail.length
}

let failures = 0
const fail = (file, message) => {
  failures += 1
  console.error(`  FAIL  ${file}: ${message}`)
}
const ok = message => console.log(`  ok    ${message}`)

/**
 * `--verify-pins` resolves every pinned SHA against the GitHub API.
 *
 * Opt-in rather than always-on because `make verify` is offline by contract, and this
 * needs the network. CI runs it; the default run stays local.
 *
 * It exists because a forty-character hex string is forty characters whether or not it
 * is a commit. An `actions/cache` pin written from memory passed the format check above
 * and was caught only by asking the API for the real tag — in the check whose entire
 * purpose is pinning. The format test cannot be made stricter to fix that; the answer is
 * not local.
 */
const VERIFY_PINS = process.argv.includes('--verify-pins')
/** Overridable so the must-fail fixtures can point at a stand-in. */
const GITHUB_API = process.env['GITHUB_API_URL'] ?? 'https://api.github.com'
/** A resolved sha→tag answer never changes, so it is cached forever. */
const PIN_CACHE = join(repoRoot, '.cache', 'action-pins.json')

const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
if (files.length === 0) {
  console.error('workflow check: no workflows found — did the path move?')
  process.exit(1)
}

console.log(`workflow check: ${files.length} workflows\n`)

/** Every `repo@sha # tag` found, for the optional API pass. */
const pins = []

for (const file of files) {
  const raw = readFileSync(join(workflowDir, file), 'utf8')
  const doc = parse(raw)
  // `on` is a YAML 1.1 boolean, and some parsers hand it back as `true`. Accept both
  // rather than silently skipping every trigger check.
  const triggers = doc['on'] ?? doc[true] ?? {}
  const jobs = doc.jobs ?? {}

  // 1. Pinning.
  const steps = Object.values(jobs).flatMap(job => job.steps ?? [])
  for (const step of steps) {
    const uses = step?.uses
    if (typeof uses !== 'string' || EXEMPT_USES.test(uses)) continue
    if (!SHA_PINNED.test(uses)) {
      fail(file, `'${uses}' is not pinned to a 40-character commit SHA`)
      continue
    }
    // Collected for --verify-pins. The tag comes from the trailing comment, which the
    // YAML parser discards, so it is read from the raw text by the same line.
    // `owner/repo`, which is the first two segments and no more. A subdirectory action
    // like `github/codeql-action/init` lives in `github/codeql-action`; asking the API
    // for `repos/github/codeql-action/init` returns a 404 that reads exactly like a
    // missing tag. The first run of this check reported two such "failures" and both
    // were this bug.
    const [path, sha] = uses.split('@')
    const repo = path.split('/').slice(0, 2).join('/')

    // EVERY line carrying this pin, not the first one. The same action is pinned several
    // times in a file, and reading the comment off `find()` meant all of them inherited
    // the first line's tag — so changing one comment reported the same failure once per
    // occurrence, attributed to lines that were correct. Collected as a set so an
    // inconsistency between two comments for one SHA is itself reportable.
    const tags = new Set()
    for (const l of raw.split('\n')) {
      if (!l.includes(uses)) continue
      tags.add(l.match(/#\s*(v[\w.-]+)/)?.[1] ?? null)
    }
    pins.push({ file, repo, sha, tags: [...tags], uses })
  }

  // 2. The dangerous trigger.
  if (Object.prototype.hasOwnProperty.call(triggers, 'pull_request_target')) {
    const checkoutsHead = raw.includes('github.event.pull_request.head')
    if (checkoutsHead) {
      fail(
        file,
        'uses pull_request_target AND checks out the PR head — that runs untrusted ' +
          'code with a write-scoped token',
      )
    } else {
      fail(
        file,
        'uses pull_request_target. Use pull_request unless there is a reason that ' +
          'survives review, and record it here if so',
      )
    }
  }

  // 3. The AWS gate.
  for (const [name, job] of Object.entries(jobs)) {
    const body = JSON.stringify(job)
    if (!AWS_MARKERS.some(marker => body.includes(marker))) continue
    const guard = String(job.if ?? '')
    if (!guard.includes('vars.AWS_ENABLED')) {
      fail(
        file,
        `job '${name}' reaches AWS without an \`if\` on vars.AWS_ENABLED — it would ` +
          'fail on every fork and before Session 1',
      )
    }
  }

  // 6. Permissions, at the workflow or the job.
  if (doc.permissions === undefined) {
    const ungated = Object.entries(jobs).filter(([, job]) => job.permissions === undefined)
    if (ungated.length > 0) {
      fail(
        file,
        `no permissions block, and ${ungated.length} job(s) declare none either — the ` +
          'default token may be write-scoped',
      )
    }
  }
}

// 3b. Every environment a workflow deploys to must be one github-setup.sh creates.
//
// This is not bookkeeping. The bootstrap template pins each role's trust policy to
// `repo:<owner>/<repo>:environment:<name>` with StringEquals, so an environment that
// does not exist means the role cannot be assumed — and it surfaces as an opaque STS
// error in CI, not as "you forgot an environment". `diagnostics` was missing exactly
// this way: two workflows referenced it and nothing created it.
{
  const setup = readFileSync(join(repoRoot, 'scripts', 'hitl', 'github-setup.sh'), 'utf8')
  const created = new Set()
  for (const match of setup.matchAll(/environments\/\$\{env\}|environments\/([a-z]+)/g)) {
    if (match[1]) created.add(match[1])
  }
  // The loop form, `for env in dev stage diagnostics`.
  for (const match of setup.matchAll(/for env in ([a-z\s]+); do/g)) {
    for (const name of match[1].trim().split(/\s+/)) created.add(name)
  }

  const referenced = new Set()
  for (const file of files) {
    const doc = parse(readFileSync(join(workflowDir, file), 'utf8'))
    for (const job of Object.values(doc.jobs ?? {})) {
      const env = typeof job.environment === 'string' ? job.environment : job.environment?.name
      // Skip the ones chosen at dispatch time; their values come from a choice list
      // that is checked separately.
      if (typeof env === 'string' && !env.includes('${{')) referenced.add(env)
    }
  }

  const missing = [...referenced].filter(name => !created.has(name))
  if (missing.length > 0) {
    fail(
      '(all)',
      `workflows deploy to ${missing.join(', ')}, which github-setup.sh does not ` +
        'create — the deploy role trusts an environment by name, so the assume fails',
    )
  } else if (referenced.size > 0) {
    ok(`every referenced environment (${[...referenced].sort().join(', ')}) is created by setup`)
  }
}

// 4. The drill must not offer prod.
{
  const file = 'kill-switch-drill.yml'
  const raw = readFileSync(join(workflowDir, file), 'utf8')
  const doc = parse(raw)
  const triggers = doc['on'] ?? doc[true] ?? {}
  const options = triggers.workflow_dispatch?.inputs?.environment?.options ?? []

  if (options.length === 0) {
    fail(file, 'has no environment choice list, so it is not constrained at all')
  } else if (options.includes('prod')) {
    fail(file, 'offers prod as a drill target. Recovering prod needs a human (AUTOPILOT 2.4)')
  } else {
    ok(`${file} offers only ${options.join(', ')}`)
  }

  // The choice list is advisory: workflow_dispatch from the API accepts any value. So
  // the job must re-check before it assumes a role.
  if (!raw.includes('Refuse anything but dev or stage')) {
    fail(file, 'does not re-validate the environment at run time; the choice list is advisory')
  } else {
    ok(`${file} re-validates its input at run time`)
  }
}

// 5. Deploy must not run from a pull request.
{
  const file = 'deploy.yml'
  const doc = parse(readFileSync(join(workflowDir, file), 'utf8'))
  const triggers = doc['on'] ?? doc[true] ?? {}
  for (const trigger of ['pull_request', 'pull_request_target']) {
    if (Object.prototype.hasOwnProperty.call(triggers, trigger)) {
      fail(file, `triggers on ${trigger}, which would deploy unreviewed code`)
    }
  }
  const branches = triggers.push?.branches ?? []
  if (!branches.includes('main') || !branches.includes('develop')) {
    fail(file, `push branches are ${JSON.stringify(branches)}; expected develop and main`)
  } else {
    ok(`${file} deploys from develop and main only`)
  }
}

// 7. Trivy may skip deliberate-violation fixtures, and nothing else.
//
// A path exclusion is how a scanner quietly stops being a gate, so this checks what the
// exclusion *means* rather than that it matches some expected string. Every directory
// the glob resolves to must be the `test/` directory of a real KICS query — one with a
// query.rego and a metadata.json beside it — and every such directory must be covered.
// Adding `infra/` to the skip list therefore fails here unless someone first writes a
// Rego query next to it, which is not a thing that happens by accident.
//
// The fixtures themselves are not unexamined: tools/check_kics_queries.js asserts every
// positive.json fires its query and no negative.json does.
{
  const file = 'ci.yml'
  const doc = parse(readFileSync(join(workflowDir, file), 'utf8'))
  const steps = Object.values(doc.jobs ?? {}).flatMap(job => job.steps ?? [])
  const trivy = steps.find(step => String(step.uses ?? '').startsWith('aquasecurity/trivy-action'))

  if (!trivy) {
    fail(file, 'has no Trivy step — this check is reading the wrong workflow')
  } else {
    const globs = String(trivy.with?.['skip-dirs'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    const queryRoot = join(repoRoot, 'security', 'kics-queries')

    /** Every `<pack>/<query>/test` that is backed by an actual Rego query. */
    const fixtureDirs = new Set()
    for (const pack of readdirSync(queryRoot, { withFileTypes: true })) {
      if (!pack.isDirectory()) continue
      for (const query of readdirSync(join(queryRoot, pack.name), { withFileTypes: true })) {
        if (!query.isDirectory()) continue
        const dir = join(queryRoot, pack.name, query.name)
        if (!existsSync(join(dir, 'query.rego'))) continue
        if (!existsSync(join(dir, 'test'))) continue
        fixtureDirs.add(`security/kics-queries/${pack.name}/${query.name}/test`)
      }
    }

    // Direction 1: nothing is skipped that is not a fixture directory. The glob is
    // expanded against the real tree rather than compared to an expected string, so a
    // skip-dirs entry is judged by what it actually covers today.
    const skipped = new Set(globs.flatMap(glob => expandDirGlob(repoRoot, glob)))
    const overreaching = [...skipped].filter(dir => !fixtureDirs.has(dir))
    if (overreaching.length > 0) {
      fail(
        file,
        `Trivy skip-dirs covers ${overreaching.join(', ')}, which ${
          overreaching.length === 1 ? 'is not a' : 'are not'
        } KICS query fixture tree. Excluding real files from the scanner is how it ` +
          'stops being a gate',
      )
    }

    // Direction 2: every fixture directory is in fact skipped. Otherwise this check
    // passes while Trivy still fails on fixtures, which is where it started.
    const uncovered = [...fixtureDirs].filter(dir => !skipped.has(dir))
    if (uncovered.length > 0) {
      fail(
        file,
        `${uncovered.length} KICS fixture director(ies) are not in Trivy's skip-dirs, ` +
          `starting with ${uncovered[0]} — Trivy will fail on their deliberate violations`,
      )
    }

    if (fixtureDirs.size === 0) {
      fail(file, 'found no KICS query fixture directories — this check is reading nothing')
    } else if (overreaching.length === 0 && uncovered.length === 0) {
      ok(`Trivy skips ${fixtureDirs.size} KICS fixture trees and nothing else`)
    }
  }
}

// Dependabot auto-merge must be able to DISARM, not only arm.
//
// On 2026-10-03 a TypeScript major merged itself into develop. The workflow had done
// nothing wrong by its own logic: the PR was opened as a patch, auto-merge was armed,
// Dependabot later rewrote that same PR into a major, and the re-run correctly declined
// to arm it again. But auto-merge is GitHub-side state — declining to arm does not
// unarm — so the stale arming fired and `types-ts` broke with 22 errors.
//
// So the negative branch has to act. This asserts that it exists and that it covers
// exactly the cases the arming branch does not: same update types named, `==`/`||` on
// the arm, `!=`/`&&` on the disarm. It is a structural check rather than an expression
// evaluator, which is enough to catch the step being deleted or its condition being
// narrowed to a subset.
{
  const file = 'dependabot-auto-merge.yml'
  const path = join(workflowDir, file)
  const workflow = parse(readFileSync(path, 'utf8'))
  const steps = Object.values(workflow.jobs ?? {}).flatMap(job => job.steps ?? [])

  const runOf = step => (typeof step.run === 'string' ? step.run : '')
  const arm = steps.find(s => /gh pr merge\b[^\n]*--auto\b/.test(runOf(s)))
  // Matches either the API call inline or the extracted script that makes it. The logic
  // moved into scripts/ci/dependabot-disarm.sh so it could be tested against a stubbed
  // `gh` — this check is that the step exists and is the arm's complement;
  // tools/test-dependabot-disarm.sh is that it works.
  const disarm = steps.find(s => /--disable-auto\b|dependabot-disarm\.sh/.test(runOf(s)))

  const typesIn = step => new Set(String(step?.if ?? '').match(/version-update:semver-\w+/g) ?? [])

  if (!arm) {
    fail(file, 'no step arms auto-merge (`gh pr merge --auto`) — is this the right file?')
  } else if (!disarm) {
    fail(
      file,
      'nothing disarms auto-merge. Declining to arm a PR does not unarm one that was ' +
        'armed when it was classified differently, which is how a major merged itself',
    )
  } else {
    const armed = typesIn(arm)
    const disarmed = typesIn(disarm)
    const sameTypes =
      armed.size > 0 && armed.size === disarmed.size && [...armed].every(type => disarmed.has(type))

    if (!sameTypes) {
      fail(
        file,
        `the disarm condition names {${[...disarmed].join(', ')}} but the arm names ` +
          `{${[...armed].join(', ')}} — they must be complements, or some classification ` +
          'is left armed',
      )
    } else if (!/!=/.test(String(disarm.if)) || !/&&/.test(String(disarm.if))) {
      fail(file, 'the disarm condition must be `!=` joined by `&&` to be the complement of the arm')
    } else if (!/==/.test(String(arm.if)) || !/\|\|/.test(String(arm.if))) {
      fail(file, 'the arm condition must be `==` joined by `||`')
    } else {
      ok(`auto-merge arms and disarms over the same ${armed.size} update types`)
    }
  }
}

// The required status checks on develop must name jobs that exist.
//
// ADR-011 gates merges into develop on the CI jobs passing. A required check is matched
// BY NAME, which makes the list in github-setup.sh a second copy of every job name in
// ci.yml — and second copies drift. The two ways it drifts are both silent:
//
//   * a job is RENAMED and the ruleset keeps requiring the old name. The old check never
//     reports, so it is "required but absent", and every push to develop is blocked. Loud
//     but baffling.
//   * a job is ADDED and nobody adds it to the list. It runs, it can fail, and the
//     failure gates nothing. Silent, and the worse of the two.
//
// So: every context must be a real job, and every ci.yml job must be a context.
{
  const file = 'scripts/hitl/github-setup.sh'
  const script = readFileSync(join(repoRoot, 'scripts', 'hitl', 'github-setup.sh'), 'utf8')
  const match = script.match(/add_ruleset protect-develop '([\s\S]*?)'\n/)

  if (!match) {
    fail(file, 'could not find the protect-develop ruleset — has it been renamed or removed?')
  } else {
    let ruleset
    try {
      ruleset = JSON.parse(match[1])
    } catch (error) {
      ruleset = null
      fail(file, `protect-develop is not valid JSON: ${error.message}`)
    }

    const rule = (ruleset?.rules ?? []).find(r => r.type === 'required_status_checks')
    if (ruleset && !rule) {
      fail(
        file,
        'protect-develop has no required_status_checks rule — a red build could be ' +
          'merged into develop by approval alone (ADR-011)',
      )
    } else if (rule) {
      const required = new Set(
        (rule.parameters?.required_status_checks ?? []).map(check => check.context),
      )

      // Every job that can report a check on a commit reaching develop.
      const actual = new Set()
      for (const name of ['ci.yml', 'dependabot-auto-merge.yml']) {
        const doc = parse(readFileSync(join(workflowDir, name), 'utf8'))
        for (const [id, job] of Object.entries(doc.jobs ?? {})) {
          const label = job.name ?? id
          const matrix = job.strategy?.matrix
          if (matrix) {
            // A matrix job reports one check per combination, named "label (value)".
            const key = Object.keys(matrix)[0]
            for (const value of matrix[key]) actual.add(`${label} (${value})`)
          } else {
            actual.add(label)
          }
        }
      }

      const missing = [...actual].filter(name => !required.has(name))
      const stale = [...required].filter(name => !actual.has(name))

      if (missing.length > 0) {
        fail(file, `these jobs exist but are not required: ${missing.join(', ')}`)
      }
      if (stale.length > 0) {
        fail(
          file,
          `these checks are required but no job produces them, which blocks every push ` +
            `to develop: ${stale.join(', ')}`,
        )
      }
      if (missing.length === 0 && stale.length === 0) {
        ok(`protect-develop requires all ${required.size} CI checks, and no others`)
      }
    }
  }
}

// Dependabot's own configuration, which is not a workflow but fails the same way.
//
// ADR-011 settled four properties of this file, and every one of them is the kind that
// stops working silently. The precedent is `cooldown.default-days`, which was set here,
// reported back by the API, and acted on nothing — because the per-semver-type keys
// default to 0 and override it. A supply-chain setting that is configured, believed and
// inert is the exact shape this repository keeps finding.
//
// So: majors ignored in every ecosystem, minor and patch grouped in every ecosystem,
// weekly, and a seven-day cooldown written out per type rather than left to default.
{
  const file = 'dependabot.yml'
  const path = join(repoRoot, '.github', file)
  const config = parse(readFileSync(path, 'utf8'))
  const ecosystems = config?.updates ?? []

  if (ecosystems.length === 0) {
    fail(file, 'no `updates:` entries — dependency updates are configured off entirely')
  }

  for (const entry of ecosystems) {
    const name = entry['package-ecosystem'] ?? '<unnamed>'

    const ignoresMajors = (entry.ignore ?? []).some(
      rule =>
        rule['dependency-name'] === '*' &&
        (rule['update-types'] ?? []).includes('version-update:semver-major'),
    )
    if (!ignoresMajors) {
      fail(
        file,
        `${name} does not ignore semver-major. ADR-011: a major is a planned task, not a ` +
          'bot PR — and a PR that cannot become a major cannot be reclassified into one',
      )
    }

    const grouped = Object.values(entry.groups ?? {}).some(group => {
      const types = group?.['update-types'] ?? []
      return types.includes('minor') && types.includes('patch')
    })
    if (!grouped) {
      fail(file, `${name} does not group minor and patch into one PR`)
    }

    if (entry.schedule?.interval !== 'weekly') {
      fail(file, `${name} is not on a weekly schedule (found ${entry.schedule?.interval})`)
    }

    // Each key checked by name. `default-days` alone is the bug, not the fix.
    const cooldown = entry.cooldown ?? {}
    for (const key of [
      'default-days',
      'semver-major-days',
      'semver-minor-days',
      'semver-patch-days',
    ]) {
      if (cooldown[key] !== 7) {
        fail(
          file,
          `${name} cooldown.${key} is ${cooldown[key] ?? 'unset'}, not 7 — it must match ` +
            'minimumReleaseAge in pnpm-workspace.yaml and exclude-newer in pyproject.toml',
        )
      }
    }
  }

  if (ecosystems.length > 0) {
    ok(
      `dependabot: ${ecosystems.length} ecosystems ignore majors, group minor+patch, weekly, 7-day cooldown`,
    )
  }
}

// --verify-pins: every pinned SHA exists, and is the commit its tag comment claims.
//
// Two distinct lies are possible in `owner/repo@<sha> # v4`, and only the first is loud:
//
//   1. The SHA does not exist. GitHub refuses the workflow, so this is caught at run
//      time — but at run time means after the push, in a red job nobody expected.
//   2. The SHA exists and is NOT v4. Nothing complains, ever. The pin is honest about
//      what it runs and the comment is wrong about what that is, so the next person to
//      "update to v5" diffs against a version that was never there.
//
// Both are checked here. The tag is resolved through the API and compared to the pin.
if (VERIFY_PINS) {
  const cache = (() => {
    try {
      const parsed = JSON.parse(readFileSync(PIN_CACHE, 'utf8'))
      return parsed?.schema === 1 ? (parsed.resolved ?? {}) : {}
    } catch {
      return {}
    }
  })()

  /** Resolve a tag to its commit sha, retrying what is worth retrying. */
  const resolveTag = async (repo, tag) => {
    const key = `${repo}@${tag}`
    if (cache[key]) return { sha: cache[key], cached: true }

    const url = `${GITHUB_API}/repos/${repo}/git/ref/tags/${tag}`
    let lastError = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const headers = { accept: 'application/vnd.github+json' }
        // Uses the token when CI provides one, purely for rate limit headroom.
        const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN']
        if (token) headers.authorization = `Bearer ${token}`

        const response = await fetch(url, { headers })
        if (response.status === 404) return { sha: null, missing: true }
        if (response.ok) {
          const body = await response.json()
          let sha = body?.object?.sha
          // An annotated tag points at a tag object; dereference to the commit.
          if (body?.object?.type === 'tag') {
            const deref = await fetch(`${GITHUB_API}/repos/${repo}/git/tags/${sha}`, { headers })
            if (deref.ok) sha = (await deref.json())?.object?.sha
          }
          if (typeof sha === 'string') {
            cache[key] = sha
            return { sha, cached: false }
          }
          lastError = new Error('no sha in response')
        } else {
          lastError = new Error(`HTTP ${response.status}`)
        }
      } catch (error) {
        lastError = error
      }
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 300 * 2 ** attempt + Math.floor(Math.random() * 100)))
      }
    }
    // Unverifiable is not verified — same rule as the lockfile check.
    throw new Error(`${key}: ${lastError?.message ?? 'unreachable'} (after 4 attempts)`)
  }

  let checked = 0
  // One entry per (file, uses), so an action pinned five times is resolved once and
  // reported once rather than five identical times.
  const seen = new Set()
  for (const pin of pins) {
    const key = `${pin.file} ${pin.uses}`
    if (seen.has(key)) continue
    seen.add(key)

    if (pin.tags.length > 1) {
      fail(
        pin.file,
        `${pin.repo}@${pin.sha.slice(0, 12)} carries more than one version comment ` +
          `(${pin.tags.map(t => t ?? '<none>').join(', ')}). One SHA is one version`,
      )
      continue
    }
    pin.tag = pin.tags[0] ?? null

    if (pin.tag === null) {
      fail(
        pin.file,
        `'${pin.uses}' has no version comment. The pin alone says what runs but not ` +
          'what it is supposed to be, so nothing can tell a correct pin from a stale one',
      )
      continue
    }
    try {
      const { sha } = await resolveTag(pin.repo, pin.tag)
      if (sha === null) {
        fail(pin.file, `${pin.repo} has no tag ${pin.tag} — the version comment names nothing`)
      } else if (sha !== pin.sha) {
        fail(
          pin.file,
          `${pin.repo} is pinned to ${pin.sha.slice(0, 12)} but ${pin.tag} is ` +
            `${sha.slice(0, 12)}. The pin and its comment disagree about what runs`,
        )
      } else {
        checked += 1
      }
    } catch (error) {
      fail(pin.file, `could not resolve ${pin.repo}@${pin.tag}: ${error.message}`)
    }
  }

  try {
    mkdirSync(dirname(PIN_CACHE), { recursive: true })
    const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => (a < b ? -1 : 1)))
    writeFileSync(PIN_CACHE, `${JSON.stringify({ schema: 1, resolved: sorted }, null, 2)}\n`)
  } catch (error) {
    console.warn(`could not write ${PIN_CACHE}: ${error.message}`)
  }

  if (checked > 0) ok(`${checked} pinned SHA(s) resolve to the tag their comment names`)
}

// The control. Every check above reports a problem by its absence, so a bug that made
// the loop read nothing would print a clean run. This asserts the suite actually looked
// at something.
{
  const seen = files.length
  const pinnedCount = files
    .map(f => readFileSync(join(workflowDir, f), 'utf8'))
    .join('\n')
    .match(/uses:\s*\S+@[0-9a-f]{40}/g)?.length
  if (!pinnedCount || pinnedCount < seen) {
    fail(
      '(all)',
      `found only ${pinnedCount ?? 0} pinned actions across ${seen} workflows — ` +
        'the parser is probably not reading what it thinks it is',
    )
  } else {
    ok(`${pinnedCount} pinned action references across ${seen} workflows`)
  }
}

if (failures > 0) {
  console.error(`\nworkflow check: ${failures} problem(s)`)
  process.exit(1)
}
console.log('\nworkflow check: clean')
