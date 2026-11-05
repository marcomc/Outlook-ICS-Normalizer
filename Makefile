NODE ?= node
PYTHON ?= python3
MARKDOWNLINT ?= markdownlint
MARKDOWNLINT_CONFIG ?= .markdownlint.json

.DEFAULT_GOAL := help
.PHONY: help prepare test lint check

help:
	@echo 'make prepare  Prepare private Apps Script files from config.local.json'
	@echo 'make check    Run regression tests and Markdown lint'

prepare:
	$(PYTHON) scripts/prepare.py

test:
	$(NODE) --check Code.js
	$(NODE) tests/audit.test.js
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py'

lint:
	$(MARKDOWNLINT) --config $(MARKDOWNLINT_CONFIG) README.md AGENTS.md TODO.md

check: test lint
