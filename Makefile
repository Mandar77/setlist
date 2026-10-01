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

UV := python -m uv
PNPM := pnpm
ENV ?= dev
PROFILE ?= zero
M ?=

.DEFAULT_GOAL := help
.PHONY: help setup verify verify-fast test test-unit test-accuracy lint fmt types cov \
        lint-ts fmt-ts types-ts test-ts toolchain \
        mutate ledger links eol suppressions guard no-secrets secrets-history golden \
        synth synth-matrix nag kics estimate preflight gate unkill clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install the pinned toolchains and all workspace packages
	$(UV) python install 3.13
	$(UV) sync --all-packages
	$(PNPM) install

## ------------------------------------------------------------------ the gate

verify: lint lint-ts types types-ts test-unit test-ts test-accuracy toolchain \
        ledger links eol suppressions guard no-secrets ## Full local gate; no Docker required
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
	$(UV) run mutmut run --paths-to-mutate packages/core/src

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
	$(UV) run --with pyyaml python tools/check_ledger.py

links: ## Every relative markdown link and anchor resolves
	$(UV) run python tools/check_links.py --anchors

eol: ## No CRLF in the working tree (breaks shebangs, shellcheck and span offsets)
	$(UV) run python tools/check_line_endings.py

suppressions: ## Fail on expired or undocumented security suppressions
	$(UV) run --with pyyaml python tools/check_suppressions.py

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

nag: synth ## cdk-nag, including the SetlistZeroCostPack
	cd infra && npx cdk synth --all -c env=$(ENV) -c profile=$(PROFILE) -c nag=true

kics: synth ## KICS scan of the synthesized templates (needs Docker)
	# $(CURDIR), not $(PWD): PWD is exported by a shell, not set by make, so a make
	# invoked from anywhere but bash expands it to "" and docker gets ":/path".
	# MSYS_NO_PATHCONV stops git-bash rewriting the container-side /path arguments
	# into Windows paths before docker ever sees them.
	MSYS_NO_PATHCONV=1 docker run --rm -v "$(CURDIR):/path" checkmarx/kics:latest scan \
		-p /path/infra/cdk.out -q /path/security/kics-queries \
		--fail-on high,critical

estimate: ## Fail if projected usage exceeds the gate in infra/free-tier/budget.yaml
	@# Built by M0A-05. Named here so `preflight` fails loudly rather than appearing to
	@# pass a check that does not exist yet.
	@test -f tools/free_tier_estimate/__main__.py \
		|| { echo "estimate: tools/free_tier_estimate is not built yet (task M0A-05)"; exit 1; }
	$(UV) run python -m tools.free_tier_estimate --env $(ENV)

## preflight: run before PUSHING infrastructure changes. Deploys happen only in CI.
preflight: verify nag kics estimate
	@echo "preflight OK for ENV=$(ENV) PROFILE=$(PROFILE)"

gate: ## Milestone exit evidence -> docs/reports/$(M).md
	@test -n "$(M)" || { echo "usage: make gate M=M0"; exit 2; }
	$(UV) run --with pyyaml python tools/check_ledger.py
	@echo "gate $(M): report generation lands with M0A-05 (estimator) and M0A-08 (CI evidence)"

unkill: ## Recover from the kill switch (owner confirmation required)
	@# Built alongside the kill-switch Lambda in M0A-06.
	@test -f tools/killswitch/__main__.py \
		|| { echo "unkill: tools/killswitch is not built yet (task M0A-06)"; exit 1; }
	$(UV) run python -m tools.killswitch --env $(ENV) --restore --confirm

clean:
	rm -rf .pytest_cache .mypy_cache .ruff_cache .coverage coverage.xml infra/cdk.out
