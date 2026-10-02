// Prove the zero-cost pack actually BLOCKS a synth, not just that its rules work.
//
//   node tools/check_nag_gate.js
//
// `infra/nag/test/pack.test.ts` calls the rules directly and reads the annotations they
// raise. That proves the rules discriminate. It does not prove any of this:
//
//   - that `infra/bin/setlist.ts` attaches the pack at all
//   - that it attaches it to the App rather than to one stack
//   - that it attaches it BEFORE `app.synth()` rather than after
//   - that a violation actually fails the command CI runs
//
// Every one of those mistakes produces a clean build, which is indistinguishable from a
// correct one. So this runs the canary apps under `tests/fixtures/`, each wired the way
// the real entrypoint is, and checks each is rejected by its OWN rule.
//
// ## Why two canaries
//
// They fail differently, and only one of the two failures is easy to catch.
//
//   nat-stack      bans a resource TYPE. The rule fires on AWS::EC2::NatGateway and
//                  nothing subtler has to work.
//   ddb-ondemand   turns on a PROPERTY of a resource the project uses constantly. A
//                  rule reading a typed L1 accessor instead of the rendered template
//                  misses any property set through an escape hatch — which two rules
//                  did, in this repository, until their fixtures caught it.
//
// A type-ban canary passes against both the broken and the working version.
//
// ## Why it goes through the CDK CLI
//
// `app.synth()` does NOT throw on an error annotation. It records the violation as
// `aws:cdk:error` metadata in the manifest and exits 0 — measured, not assumed. It is
// the CDK CLI that reads that metadata and fails with "Validation failed". So the only
// faithful test of the gate is the command `make nag` and CI actually run. A version of
// this script that ran the app directly with tsx passed while a NAT gateway synthesized
// cleanly.
//
// ## The controls
//
//   1. **Each app must synthesize CLEANLY with `-c nag=false`.** Without it a fixture
//      with a bad import or an unresolved dependency exits non-zero and reads as "the
//      gate fired" — which is exactly what happened the first time this ran.
//   2. **The rejection must name the expected rule**, so a crash, or the wrong rule
//      firing, cannot pass as enforcement.
//   3. **It must still be blocked with no `-c nag` flag at all**, because every synth
//      that forgets the flag is otherwise unguarded.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** Each canary, and the rule that must reject it. */
const CANARIES = [
  {
    dir: 'nat-stack',
    rule: 'SZC-NAT',
    what: 'a NAT gateway — a banned resource type',
  },
  {
    dir: 'ddb-ondemand',
    rule: 'SZC-DDB-ONDEMAND',
    what: 'PAY_PER_REQUEST billing — a banned property on a permitted resource',
  },
]

// Resolve the CLI's JS entrypoint rather than invoking `cdk` from PATH. On Windows the
// binstub is `cdk.CMD`, which execFileSync cannot launch without a shell — and a tool
// that fails to launch looks exactly like a tool reporting an error.
const requireFromInfra = createRequire(join(repoRoot, 'infra', 'package.json'))

// The entrypoint moved. Up to 2.173 the package shipped `bin/cdk.js`; the 2.1xxx CLI
// (decoupled from the library's version line) ships `bin/cdk` with a shebang and no
// extension. Resolve the package and look for either, rather than pinning a filename
// that changed once and may again.
let CDK
{
  const packageJson = requireFromInfra.resolve('aws-cdk/package.json')
  const binDir = join(dirname(packageJson), 'bin')
  CDK = ['cdk.js', 'cdk'].map(name => join(binDir, name)).find(candidate => existsSync(candidate))

  if (CDK === undefined) {
    console.error(
      `nag gate: no CDK entrypoint in ${binDir} — run \`pnpm install\`, or the package ` +
        'layout has changed again',
    )
    process.exit(1)
  }
}

class LaunchError extends Error {}

