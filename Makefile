# Setlist developer entrypoints.
#
# `verify` is the gate the autopilot loop runs on every task. It must finish in under
# ~5 minutes and must NOT require Docker (AUTOPILOT S2.6) — Docker-backed scans run in
# CI, and locally only when Docker happens to be up.
#
# `preflight` additionally synthesizes and scans infrastructure. Deploys themselves
# run only in CI (ADR-005); preflight is what you run before *pushing* infra changes.

SHELL := /bin/bash

# Python UTF-8 mode, exported to every recipe. Without it, Python on Windows uses the
# locale codec (cp1252) for stdio and for open() with no explicit encoding, and dies on
# the first non-Latin-1 byte. This project parses Unicode song titles for a living, so
# that is a guaranteed failure rather than a theoretical one — and it fails differently
# on Windows than in Linux CI, which is the worst kind of bug to chase.
export PYTHONUTF8 := 1

# Prefer the real binary, fall back to the Python module.
#
# Not cosmetic: `astral-sh/setup-uv` installs uv as a standalone binary with no Python
# module to import, while a local `pip install uv` gives the module and often no binary
# on PATH. Hard-coding either one makes `make verify` work in exactly one of the two
# places — and the first CI run failed on `/usr/bin/python: No module named uv`, which
# is the whole "CI runs the same commands as make verify" claim coming apart the first
# time anyone checked.
UV := $(shell command -v uv >/dev/null 2>&1 && echo uv || echo python -m uv)
PNPM := pnpm
ENV ?= dev
PROFILE ?= zero
M ?=

.DEFAULT_GOAL := help
.PHONY: help setup verify verify-fast test test-unit test-accuracy lint fmt types cov \
        lint-ts fmt-ts types-ts test-ts toolchain \
        mutate ledger links eol oracle suppressions suppressions-write guard workflows \
        no-secrets secrets-history golden \
        synth synth-matrix nag kics lint-cfn cdk-out-zero estimate preflight gate \
        unkill clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install the pinned toolchains and all workspace packages
	$(UV) python install 3.13
	$(UV) sync --all-packages
	$(PNPM) install

## ------------------------------------------------------------------ the gate

verify: lint lint-ts lint-cfn types types-ts test-unit test-ts test-accuracy toolchain \
        oracle ledger links eol suppressions guard workflows no-secrets ## Full local gate; no Docker required
	@echo "verify OK"

verify-fast: lint lint-ts types types-ts test-unit test-ts ## Lint, types and unit tests only
	@echo "verify-fast OK"

## ------------------------------------------------------------------ tests

test: test-unit ## Run the default test suite

test-unit: ## Unit tests: no AWS, no provider calls, no network
	$(UV) run pytest -m "not integration and not e2e" -q

test-accuracy: ## Golden-set extraction gate (release-blocking)
	$(UV) run pytest -m accuracy -q

cov: ## Unit tests with the coverage gate (>=85% overall, >=90% core)
	$(UV) run pytest --cov --cov-report=term-missing --cov-report=xml

mutate: ## Mutation testing on the core (target >=70%)
	$(UV) run mutmut run --paths-to-mutate tools/oracle-py/src

golden: ## Regenerate the generated golden sets from the seed catalog
	@echo "golden: seed-derived generation lands with CORE-02/CORE-03"

## ------------------------------------------------------------------ quality

lint: ## ruff check + format check
	$(UV) run ruff check .
	$(UV) run ruff format --check .

fmt: ## Apply formatting and safe autofixes
	$(UV) run ruff check . --fix
	$(UV) run ruff format .

types: ## mypy --strict
	$(UV) run mypy

## --------------------------------------------------------------- TypeScript
## Per ADR-004 this is the default language; the Python above is the exception.

lint-ts: node_modules ## ESLint + Prettier across the workspace
	$(PNPM) exec eslint .
	$(PNPM) exec prettier --check .

fmt-ts: node_modules ## Apply ESLint fixes and Prettier formatting
	$(PNPM) exec eslint . --fix
	$(PNPM) exec prettier --write .

types-ts: node_modules ## tsc --build across every referenced project
	$(PNPM) exec tsc --build

test-ts: node_modules ## Vitest across the workspace
	$(PNPM) exec vitest run --passWithNoTests

