# Development

## Run the app

Use `make setup`, then `uv sync --frozen --extra platform`. Run PostgreSQL, the private product API, and the independent worker using the [container topology](#container-topology-and-recovery). Run the [authenticated gateway](#authenticated-product-api) separately with your Cognito configuration and the same private API signing key. Then run the frontend:

```bash
make demo
```

Open [Krono](http://127.0.0.1:5173/). The Vite development proxy sends `/platform/*` to the Fastify gateway on port 8790 by default. Use `KRONO_PLATFORM_URL` for a different local gateway origin. In production, serve the built frontend and delegate `/platform/*` to the same-origin gateway. Browser sessions do not own agent processes.

## Code map

| Location                                | Responsibility                                              |
| --------------------------------------- | ----------------------------------------------------------- |
| `frontend/src/platform/Workspace.tsx`   | Unified authenticated shell, routing, and account provision |
| `frontend/src/platform/`                | Product modules using one tenant gateway                    |
| `backend/platform_product_api.py`       | Private authenticated product endpoints                     |
| `backend/paper_execution.py`            | Shared PostgreSQL order gate and portfolio accounting       |
| `backend/paper_worker.py`               | Durable leases, activation, periodic replay and order loop  |
| `frontend/src/App.tsx`                  | Historical UI for development regression fixtures           |
| `frontend/src/aegis/`                   | Shared state, conversation, market analysis and route types |
| `backend/api.py`                        | Authenticated local HTTP boundary                           |
| `backend/aegis_bridge.py`               | Original strategy rules/selector to typed HSKSwap inputs    |
| `backend/engine.py`                     | Research LangGraph and simulation scheduler                 |
| `backend/strategies.py`                 | Original five-strategy implementation                       |
| `agent/aegis/service.py`, `runtime.py`  | Single-writer paper orchestration and recovery              |
| `agent/aegis/connectors/`               | Verified V3 RPC, routes, quotes and paper fills             |
| `agent/aegis/execution/`                | Paper gateway and separate guarded signing/reconciliation   |
| `agent/aegis/nl/`                       | Validated tools, optional Claude and Telegram               |
| `contracts/`                            | Vault/oracle/log, tests and deployment recorder             |
| `backend/src/`, `infra/`, `deploy/aws/` | Cognito gateway, model access, and retained AWS tooling     |
| `tradingagents/`, `webui/`, `cli/`      | Retained framework and legacy compatibility                 |

[Generated source reference](SOURCE_REFERENCE.md) indexes actual API routes and symbols. Regenerate it with `.venv/bin/python -m scripts.generate_code_reference`; CI checks it with `--check`.

## Configuration and storage

`config/runtime.json` supplies validated terminal defaults. `.env.example` lists supported local environment settings. Saved, versioned provider settings take precedence after first startup; update them in Settings. `config/networks.yaml` holds chain-specific verified identities, decimals, ABIs and code pins. Do not replace only the RPC URL when changing networks.

The terminal database defaults to `.runtime/terminal.sqlite3`; AEGIS uses `.runtime/aegis-paper.sqlite3`. Runtime data, credentials, journals, downloaded tools, dependencies and generated artifacts are ignored by Git. Keep the existing database when restarting to retain balances, fills, preferences and emergency state. Changing market sources after simulation fills requires a separate database.

## Single source of truth for limits

Do not copy a limit, asset list or network URL into a second place. Read it from its source:

| Value                                                                                         | Source                                                                                            | Consumers                                                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Guard caps (sizing, trades/hour/day, loss, drawdown, exposure, cooldown, stops, holding time) | `CAPS` in `agent/aegis/risk/policy.py`, checked against `GUARD_LIMITS` in `agent/aegis/deploy.py` | `entry_check`, circuit breaker, `AgentParams` ceilings, chat tool schema, `state.caps` in the UI |
| Preference bounds                                                                             | `AgentParams` → `PARAM_BOUNDS`                                                                    | `state.param_bounds` → AEGIS settings form `min`/`max`                                           |
| Supported assets, native strategies                                                           | `SUPPORTED_ASSETS`, `NATIVE_STRATEGIES`                                                           | runtime market filter, chat schema, `state.supported_assets` / `state.native_strategies`         |
| Risk-appetite presets, mean-reversion thresholds                                              | `RISK_PRESETS`, `MEAN_REVERSION_Z`                                                                | deterministic router and LLM tool path alike                                                     |
| Paper costs                                                                                   | `PaperTerms`                                                                                      | gateway, signals, `state.costs`                                                                  |
| Explorer URL                                                                                  | `config/networks.yaml`                                                                            | `state.explorer`                                                                                 |
| Krono risk bounds                                                                             | `RiskConfig` in `backend/models.py`                                                               | `risk.bounds` in `/api/risk` and `/api/dashboard` → risk form                                    |

`agent/tests/test_single_source.py` and `backend/tests/test_api_backtest.py::test_risk_bounds_are_served_from_the_model` fail when a value drifts. Fix the source, not the test.

## Debugging and checks

Use [verification commands](VERIFICATION.md) and the [connection guide](CONNECTIONS.md). A running agent may legitimately produce only skips. Check data freshness, required history, reference/DEX gaps, target assets, fees, cooldowns and stop state in the Trading Desk and Observatory.

`SIMULATION` and `PAPER` are separate ledgers. Browser polling reads cached state and cannot submit a trade. An uncertain public transaction must be reconciled through its existing journal; never infer a new submission is safe from a timeout.

For the original manual simulation demo, intentionally choose fixture providers in Settings, Analyze BTC, inspect the recorded strategy/risk stages, review the quote and explicitly authorize the simulated fill. Fixture history and liquidity assumptions remain labeled. Restore Coinbase for the normal HSKSwap library adapter.

## Optional legacy environment

The retained Dash/Alpaca entry points use additional broker, model, embedding and UI packages. They are separate from the locked main app and have not been fully validated here. Their original dependency list is retained in [config/legacy-requirements.txt](../config/legacy-requirements.txt):

```bash
UV_CACHE_DIR="$PWD/.cache/uv" uv venv .venv-legacy --python 3.12
UV_CACHE_DIR="$PWD/.cache/uv" uv pip install --python .venv-legacy/bin/python -r config/legacy-requirements.txt
ALPACA_USE_PAPER=True .venv-legacy/bin/python run_webui_dash.py
```

This optional install downloads the legacy dependency set. Review provider compatibility and supply credentials locally. Alpaca is never an HSKSwap fallback. Attribution and component licenses are retained in [third-party notices](../THIRD_PARTY_NOTICES.md).

## Tenant PostgreSQL foundation

The platform schema lives in `migrations/versions/`. It applies to a dedicated PostgreSQL database and uses verified Cognito subject UUIDs for ownership. The unified product provisions the paper account once after identity verification. SQLite files remain available for historical tools. An opening credit defaults to 10,000 virtual USDT and can be specified by the server when provisioning a new account.

Install the optional driver and run the migration as a release step. Set `KRONO_DATABASE_DSN` in the shell from your local configuration or deployment secret.

```bash
uv sync --frozen --extra platform
.venv/bin/python -m scripts.platform_database
```

Migrations run in a single PostgreSQL transaction with a transaction-scoped advisory lock and verify the applied revision checksums. A failed migration rolls back its changes. Keep applied revision files intact and take a database backup before upgrading a deployed environment. Use a migration role with DDL permissions and a separate, restricted runtime role. [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS), [Psycopg transactions](https://www.psycopg.org/psycopg3/docs/basic/transactions.html)

Set `KRONO_TEST_DATABASE_DSN` to a disposable PostgreSQL database with permission to create schemas and run:

```bash
.venv/bin/python -m pytest -q backend/tests/test_platform_postgres.py
```

### Authenticated product API

After applying the migrations, run the private FastAPI process with the database connection and a random `KRONO_PRODUCT_API_KEY` of at least 32 bytes in its server environment:

```bash
.venv/bin/python -m uvicorn backend.platform_product_api:app_from_environment --factory --host 127.0.0.1 --port 8794
```

Set the same key and `KRONO_PRODUCT_API_URL=http://127.0.0.1:8794` in the Fastify process environment, then start the existing `npm run dev:platform` with its Cognito and AWS settings. For a hosted environment use a private HTTPS origin. The gateway verifies Cognito and CSRF, then signs the subject, expiration, HTTP method, raw path and payload digest. Keep both the key and database DSN server-side. The product API remains separately configured from the local operator API and AEGIS.

| Authenticated route                             | Behavior                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET or POST `/platform/paper-account`           | Read the current virtual account or provision it once. Optional server setting `KRONO_PAPER_INITIAL_USDT` controls the opening credit for new accounts. |
| GET or POST `/platform/custom-strategies`       | List with an `after` UUID cursor or create a validated strategy draft.                                                                                  |
| GET or PUT `/platform/custom-strategies/{id}`   | Read current or explicit `?version=` and append a revision with `expected_version` and `document`.                                                      |
| GET `/platform/custom-strategies/{id}/versions` | Read immutable versions with an optional `before` version cursor.                                                                                       |
| POST `/platform/custom-strategies/{id}/archive` | Archive with `expected_version`; existing version history remains available.                                                                            |

Create a saved-strategy replay with `POST /platform/custom-strategies/{id}/backtests`. Send the specific strategy `version`, UTC-hour-aligned ISO timestamps `start` and `end`, and optional capital, fee, slippage, holdout, and risk assumptions. The API supports 80 hours to 14 days of selected BTC/USD, ETH/USD or SOL/USD hourly history from Coinbase Exchange and retrieves 81 additional closed hours for indicator warm-up. Missing hours reject the run. [Coinbase Exchange candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)

Retrieve the saved report with `GET /platform/backtests/{id}` and add `?include_dataset=true` to export the exact normalized market snapshot. The report pins the strategy version, replay version, candle digest, input assumptions, in-sample and holdout results, fills, equity and drawdown. Protection triggers use a documented hourly OHLC assumption. The worker requires an eligible pinned replay before paper trading.

With the gateway configured, sign in and open **Strategies**, **Backtesting Lab**, or **Paper Trading** from the unified workspace. Strategies supports JSON editing, copies, revision comparison and archiving. Backtesting Lab takes a saved version and a range of four to fourteen complete UTC days. Its persisted report shows in-sample and holdout metrics, charts, fills, assumptions, and the dataset digest. Paper Trading displays the backend balance after automatic account provisioning.

The isolated browser test uses the same PostgreSQL-backed service with fixture identities. For reproducible candle inputs, run the test-only `e2e.product_api:application` Uvicorn factory with `TERMINAL_TEST_RUN=1` against a migrated disposable database. Set `KRONO_E2E_PRODUCT_API_URL` and `KRONO_E2E_PRODUCT_API_KEY` in the shell to match the private API, and run:

```bash
npm run test:e2e -- e2e/platform-strategy.spec.ts
```

### Paper execution

Paper Trading reads the PostgreSQL ledger for cash, buying power, holdings, P&L, drawdown and the last 200 valuation snapshots. Market orders model Coinbase Exchange USD ticker prices at parity with virtual USDT. Fees and slippage default to ten basis points each. The engine applies account-wide risk checks before increasing exposure. Stale marks produce an unavailable portfolio value or block a buy. [Coinbase Exchange ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)

The order API accepts market orders and quantity-based limit orders with an epoch and an idempotency UUID. Pending limits reserve funds or assets and can be checked or cancelled from Paper Trading. Each fill and its updated order status commit together. An emergency stop cancels all pending limits and prevents new orders. A reset starts a new funded epoch and retains earlier fills for review.

### Autonomous Paper Agents

Run `.venv/bin/python -m backend.paper_worker` as a separate process with the same `KRONO_DATABASE_DSN` as the private product API. PostgreSQL stores each agent's next evaluation time, lease, checkpoint and decision timeline. The worker claims due agents with row locks, fences expired claims, and commits each order, decision and checkpoint together. The same process checks pending manual limit orders every 15 seconds when due.

Choose a saved strategy in **AI Trading Agents** or use an existing report from **Backtesting Lab**. When starting from a saved version, the worker records a reproducible seven-day replay before activation. The same holdout and risk validation applies to both paths. Every seven days it checks the same version against a fresh, non-overlapping evaluation window and records the new report. A failed validation stops autonomous orders and leaves any position available for operator review and close. Agents evaluate strategy rules on each newly closed hourly candle and evaluate protective exits against fresh ticker observations. The browser polls the backend for display. Closing it or restarting the API does not affect scheduled jobs. Pause, stop and account reset invalidate any outstanding claim. Pause and stop leave existing positions in the ledger, and reset closes the account epoch.

The restarted worker resumes from the existing checkpoint. An interrupted claim can take up to 60 seconds to expire. Source failures retry with bounded exponential delay. Stopped and failed agents retain their order and decision history. Validate process recovery with `e2e/paper-autonomy.spec.ts` against a disposable database. The test launches and restarts its own product API and accelerated worker when `KRONO_E2E_AUTONOMY=1`, using the existing product API key and URL test settings.

Open **Custom Strategy Builder** and paste an objective in **Strategy chat**. Each follow-up can revise the last validated draft. Use **Edit strategy** to open the visual builder or switch to structured JSON. Templates, manual edits and model drafts use the same hourly strategy schema.

**Save strategy** adds the draft to the strategy library. To queue it for paper trading, choose **Run as paper agent**, set the virtual allocation and limits, and click **Start paper agent**. The authenticated `POST /platform/strategy-authoring/start-agent` call accepts a strategy document with the existing agent settings and a request key. It saves the draft and queues validation in one transaction. Retries with the same key and payload return the same agent and strategy. The worker evaluates the replay and risk checks before placing any simulated orders. The model receives drafting input and returns a validated preview.

**Market Analysis and AI Insights** can request an interpretation of current, source-tagged observations. Model output is labeled, has no trading tools, and is unavailable when validated market evidence is unavailable.

### Container topology and recovery

The Vite frontend and authenticated Fastify gateway retain their existing deployment configuration. Run the private FastAPI product service and paper worker independently of both. The local Compose file starts PostgreSQL, the schema migration, the product API and the worker. PostgreSQL stores the durable due-work queue and acts as the scheduler using indexed due times, row locks and expiring claims. No additional broker is required for the current queue.

Copy `deploy/paper/.env.example` to `deploy/paper/.env`, fill each secret with an independent random hex value, then run:

```bash
docker compose --env-file deploy/paper/.env -f deploy/paper/compose.yaml up -d --build
```

For local development, point the existing Fastify process at `KRONO_PRODUCT_API_URL=http://127.0.0.1:8794` with the same `KRONO_PRODUCT_API_KEY`. Use the existing frontend startup. In a hosted environment, route `/platform/*` through the authenticated Fastify gateway and serve the product API at a private HTTPS origin. API instances and workers need the same migrated PostgreSQL database and workers need network access to Coinbase Exchange. Before enabling strategy-based starts, stop the old paper worker, apply migration `0008`, and start the upgraded worker and API. Durable agents resume from their existing leases and checkpoints.

`/healthz` checks product database readiness. The worker health command checks the most recent worker heartbeat in PostgreSQL. For a failed process, inspect the Compose logs, restart only the unhealthy service and wait for the worker lease to expire if it was interrupted. A worker unavailable for 30 seconds loses its healthy signal. Use PostgreSQL backups to protect durable state. Recovery from service restarts relies on persistence of the database volume.

Markets and Crypto News reuse the existing Coinbase and cryptocurrency.cv integrations. The workspace displays source, status and timestamps. Watchlists are saved per tenant. The agent timeline streams persisted events over SSE and falls back to polling if streaming is unavailable. The worker continues when every client disconnects.

Paper agent allocations reserve virtual buying power while active or paused. Agent positions retain their order attribution in the shared ledger. The worker checks both account-wide execution limits and each agent's loss and drawdown against its own marked allocation. A breach pauses the agent and records a risk event.
