# The frozen oracle's own gate.
#
# Every recipe runs from the repository root rather than from here. That is deliberate:
# there is one ruff config, one mypy config and one uv environment, all in the root
# pyproject.toml, and `tools/oracle-py/pyproject.toml` deliberately holds none of them.
# A ruff invoked from this directory would find the local pyproject, see no [tool.ruff]
# in it, and silently fall back to defaults — checking this package against rules the
# rest of the repository does not use, and missing the ones it does.
#
# So this Makefile is a view onto the root gate scoped to one directory, not a second
# definition of it.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)
HERE := tools/oracle-py

# Same fallback as the root Makefile: `astral-sh/setup-uv` installs a standalone binary
# with no importable module, a local `pip install uv` often gives the module and no
# binary on PATH, and hard-coding either makes this work in exactly one of the two.
UV := $(shell command -v uv >/dev/null 2>&1 && echo uv || echo python -m uv)

export PYTHONUTF8 := 1

.DEFAULT_GOAL := verify
.PHONY: verify lint types test golden golden-write

verify: lint types test golden ## Everything that must hold for the oracle
	@echo "oracle-py verify OK"

lint: ## ruff check + format check, scoped to this package
	cd "$(ROOT)" && $(UV) run ruff check $(HERE)
	cd "$(ROOT)" && $(UV) run ruff format --check $(HERE)

types: ## mypy --strict over the oracle's source
	cd "$(ROOT)" && $(UV) run mypy $(HERE)/src

test: ## The oracle's unit tests and its CLI contract
	cd "$(ROOT)" && $(UV) run pytest $(HERE)/tests -q

golden: ## Every golden case still reproduces byte for byte
	cd "$(ROOT)" && $(UV) run python $(HERE)/golden.py

golden-write: ## Re-freeze the outputs. A deliberate act; see README.
	cd "$(ROOT)" && $(UV) run python $(HERE)/golden.py --write
