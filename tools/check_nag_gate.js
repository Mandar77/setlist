// Prove the zero-cost pack actually BLOCKS a synth, not just that its rules work.
//
// `infra/nag/test/pack.test.ts` calls the rules directly and reads the annotations they
// raise. That proves the rules discriminate. It does not prove any of this:
//
//   - that `infra/bin/setlist.ts` attaches the pack at all
//   - that it attaches it to the App rather than to one stack
//   - that it attaches it BEFORE `app.synth()` rather than after
//   - that a violation actually fails the command CI runs
//
// Every one of those mistakes produces a clean build, which is indistinguishable from
// a correct one. So this runs the fixture app in `tests/fixtures/nat-stack`, wired the
// same way the real entrypoint is, and checks it is rejected.
//
// ## Why it goes through the CDK CLI
//
// `app.synth()` does NOT throw on an error annotation. It records the violation as
// `aws:cdk:error` metadata in the manifest and exits 0 — measured, not assumed. It is
// the CDK CLI that reads that metadata and fails with "Validation failed". So the only
// faithful test of the gate is the command `make nag` and CI actually run. A version
// of this script that ran the app directly with tsx passed while a NAT gateway
// synthesized cleanly.
//
// ## The controls
//
//   1. **The same app must synthesize CLEANLY with `-c nag=false`.** Without it a
//      fixture with a bad import or an unresolved dependency exits non-zero and reads
//      as "the gate fired" — which is exactly what happened the first time this ran.
//   2. **The rejection must name SZC-NAT**, so a crash cannot pass as enforcement.
//   3. **It must still be blocked with no `-c nag` flag at all**, because every synth
//      that forgets the flag is otherwise unguarded.
//
//   node tools/check_nag_gate.js

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'nat-stack')

// Resolve the CLI's JS entrypoint rather than invoking `cdk` from PATH. On Windows the
// binstub is `cdk.CMD`, which execFileSync cannot launch without a shell — and a tool
// that fails to launch looks exactly like a tool reporting an error.
const requireFromInfra = createRequire(join(repoRoot, 'infra', 'package.json'))

let CDK
try {
  CDK = requireFromInfra.resolve('aws-cdk/bin/cdk.js')
} catch {
  console.error('nag gate: aws-cdk is not installed — run `pnpm install`')
  process.exit(1)
}

class LaunchError extends Error {}

/**
 * Synthesize the fixture app, returning whether the CLI rejected it.
 *
 * `cdk.json` in the fixture names `tsx app.ts`, so the fixture's own node_modules/.bin
 * goes on PATH — the CLI runs the app through a shell, which does not inherit a
 * package's bin directory on its own.
 */
function synth(contextFlags) {
  const outdir = mkdtempSync(join(tmpdir(), 'setlist-naggate-'))
  const binDir = join(fixtureDir, 'node_modules', '.bin')
  try {
    execFileSync(
      process.execPath,
      [CDK, 'synth', '--all', '--output', outdir, ...contextFlags.flatMap(f => ['-c', f])],
      {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: '1',
        },
      },
    )
    return { rejected: false, output: '' }
  } catch (error) {
    if (error.code === 'ENOENT' || error.errno === -4058) {
      throw new LaunchError(`could not launch the CDK CLI at ${CDK}: ${error.message}`)
    }
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (output.trim() === '') {
      throw new LaunchError(
        `cdk synth exited ${error.status} with no output — that is a tooling failure, ` +
          'not a finding',
      )
    }
    return { rejected: true, output }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

const excerpt = text => text.trim().split('\n').slice(0, 8).join('\n')

if (!existsSync(join(fixtureDir, 'app.ts'))) {
  console.error(`nag gate: ${fixtureDir} is missing — the gate has nothing to prove`)
  process.exit(1)
}

console.log('nag gate: tests/fixtures/nat-stack must be rejected by SZC-NAT\n')

let failures = 0
const fail = message => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

// 0. The fixture is its own workspace package, so it declares aws-cdk-lib itself. Those
//    versions must match infra's exactly: pnpm links identical versions to one place in
//    the store, keeping it a single module instance, but a drift would give the fixture
//    a second copy of CDK and the jsii `instanceof` checks inside Aspects would start
//    failing for reasons that have nothing to do with the gate.
{
  const deps = p => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')).dependencies ?? {}
  const infraDeps = deps('infra/package.json')
  const fixtureDeps = deps('tests/fixtures/nat-stack/package.json')

  for (const name of ['aws-cdk-lib', 'constructs']) {
    if (fixtureDeps[name] !== infraDeps[name]) {
      fail(
        `the nat-stack fixture pins ${name}@${fixtureDeps[name]} but infra pins ` +
          `${infraDeps[name]} — two copies of CDK would break the pack for reasons ` +
          'unrelated to any rule',
      )
    }
  }
}

try {
  // 1. The control: the same app, pack disabled, must synthesize cleanly. Otherwise
  //    the rejection below says nothing about the pack.
  const control = synth(['env=dev', 'profile=zero', 'nag=false'])
  if (control.rejected) {
    fail(
      'the fixture app does NOT synthesize with the pack disabled, so a rejection ' +
        `with it enabled would mean nothing:\n${excerpt(control.output)}`,
    )
  } else {
    console.log('  ok    control    synthesizes cleanly with -c nag=false')
  }

  // 2. The gate itself.
  const gated = synth(['env=dev', 'profile=zero', 'nag=true'])
  if (!gated.rejected) {
    fail(
      'ACCEPTED  a NAT gateway synthesized with the pack enabled — the pack is not ' +
        'attached, is attached after synth, or its errors do not fail the CLI',
    )
  } else if (!gated.output.includes('SZC-NAT')) {
    fail(
      'the synth failed but never mentioned SZC-NAT, so something other than the ' +
        `rule stopped it:\n${excerpt(gated.output)}`,
    )
  } else {
    console.log('  ok    rejected   NAT gateway blocked by SZC-NAT')
  }

  // 3. The default. profile=zero with no `nag` flag must still enforce, because that
  //    is what `make synth` and every CI synth run with.
  const byDefault = synth(['env=dev', 'profile=zero'])
  if (!byDefault.rejected || !byDefault.output.includes('SZC-NAT')) {
    fail(
      'ACCEPTED  the pack did not run without an explicit -c nag=true, so any synth ' +
        'that forgets the flag is unguarded',
    )
  } else {
    console.log('  ok    rejected   still blocked with no -c nag flag (zero is default-on)')
  }
} catch (error) {
  if (error instanceof LaunchError) {
    console.error(`\nnag gate: ${error.message}`)
    process.exit(1)
  }
  throw error
}

if (failures > 0) {
  console.error(`\nnag gate: ${failures} check(s) failed — the $0 guarantee is not enforced`)
  process.exit(1)
}

console.log('\nnag gate: the pack blocks a costly resource at synth time')