toolchain: node_modules ## Prove the TS/ESLint gates actually reject bad code
	node tools/toolchain-smoke/check.js

## Install on demand, and only when the manifests are newer than the tree. Without
## this, every TS target above fails confusingly on a fresh clone.
node_modules: package.json pnpm-lock.yaml
	$(PNPM) install --frozen-lockfile
	@touch node_modules

ledger: ## Validate docs/plan/TASKS.yaml (ids, deps, cycles, evidence)
	$(UV) run python tools/check_ledger.py

links: ## Every relative markdown link and anchor resolves
	$(UV) run python tools/check_links.py --anchors

eol: ## No CRLF in the working tree (breaks shebangs, shellcheck and span offsets)
	$(UV) run python tools/check_line_endings.py

## The frozen reference implementation (CORE-01). Only the golden check runs here —
## oracle-py's own lint, types and tests are already covered by the repo-wide targets
## above, and running them twice would double the slowest part of the gate for nothing.
oracle: ## The oracle still reproduces every golden output byte for byte
	$(MAKE) -C tools/oracle-py golden

suppressions: ## Fail on expired suppressions, or a .trivyignore.yaml that drifted from them
	$(UV) run python tools/check_suppressions.py

suppressions-write: ## Regenerate .trivyignore.yaml from security/suppressions.yaml
	$(UV) run python tools/check_suppressions.py --write

guard: ## Prove the PreToolUse guard still blocks what ADR-005 says it must
	bash tools/test-guard-hook.sh

no-secrets: ## Scan the working tree for credentials and personal data
	$(UV) run python tools/check_no_secrets.py --staged

secrets-history: ## Scan every commit ever made (slower; nightly in CI)
	$(UV) run python tools/check_no_secrets.py --history

## ------------------------------------------------------------- infrastructure

## jsii supports ^22 and this machine runs 24; CI pins 22. The warning is noise here,
## and silencing it keeps a real failure visible among the output.
CDK_ENV := JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1

synth: node_modules ## Synthesize CDK templates for ENV under PROFILE (default: zero)
	cd infra && $(CDK_ENV) pnpm exec cdk synth --all -c env=$(ENV) -c profile=$(PROFILE)

synth-matrix: node_modules ## Synthesize all 6 profile x env combinations, offline
	@# Both profiles, every environment. The enterprise path has no other exercise, so
	@# without this it rots unnoticed until someone needs it. Runs with no credentials:
	@# a context lookup would break this and is exactly what must not creep in.
	@set -e; for profile in zero enterprise; do \
	  for env in dev stage prod; do \
	    printf '  %-11s %-6s ' "$$profile" "$$env"; \
	    ( cd infra && $(CDK_ENV) pnpm exec cdk synth --all -c env=$$env -c profile=$$profile \
	        >/dev/null 2>/tmp/setlist-synth-err.txt ) \
	      && echo OK \
	      || { echo FAILED; grep -vE '^!!|^$$' /tmp/setlist-synth-err.txt | head -5; exit 1; }; \
	  done; \
	done
	@echo "synth-matrix OK (6/6 offline)"

nag: synth ## cdk-nag: the real stacks must pass, and a costly stack must be rejected
	@# Direction one: the stacks we ship synthesize clean under the pack.
	cd infra && $(CDK_ENV) pnpm exec cdk synth --all \
		-c env=$(ENV) -c profile=$(PROFILE) -c nag=true >/dev/null
	@echo "  ok    $(ENV)/$(PROFILE) stacks pass SetlistZeroCost"
	@# Direction two, and the one that is easy to skip: a stack that MUST be rejected
	@# is actually rejected. A pack that is never attached also produces a clean synth,
	@# so direction one on its own proves nothing about whether the gate runs.
	node tools/check_nag_gate.js

## Templates for every environment under profile=zero, in a directory of their own.
##
## KICS scans a PATH, so it scans whatever happens to be sitting in cdk.out. After a
## `make synth-matrix` that includes enterprise templates — which legitimately use a
## custom event bus and an API Gateway — and the zero-cost pack dutifully reports them
## against a profile that never ships. Worse in the other direction: a stale clean
## template from a previous run masks a bad current one.
##
## So this writes a known set into a fresh directory, and the scan reads only that.
## All three environments, because the guardrails apply to every one of them.
cdk-out-zero: node_modules
	rm -rf infra/cdk.out
	@set -e; for env in dev stage prod; do \
	  printf '  synth zero/%-6s' "$$env"; \
	  ( cd infra && $(CDK_ENV) pnpm exec cdk synth --all \
	      -c env=$$env -c profile=zero -c nag=true \
	      --output cdk.out/zero-$$env >/dev/null ) && echo OK; \
	done

