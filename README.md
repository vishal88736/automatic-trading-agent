# Krono

Krono is an automated cryptocurrency trading platform. Describe a strategy to the AI builder in plain English, backtest it on real market data, and run it as an agent that keeps trading on the server after you close the browser. Every running agent competes on a public leaderboard.

- **Paper trading**: each account starts with 10,000 virtual USDT, priced against live Coinbase quotes with simulated fees and slippage.
- **Live trading**: link Binance, Bybit or OKX (each has a free testnet) with a trade-only key. Trade by hand, or promote a proven paper agent so its trades are mirrored to your account. See [live trading](docs/LIVE_TRADING.md).
- **Live data**: streaming Binance prices and real-time news from [cryptocurrency.cv](https://cryptocurrency.cv), both free.

## Run locally

Requirements: Node 22+, [uv](https://docs.astral.sh/uv/), and Docker (for PostgreSQL).

```bash
make setup   # Python and Node dependencies, production build
make dev     # PostgreSQL, migrations, API, agents worker, gateway and UI
```

Open [Krono on localhost](http://127.0.0.1:5173/) and create an account. `make dev` generates its local secrets in `.runtime/dev.json`. Strategy chat works without a model key using the built-in rules drafter. To use an LLM, set `GROQ_API_KEY` (or any OpenAI-compatible endpoint) in `.env`. See [`.env.example`](.env.example).

## Repository layout

| Folder                | Contents                                                      |
| --------------------- | ------------------------------------------------------------- |
| `frontend/`           | React app: landing, workspace, leaderboard, strategy chat     |
| `backend/product/`    | FastAPI service, strategies, backtests, paper ledger, worker  |
| `backend/gateway/`    | Fastify gateway: sign-in, CSRF, model drafting, signed proxy  |
| `backend/migrations/` | PostgreSQL schema migrations                                  |
| `tradingagents/`      | Indicator, regime and sizing components reused by the backend |
| `tests/e2e/`          | Browser tests with isolated fixtures                          |
| `deploy/`, `infra/`   | Containers and AWS infrastructure                             |
| `docs/`               | Architecture, development and verification                    |

[Architecture](docs/ARCHITECTURE.md) describes how the services fit together, and [development](docs/DEVELOPMENT.md) covers configuration, tests and deployment.

Krono reuses components from the TradingAgents framework. See [third-party notices](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE).
