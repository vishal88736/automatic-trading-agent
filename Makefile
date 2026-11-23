PYTHON ?= .venv/bin/python

.PHONY: setup dev demo test

setup:
	UV_CACHE_DIR="$(CURDIR)/.cache/uv" UV_PYTHON_INSTALL_DIR="$(CURDIR)/.python" uv sync --frozen --extra platform --extra legacy --python 3.12
	npm ci --ignore-scripts
	npm run build

# PostgreSQL (Docker), migrations, product API, agents worker, gateway and UI in one command.
dev:
	npm run dev

demo: dev

test:
	$(PYTHON) -m pytest -q
	npm run test:platform
	npm run build
