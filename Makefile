PYTHON ?= .venv/bin/python

.PHONY: setup demo

setup:
	UV_CACHE_DIR="$(CURDIR)/.cache/uv" UV_PYTHON_INSTALL_DIR="$(CURDIR)/.python" uv sync --frozen --extra platform --python 3.12
	npm ci --ignore-scripts
	npm run build

demo:
	npm run dev

include scripts/operators.mk
