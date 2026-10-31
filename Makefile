PYTHON ?= .venv/bin/python
NETWORK ?= mainnet

.PHONY: setup prices verify-discovery test-discovery

setup:
	UV_CACHE_DIR="$(CURDIR)/.cache/uv" UV_PYTHON_INSTALL_DIR="$(CURDIR)/.python" uv sync --frozen --python 3.12

prices:
	PYTHONPATH=agent $(PYTHON) -m aegis.prices --network $(NETWORK) $(ARGS)

verify-discovery:
	PYTHONPATH=agent $(PYTHON) -m aegis.discovery $(ARGS)

test-discovery:
	PYTHONPATH=agent $(PYTHON) -m pytest agent/tests -q