/**
 * Synthesize one canary, returning whether the CLI rejected it.
 *
 * Each fixture's `cdk.json` names `tsx app.ts`, so its own node_modules/.bin goes on
 * PATH — the CLI runs the app through a shell, which does not inherit a package's bin
 * directory on its own.
 */
function synth(fixtureDir, contextFlags) {
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
        `cdk synth exited ${error.status} with no output — that is a tooling failure, not a finding`,
      )
    }
    return { rejected: true, output }
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

const excerpt = text => text.trim().split('\n').slice(0, 8).join('\n')

let failures = 0
const fail = message => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

console.log(`nag gate: ${CANARIES.length} canaries, each must be rejected by its own rule\n`)

// Every fixture declares aws-cdk-lib itself, since each is its own workspace package.
// Those versions must match infra's exactly: pnpm links identical versions to one place
// in the store, keeping it a single module instance, but a drift would give a fixture a
// second copy of CDK and the jsii `instanceof` checks inside Aspects would start failing
// for reasons that have nothing to do with the gate.
{
  const deps = p => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')).dependencies ?? {}
  const infraDeps = deps('infra/package.json')
  for (const { dir } of CANARIES) {
    const fixtureDeps = deps(`tests/fixtures/${dir}/package.json`)
    for (const name of ['aws-cdk-lib', 'constructs']) {
      if (fixtureDeps[name] !== infraDeps[name]) {
        fail(
          `${dir} pins ${name}@${fixtureDeps[name]} but infra pins ${infraDeps[name]} — ` +
            'two copies of CDK would break the pack for reasons unrelated to any rule',
        )
      }
    }
  }
}

try {
  for (const { dir, rule, what } of CANARIES) {
    const fixtureDir = join(repoRoot, 'tests', 'fixtures', dir)
    if (!existsSync(join(fixtureDir, 'app.ts'))) {
      fail(`${dir} is missing — the gate has nothing to prove`)
      continue
    }

    console.log(`${dir} — ${what}`)

    // 1. The control: the same app, pack disabled, must synthesize cleanly. Otherwise
    //    the rejection below says nothing about the pack.
    const control = synth(fixtureDir, ['env=dev', 'profile=zero', 'nag=false'])
    if (control.rejected) {
      fail(
        `${dir} does NOT synthesize with the pack disabled, so a rejection with it ` +
          `enabled would mean nothing:\n${excerpt(control.output)}`,
      )
    } else {
      console.log('  ok    control    synthesizes cleanly with -c nag=false')
    }

    // 2. The gate itself, and the right rule.
    const gated = synth(fixtureDir, ['env=dev', 'profile=zero', 'nag=true'])
    if (!gated.rejected) {
      fail(
        `${dir} ACCEPTED — the pack is not attached, is attached after synth, or its ` +
          'errors do not fail the CLI',
      )
    } else if (!gated.output.includes(rule)) {
      fail(
        `${dir} was rejected but never mentioned ${rule}, so something other than that ` +
          `rule stopped it:\n${excerpt(gated.output)}`,
      )
    } else {
      console.log(`  ok    rejected   blocked by ${rule}`)
    }

    // 3. The default. profile=zero with no `nag` flag must still enforce, because that
    //    is what `make synth` and every CI synth run with.
    const byDefault = synth(fixtureDir, ['env=dev', 'profile=zero'])
    if (!byDefault.rejected || !byDefault.output.includes(rule)) {
      fail(
        `${dir} ACCEPTED without an explicit -c nag=true, so any synth that forgets ` +
          'the flag is unguarded',
      )
    } else {
      console.log('  ok    rejected   still blocked with no -c nag flag (zero is default-on)')
    }
    console.log('')
  }
} catch (error) {
  if (error instanceof LaunchError) {
    console.error(`\nnag gate: ${error.message}`)
    process.exit(1)
  }
  throw error
}

if (failures > 0) {
  console.error(`nag gate: ${failures} check(s) failed — the $0 guarantee is not enforced`)
  process.exit(1)
}

console.log('nag gate: the pack blocks a banned type AND a banned property, at synth time')
