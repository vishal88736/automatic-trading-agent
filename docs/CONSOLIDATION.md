# Krono consolidation

The public landing page and authenticated workspace share one React entry point. The Fastify gateway forwards authorized requests to the private FastAPI product service, which maintains the PostgreSQL paper ledger. The independent worker uses that same ledger for simulated orders.

| Area                                   | Active location                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Dashboard, paper orders and portfolio  | React product pages and `backend/product/execution.py`                       |
| Chat, visual and JSON strategy editing | Strategy Builder, gateway model drafting and `backend/product/rules.py`      |
| Backtests and saved strategy versions  | `backend/product/backtests.py` and `backend/product/strategies.py`           |
| Durable agents, risk and recovery      | `backend/product/worker.py` and `backend/product/agents.py`                  |
| Browser tests                          | `tests/e2e/`, opening the product with isolated identity and market fixtures |

The retired React and Dash websites, their website-only fixtures, and their unused styles and illustrations were removed. Legacy page bookmarks redirect into the Krono workspace.

The worker pins a saved strategy version and a reproducible replay before activation. It uses leases, checkpoints and idempotent fills to recover across restarts. Strategy chat can save a draft and start validation in one transaction. Live execution is disabled in the product.

See [development](DEVELOPMENT.md) for current commands and [architecture](ARCHITECTURE.md) for service boundaries.

The HashKey Chain contracts, the AEGIS DEX agent, the operator API and their verification evidence were removed when the platform was restructured into automated cryptocurrency trading. They remain in Git history.
