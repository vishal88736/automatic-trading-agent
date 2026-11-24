# Development

## Run the app

```bash
make setup
make dev
```

`make dev` (`scripts/dev.mjs`) starts PostgreSQL in Docker on `127.0.0.1:55432` and applies migrations. It then runs the product API (8794), the agents worker, the gateway (8790) and Vite (5173), with prefixed logs. Secrets are generated once into `.runtime/dev.json`. Set `KRONO_DATABASE_DSN` to use your own PostgreSQL instead of Docker.

The local gateway runs with `KRONO_AUTH_MODE=local`. Accounts are stored in PostgreSQL (`platform_credentials`, scrypt password hashes), and sessions are HMAC-signed HttpOnly cookies with double-submit CSRF. Cognito mode needs the AWS settings in `deploy/aws/.env` (see [AWS setup](AWS_SETUP.md)).

Strategy chat uses `KRONO_LLM_PROVIDER`. With no setting, it uses `groq` when `GROQ_API_KEY` is set and the built-in `rules` drafter otherwise. The `GROQ_*` settings accept any OpenAI-compatible endpoint.

## Code map

| Location                             | Responsibility                                                  |
| ------------------------------------ | --------------------------------------------------------------- |
| `frontend/src/platform/`             | Unified workspace, sign-in and product pages                    |
| `frontend/src/styles/`               | Shared typography, themes and shell layout                      |
| `backend/gateway/`                   | Fastify, Cognito sessions, model requests and signed forwarding |
| `backend/product/`                   | Private API, strategy versions, replay, paper ledger and worker |
| `backend/migrations/`                | Ordered PostgreSQL migrations with checksum verification        |
| `tests/e2e/`                         | Browser checks that open the Krono website                      |
| `backend/tests/`, `tests/inherited/` | Product and inherited numerical tests                           |
| `deploy/`, `infra/`                  | Container definitions and AWS infrastructure                    |

## Local checks

```bash
.venv/bin/ruff check backend scripts tests/e2e
.venv/bin/ruff format --check backend scripts tests/e2e
.venv/bin/python -m pytest -q
npm run check:platform
npm run build
npm run test:platform
npm run test:e2e
.venv/bin/python -m scripts.public_audit
```

The browser runner opens the same frontend used in production. It uses loopback ports 5180 and 8793 and supports overrides through `KRONO_E2E_UI_PORT` and `KRONO_E2E_GATEWAY_PORT`. Set `KRONO_E2E_BUILD=1` after a build to test the production bundle. PostgreSQL integration tests create and drop isolated schemas in the disposable database configured by `KRONO_TEST_DATABASE_DSN`.

The `paper` section of [runtime.json](../config/runtime.json) configures modeled costs and operational limits within the reviewed bounds. Its `providers` section defines spot endpoints, the reference assets and the featured ticker list. Set `KRONO_CONFIG_PATH` to select a different configuration. The market search uses the venue's full eligible spot catalog.

`make setup` installs the optional legacy graph and CLI dependencies. Install them separately with `uv sync --frozen --extra platform --extra legacy`. From the repository root, run `.venv/bin/python -m cli.main --help` or `.venv/bin/python cli/main.py --help`. Put personal provider keys in `.env.local` or the shell. The inherited graph accepts `TRADINGAGENTS_DEEP_MODEL` and `TRADINGAGENTS_QUICK_MODEL` to select deployment-supported models. Broker account reads require an explicit opt-in.

## Tenant PostgreSQL foundation

The platform schema lives in `backend/migrations/versions/`. It applies to a dedicated PostgreSQL database and uses verified Cognito subject UUIDs for ownership. The unified product provisions the paper account once after identity verification. SQLite files remain available for historical tools. An opening credit defaults to 10,000 virtual USDT and can be specified by the server when provisioning a new account.

Install the optional driver and run the migration as a release step. Set `KRONO_DATABASE_DSN` in the shell from your local configuration or deployment secret.

```bash
uv sync --frozen --extra platform
.venv/bin/python -m scripts.platform_database
```

