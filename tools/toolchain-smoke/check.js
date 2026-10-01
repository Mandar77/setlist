// Prove the TypeScript and ESLint gates actually reject bad code.
//
// A strict-mode setting that is configured but not enforced looks exactly like one
// that is working: both produce a green build. The only way to tell them apart is to
// feed in code that must be rejected and check that it was.
//
// Each fixture in ./fixtures violates one setting. This script checks each in
// isolation and fails if any of them is ACCEPTED.
//
// Two things this script learned the hard way, both of which would make it pass
// vacuously:
//
//   1. **A tool that cannot launch looks exactly like a tool reporting errors.**
//      The first version shelled out to `pnpm`, which on Windows is `pnpm.cmd` and
//      throws ENOENT under execFileSync without a shell. Every check "failed", every
//      fixture looked "rejected", and the suite would have declared all gates
//      enforcing while running nothing at all. It now invokes the tools' JS
//      entrypoints through `process.execPath` — no shell, no PATHEXT — and treats a
//      launch failure as a hard error rather than a rejection.
//
//   2. **Rejecting everything is not success.** A control case asserts that valid
//      code still COMPILES. Without it, a broken runner is indistinguishable from a
//      strict compiler. That control is what caught problem 1.
//
//   node tools/toolchain-smoke/check.js

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const TSC = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const ESLINT = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js')

// Repo-relative, POSIX-separated. This checkout's absolute path contains spaces.
const rel = (...parts) => ['tools', 'toolchain-smoke', ...parts].join('/')

/** Strict flags under test, applied per-file so each fixture is isolated. */
const STRICT_FLAGS = [
  '--noEmit',
  '--strict',
  '--noUncheckedIndexedAccess',
  '--exactOptionalPropertyTypes',
  '--noImplicitReturns',
  '--target',
  'ES2023',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
]

const TYPECHECK_FIXTURES = {
  'unchecked-index.ts': 'noUncheckedIndexedAccess',
  'exact-optional.ts': 'exactOptionalPropertyTypes',
  'implicit-return.ts': 'noImplicitReturns',
}

const LINT_FIXTURES = {
  'any-escape.ts': '@typescript-eslint/no-explicit-any',
}

class LaunchError extends Error {}

/**
 * Run a tool and report whether it EXITED CLEANLY.
 *
 * Throws LaunchError if the tool could not be started at all — that is never a
 * verdict about the code, and must not be read as one.
 */
function run(scriptPath, args) {
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exitedCleanly: true, output: '' }
  } catch (error) {
    if (error.code === 'ENOENT' || error.errno === -4058) {
      throw new LaunchError(`could not launch ${scriptPath}: ${error.message}`)
    }
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    // A tool that produced no diagnostics yet exited non-zero did not "find a
    // problem" — it broke. Treating that as a rejection is how this suite passed
    // while running nothing.
    if (output.trim() === '') {
      throw new LaunchError(
        `${scriptPath} exited ${error.status} with no output — treating as a tooling ` +
          'failure, not a finding',
      )
    }
    return { exitedCleanly: false, output }
  }
}

/**
 * Workspace directories holding a tsconfig.json that the root does not reference.
 *
 * Deliberately filesystem-driven rather than reading pnpm-workspace.yaml: the question
 * is "is there a TypeScript project here that nothing type-checks", and that is a fact
 * about the directory tree.
 */
function findUnreferencedProjects() {
  const rootConfig = JSON.parse(
    stripJsonComments(readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8')),
  )
  const referenced = new Set((rootConfig.references ?? []).map(r => r.path.replace(/\\/g, '/')))

  const roots = ['packages', 'services', 'tools']
  const singletons = ['mobile', 'web', 'infra']
  const candidates = []

  for (const group of roots) {
    const groupDir = join(repoRoot, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(groupDir, entry.name, 'tsconfig.json'))) {
        candidates.push(`${group}/${entry.name}`)
      }
    }
  }
  for (const name of singletons) {
    if (existsSync(join(repoRoot, name, 'tsconfig.json'))) candidates.push(name)
  }

  return candidates.filter(path => !referenced.has(path))
}

