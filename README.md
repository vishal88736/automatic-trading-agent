# Krono

Krono is a personal crypto strategy and paper-trading platform. Build strategies in chat, visually, or in JSON. Backtest a saved version, then start a paper agent that keeps running in a backend worker after the browser closes.

## Run locally

```bash
make setup
```

Start PostgreSQL, the private API, the gateway, and the worker using the [development guide](docs/DEVELOPMENT.md). Then run `make demo` and open [Krono on localhost](http://127.0.0.1:5173/). Authentication uses the configured Cognito environment. Paper orders use virtual USDT.

## Repository layout

| Folder                | Contents                                                   |
| --------------------- | ---------------------------------------------------------- |
| `frontend/`           | React website and shared styles                            |
| `backend/product/`    | FastAPI, strategies, backtests, paper execution and worker |
| `backend/gateway/`    | Fastify identity gateway and model integration             |
| `backend/migrations/` | PostgreSQL schema migrations                               |
| `tests/e2e/`          | Browser tests and isolated fixtures for the same website   |
| `deploy/`, `infra/`   | Containers and AWS infrastructure                          |
| `docs/`               | Architecture, setup and verification                       |

[Architecture](docs/ARCHITECTURE.md) describes how the services fit together. [Consolidation notes](docs/CONSOLIDATION.md) cover the retired web apps and migration. The [HashKey operator guide](docs/operator/AEGIS_FLOWS.md) and [testnet evidence](docs/operator/CONTRACTS.md) document the separately operated chain tools.

Krono reuses components from the TradingAgents framework. See [third-party notices](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE).