Migrations use one transaction and an advisory lock and verify the applied revision checksums. A failed migration rolls back its changes. Keep applied revision files intact and take a database backup before upgrading a deployed environment. The API and worker reuse bounded connections. [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS) · [Psycopg pools](https://www.psycopg.org/psycopg3/docs/advanced/pool.html)

Migration `0012_paper_snapshot_metrics` adds buying power, P&L and drawdown to paper portfolio snapshots. The Overview shows a trend once two recorded values are available for that metric. Legacy snapshots contribute their recorded equity.

Set `KRONO_TEST_DATABASE_DSN` to a disposable PostgreSQL database with permission to create schemas and run:

```bash
.venv/bin/python -m pytest -q backend/tests/test_platform_postgres.py
```

### Authenticated product API

After applying the migrations, run the private FastAPI process with the database connection and a random `KRONO_PRODUCT_API_KEY` of at least 32 bytes in its server environment:

```bash
.venv/bin/python -m uvicorn backend.product.api:app_from_environment --factory --host 127.0.0.1 --port 8794
```

Set the same key and `KRONO_PRODUCT_API_URL=http://127.0.0.1:8794` in the Fastify process environment, then start the existing `npm run dev:platform` with its Cognito and AWS settings. For a hosted environment use a private HTTPS origin. The gateway verifies Cognito and CSRF, then signs the subject, expiration, HTTP method, raw path and payload digest. Keep both the key and database DSN server-side.

| Authenticated route                             | Behavior                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET or POST `/platform/paper-account`           | Read the current virtual account or provision it once. Optional server setting `KRONO_PAPER_INITIAL_USDT` controls the opening credit for new accounts. |
| GET or POST `/platform/custom-strategies`       | List with an `after` UUID cursor or create a validated strategy draft.                                                                                  |
| GET or PUT `/platform/custom-strategies/{id}`   | Read current or explicit `?version=` and append a revision with `expected_version` and `document`.                                                      |
| GET `/platform/custom-strategies/{id}/versions` | Read immutable versions with an optional `before` version cursor.                                                                                       |
| POST `/platform/custom-strategies/{id}/archive` | Archive with `expected_version`; existing version history remains available.                                                                            |

Create a saved-strategy replay with `POST /platform/custom-strategies/{id}/backtests`. Send the strategy `version`, UTC-hour-aligned ISO timestamps `start` (inclusive) and `end` (exclusive), and optional capital, fee, slippage, holdout, and risk assumptions. `mar_annual_pct` sets the annual minimum acceptable return for Sortino and defaults to zero. The API accepts 80 hours to 14 days for an eligible Coinbase spot market and retrieves 81 additional hourly candles for indicator warm-up. Missing hours reject the run. [Coinbase Exchange candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)

Retrieve the saved report with `GET /platform/backtests/{id}` and add `?include_dataset=true` to export the normalized market snapshot. The report pins the strategy version, replay version, venue, product, quote currency, candle digest and assumptions. Each chronological window starts with fresh capital and reports fills, equity, drawdown, and any open position at the final mark. A hypothetical liquidation value includes modeled fees and slippage. Paper-agent activation uses closed trades in the holdout.

With the gateway configured, sign in and open **Strategies**, **Backtesting Lab**, or **Paper Trading** from the unified workspace. Strategies supports JSON editing, copies, revision comparison and archiving. Backtesting Lab takes a saved version and a range of four to fourteen complete UTC days. Its persisted report shows in-sample and holdout metrics, charts, fills, assumptions, and the dataset digest. Paper Trading displays the backend balance after automatic account provisioning.

The isolated browser test uses the same PostgreSQL-backed service with fixture identities. For reproducible candle inputs, run the test-only `tests.e2e.product_api:application` Uvicorn factory with `TERMINAL_TEST_RUN=1` against a migrated disposable database. Set `KRONO_E2E_PRODUCT_API_URL` and `KRONO_E2E_PRODUCT_API_KEY` in the shell to match the private API, and run:

```bash
npm run test:e2e -- tests/e2e/platform-strategy.spec.ts
```

### Paper execution

Paper Trading reads the PostgreSQL ledger for cash, buying power, holdings, P&L, drawdown and the last 200 valuation snapshots. The dashboard's Paper trading portfolio shows open positions by asset and agent or manual source in the current account epoch. Marked value and unrealized P&L use the same fresh quotes as the portfolio totals. Its Live trading portfolio displays the gateway's execution status. A verified live-account feed is required to display live positions. Market orders model Coinbase Exchange USD ticker prices at parity with virtual USDT. Fees and slippage default to ten basis points each. The engine applies account-wide risk checks before increasing exposure. Stale marks produce an unavailable portfolio value or block a buy. [Coinbase Exchange ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)

The order API accepts market orders and quantity-based limit orders with an epoch and an idempotency UUID. Pending limits reserve funds or assets and can be checked or cancelled from Paper Trading. Each fill and its updated order status commit together. An emergency stop cancels all pending limits and prevents new orders. A reset starts a new funded epoch and retains earlier fills for review.

### Autonomous Paper Agents

Run `.venv/bin/python -m backend.product.worker` as a separate process with the same `KRONO_DATABASE_DSN` as the private product API. PostgreSQL stores each agent's next evaluation time, lease, checkpoint and decision timeline. The worker claims due agents with row locks, fences expired claims, and commits each order, decision and checkpoint together. The same process checks pending manual limit orders every 15 seconds when due.

Choose a saved strategy in **My Agents** or use an existing report from **Backtesting**. When starting from a saved version, the worker records a reproducible seven-day replay before activation. The same holdout and risk validation applies to both paths. Every seven days it checks the same version against a fresh, non-overlapping evaluation window and records the new report. A failed validation stops autonomous orders and leaves any position available for operator review and close. Agents evaluate strategy rules on each newly closed hourly candle and evaluate protective exits against fresh ticker observations. The browser polls the backend for display. Closing it or restarting the API does not affect scheduled jobs. Pause, stop and account reset invalidate any outstanding claim. Pause and stop leave existing positions in the ledger, and reset closes the account epoch.

The restarted worker resumes from the existing checkpoint. An interrupted claim can take up to 60 seconds to expire. Source failures retry with bounded exponential delay. Stopped and failed agents retain their order and decision history. Validate process recovery with `tests/e2e/paper-autonomy.spec.ts` against a disposable database. The test launches and restarts its own product API and accelerated worker when `KRONO_E2E_AUTONOMY=1`, using the existing product API key and URL test settings.

Open **AI Strategy Builder** and describe an objective in **Strategy chat**. Each follow-up can revise the last validated draft. Templates, manual edits and model drafts use the same hourly strategy schema. A condition's `threshold` accepts a numeric value or an indicator such as `ema_slow`. An explicit `max_position_usdt` caps the cash fraction budget in replay and paper execution, including the buy fee.

**Save strategy** adds the draft to the strategy library. To queue it for paper trading, choose **Run as paper agent**, set the virtual allocation and limits, and click **Start paper agent**. The authenticated `POST /platform/strategy-authoring/start-agent` call accepts a strategy document with the existing agent settings and a request key. It saves the draft and queues validation in one transaction. Retries with the same key and payload return the same agent and strategy. The worker evaluates the replay and risk checks before placing any simulated orders. The model receives drafting input and returns a validated preview.

**Market Analysis and AI Insights** can request an interpretation of current, source-tagged observations. Model output is labeled, has no trading tools, and is unavailable when validated market evidence is unavailable.

### Container topology and recovery

The local Compose file starts PostgreSQL 18, the schema migration, the private product API and the paper worker. The PostgreSQL 18 container mounts its named volume at `/var/lib/postgresql`. PostgreSQL stores the durable due-work queue using indexed due times, row locks and expiring claims. The AWS stack runs the same product image against private Aurora PostgreSQL. [Official PostgreSQL image](https://hub.docker.com/_/postgres)

Copy `deploy/paper/.env.example` to `deploy/paper/.env`, fill each secret with an independent random hex value, then run:

```bash
docker compose --env-file deploy/paper/.env -f deploy/paper/compose.yaml up -d --build
```

For local development, point the existing Fastify process at `KRONO_PRODUCT_API_URL=http://127.0.0.1:8794` with the same `KRONO_PRODUCT_API_KEY`. Use the existing frontend startup. In a hosted environment, route `/platform/*` through the authenticated Fastify gateway and serve the product API at a private HTTPS origin. API instances and workers need the same migrated PostgreSQL database and workers need network access to Coinbase Exchange. Before enabling strategy-based starts, stop the old paper worker, apply migration `0008`, and start the upgraded worker and API. Durable agents resume from their existing leases and checkpoints.

`/healthz` checks product database readiness. The worker health command checks the most recent worker heartbeat in PostgreSQL. For a failed process, inspect the Compose logs, restart only the unhealthy service and wait for the worker lease to expire if it was interrupted. A worker unavailable for 30 seconds loses its healthy signal. Use PostgreSQL backups to protect durable state. Recovery from service restarts relies on persistence of the database volume.

Markets and Crypto News reuse the existing Coinbase and cryptocurrency.cv integrations. The workspace displays source, status and timestamps. Watchlists are saved per tenant. The agent timeline streams persisted events over SSE and falls back to polling if streaming is unavailable. The worker continues when every client disconnects.

Paper agent allocations reserve virtual buying power while active or paused. Agent positions retain their order attribution in the shared ledger. The worker checks both account-wide execution limits and each agent's loss and drawdown against its own marked allocation. A breach pauses the agent and records a risk event.
