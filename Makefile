ARCHES := x86 arm
TS_CHECK := npm run check && npm test
include node_modules/@start9labs/start-sdk/s9pk.mk

ASSET_INPUTS := $(shell find assets -type f)
SKILL_INPUTS := $(shell find .ai-workspace/bundled-skills -type f)
PACKAGE_OUTPUTS := $(BASE_NAME).s9pk $(BASE_NAME)_x86_64.s9pk $(BASE_NAME)_aarch64.s9pk

.PHONY: check-assets

$(PACKAGE_OUTPUTS): $(ASSET_INPUTS) $(SKILL_INPUTS) .dockerignore Makefile | check-assets

check-assets:
	@python3 -c 'from pathlib import Path; import sys; invalid = sorted(str(p) for p in Path("assets").rglob("*") if p.name == "__pycache__" or p.suffix in {".pyc", ".pyo"}); sys.exit("Remove generated Python cache files before packaging: " + ", ".join(invalid) if invalid else 0)'