kics: cdk-out-zero ## KICS: the zero-cost query pack plus the default catalog (needs Docker)
	# $(CURDIR), not $(PWD): PWD is exported by a shell, not set by make, so a make
	# invoked from anywhere but bash expands it to "" and docker gets ":/path".
	# MSYS_NO_PATHCONV stops git-bash rewriting the container-side /path arguments
	# into Windows paths before docker ever sees them.
	@# The pack is generated from a spec; if the tree is stale, the queries reviewed in
	@# the diff are not the queries that run.
	node tools/gen_kics_queries.js --check
	@# Direction one: the queries discriminate. A query with a typo'd resource type or a
	@# Rego error is SILENT, which is indistinguishable from compliance in the scans
	@# below — so each is first run against a sample that must be flagged and one that
	@# must not.
	node tools/check_kics_queries.js
	@# Direction two: the templates we actually ship are clean under the pack.
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR):/path" checkmarx/kics:latest scan \
		-p /path/infra/cdk.out -q /path/security/kics-queries \
		--fail-on high,critical --no-progress --no-color
	@# ...and clean under the DEFAULT catalog too, which covers security issues the
	@# zero-cost pack says nothing about, and the workflow files along with them.
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR):/path" checkmarx/kics:latest scan \
		-p /path/infra/cdk.out,/path/.github/workflows \
		--fail-on high,critical --no-progress --no-color

estimate: node_modules ## Fail if projected usage exceeds the gate in infra/free-tier/budget.yaml
	@# TypeScript, not Python. ADR-004 makes Node the default and names the only three
	@# Python exceptions; this is not one of them. The placeholder that stood here
	@# pointed at a Python module, which would have set the wrong precedent on the day
	@# it was filled in.
	@#
	@# Deliberately NOT scoped to $(ENV): the free-tier allowances are account-wide and
	@# shared across all three environments, so passing dev while prod is over its share
	@# is precisely the wrong answer. Use `--env` directly for a focused report.
	cd tools/free-tier-estimate && node --import tsx src/cli.ts

workflows: node_modules ## Workflow properties actionlint does not check
	@# Pinning, the pull_request_target trap, the fork/AWS gate, and that the kill-switch
	@# drill cannot target prod. actionlint validates syntax; none of these are syntax.
	@# actionlint itself runs in CI (it needs a download) and is not in `verify`, which
	@# must work offline.
	node tools/check_workflows.js

lint-cfn: node_modules ## cfn-lint the hand-uploaded bootstrap template, and check it is current
	@# Generated from infra/bootstrap/template.ts, so the file reviewed in a diff must be
	@# the one built from the deny list the tests assert against.
	cd infra && pnpm exec tsx bootstrap/generate.ts --check
	$(UV) run cfn-lint infra/bootstrap/account-bootstrap.yaml

## preflight: run before PUSHING infrastructure changes. Deploys happen only in CI.
preflight: verify nag kics estimate
	@echo "preflight OK for ENV=$(ENV) PROFILE=$(PROFILE)"

gate: ## Milestone exit evidence -> docs/reports/$(M).md
	@test -n "$(M)" || { echo "usage: make gate M=M0"; exit 2; }
	$(UV) run python tools/check_ledger.py
	@echo "gate $(M): report generation lands with M0A-05 (estimator) and M0A-08 (CI evidence)"

unkill: ## Recover from the kill switch (owner confirmation required)
	@# Built alongside the kill-switch Lambda in M0A-06.
	@test -f tools/killswitch/__main__.py \
		|| { echo "unkill: tools/killswitch is not built yet (task M0A-06)"; exit 1; }
	$(UV) run python -m tools.killswitch --env $(ENV) --restore --confirm

clean:
	rm -rf .pytest_cache .mypy_cache .ruff_cache .coverage coverage.xml infra/cdk.out
