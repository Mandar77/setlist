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

import { readFileSync, readdirSync } from 'node:fs'
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

let failures = 0
const fail = (file, message) => {
  failures += 1
  console.error(`  FAIL  ${file}: ${message}`)
}
const ok = message => console.log(`  ok    ${message}`)

const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
if (files.length === 0) {
  console.error('workflow check: no workflows found — did the path move?')
  process.exit(1)
}

console.log(`workflow check: ${files.length} workflows\n`)

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
    }
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