/** tsconfig allows comments and trailing commas; JSON.parse does not. */
function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
}

let failures = 0
const pass = what => console.log(`  ok    rejected  ${what}`)
const fail = (what, detail) => {
  failures += 1
  console.error(`  FAIL  ACCEPTED  ${what} — ${detail}`)
}

console.log('toolchain smoke: every fixture below MUST be rejected\n')

// 0. Preconditions. If the tools are missing or cannot run, say so instead of
//    producing a green result from an empty run.
for (const [label, path] of [
  ['typescript', TSC],
  ['eslint', ESLINT],
]) {
  if (!existsSync(path)) {
    console.error(`toolchain smoke: ${label} is not installed — run \`pnpm install\``)
    process.exit(1)
  }
}

try {
  const probe = run(TSC, ['--version'])
  if (!probe.exitedCleanly) {
    throw new LaunchError('tsc --version did not exit cleanly')
  }
} catch (error) {
  console.error(`toolchain smoke: the compiler cannot run — ${error.message}`)
  process.exit(1)
}

try {
  const present = new Set(readdirSync(join(here, 'fixtures')))

  // 1. The compiler must reject each type-level fixture.
  for (const [file, setting] of Object.entries(TYPECHECK_FIXTURES)) {
    if (!present.has(file)) {
      fail(file, 'fixture is missing, so this setting is no longer proven')
      continue
    }
    const result = run(TSC, [...STRICT_FLAGS, rel('fixtures', file)])
    if (result.exitedCleanly) {
      fail(file, `compiled cleanly, so ${setting} is not being enforced`)
    } else {
      pass(`${file}  (${setting})`)
    }
  }

  // 2. ESLint must reject each lint-level fixture. The fixtures directory is ignored
  //    by the normal lint run, so it is passed explicitly with --no-ignore.
  for (const [file, rule] of Object.entries(LINT_FIXTURES)) {
    if (!present.has(file)) {
      fail(file, 'fixture is missing, so this rule is no longer proven')
      continue
    }
    const result = run(ESLINT, ['--no-ignore', rel('fixtures', file)])
    if (result.exitedCleanly) {
      fail(file, `linted cleanly, so ${rule} is not being enforced`)
    } else {
      pass(`${file}  (${rule})`)
    }
  }

  // 3. The control. Valid code must still compile — otherwise "everything is
  //    rejected" would also read as success.
  const good = run(TSC, ['--build', rel('tsconfig.json')])
  if (good.exitedCleanly) {
    console.log('  ok    accepted  src/index.ts  (valid code still compiles)')
  } else {
    failures += 1
    console.error(`  FAIL  REJECTED  src/index.ts — valid code no longer compiles:\n${good.output}`)
  }

  // 4. Every TypeScript package must be referenced from the root tsconfig. A package
  //    missing from `references` still lints but is never type-checked by
  //    `make verify` — an unchecked package that looks checked.
  const unreferenced = findUnreferencedProjects()
  if (unreferenced.length === 0) {
    console.log('  ok    referenced  every tsconfig.json is in the root references list')
  } else {
    failures += 1
    console.error(
      '  FAIL  UNCHECKED  these packages have a tsconfig.json but are not referenced\n' +
        '                   from the root tsconfig.json, so nothing type-checks them:\n' +
        unreferenced.map(p => `                     - ${p}`).join('\n'),
    )
  }
} catch (error) {
  if (error instanceof LaunchError) {
    console.error(`\ntoolchain smoke: ABORTED — ${error.message}`)
    console.error('No verdict was reached. This is not a pass.')
    process.exit(1)
  }
  throw error
}

console.log()
if (failures > 0) {
  console.error(`toolchain smoke: ${failures} problem(s) — a configured gate is not enforcing`)
  process.exit(1)
}
console.log('toolchain smoke: all gates enforcing')
