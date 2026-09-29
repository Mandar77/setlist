# Setlist developer entrypoints.
#
# `verify` is the gate the autopilot loop runs on every task. It must finish in under
# ~5 minutes and must NOT require Docker (AUTOPILOT S2.6) — Docker-backed scans run in
# CI, and locally only when Docker happens to be up.
#
# `preflight` additionally synthesizes and scans infrastructure. Deploys themselves
# run only in CI (ADR-005); preflight is what you run before *pushing* infra changes.

SHELL := /bin/bash
UV := python -m uv
ENV ?= dev
PROFILE ?= zero
M ?=

.DEFAULT_GOAL := help
.PHONY: help setup verify verify-fast test test-unit test-accuracy lint fmt types cov \
        mutate ledger suppressions no-secrets secrets-history golden \
        synth nag kics estimate preflight gate unkill clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install the pinned toolchains and all workspace packages
	$(UV) python install 3.13
	$(UV) sync --all-packages

## ------------------------------------------------------------------ the gate

verify: lint types test-unit test-accuracy ledger suppressions no-secrets ## Full local gate; no Docker required
	@echo "verify OK"

verify-fast: lint types test-unit ## Lint, types and unit tests only
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

ledger: ## Validate docs/plan/TASKS.yaml (ids, deps, cycles, evidence)
	$(UV) run --with pyyaml python tools/check_ledger.py

suppressions: ## Fail on expired or undocumented security suppressions
	$(UV) run --with pyyaml python tools/check_suppressions.py

no-secrets: ## Scan the working tree for credentials and personal data
	$(UV) run python tools/check_no_secrets.py --staged

secrets-history: ## Scan every commit ever made (slower; nightly in CI)
	$(UV) run python tools/check_no_secrets.py --history

## ------------------------------------------------------------- infrastructure

synth: ## Synthesize CDK templates for ENV under PROFILE (default: zero)
	cd infra && npx cdk synth --all -c env=$(ENV) -c profile=$(PROFILE)

nag: synth ## cdk-nag, including the SetlistZeroCostPack
	cd infra && npx cdk synth --all -c env=$(ENV) -c profile=$(PROFILE) -c nag=true

kics: synth ## KICS scan of the synthesized templates (needs Docker)
	docker run --rm -v "$(PWD):/path" checkmarx/kics:latest scan \
		-p /path/infra/cdk.out -q /path/security/kics-queries \
		--fail-on high,critical

estimate: ## Fail if projected usage exceeds the gate in infra/free-tier/budget.yaml
	$(UV) run python -m tools.free_tier_estimate --env $(ENV)

## preflight: run before PUSHING infrastructure changes. Deploys happen only in CI.
preflight: verify nag kics estimate
	@echo "preflight OK for ENV=$(ENV) PROFILE=$(PROFILE)"

gate: ## Milestone exit evidence -> docs/reports/$(M).md
	@test -n "$(M)" || { echo "usage: make gate M=M0"; exit 2; }
	$(UV) run --with pyyaml python tools/check_ledger.py
	@echo "gate $(M): report generation lands with M0A-05 (estimator) and M0A-08 (CI evidence)"

unkill: ## Recover from the kill switch (owner confirmation required)
	$(UV) run python -m tools.killswitch --env $(ENV) --restore --confirm

clean:
	rm -rf .pytest_cache .mypy_cache .ruff_cache .coverage coverage.xml infra/cdk.out
