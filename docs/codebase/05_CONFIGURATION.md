# Configuration and hardcoded-value audit

## The three configuration layers

| Layer                        | Location                                                                               | Purpose                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public operator defaults     | [`config/runtime.json`](../../config/runtime.json), validated by `backend/settings.py` | Provider selection/endpoints/asset metadata, timeouts/concurrency/retries, cache defaults, simulation capital/cost/liquidity assumptions, quote/proposal lifetimes, mark sampling and documented HSK metadata. No secrets. |
| Local persistent workspace   | SQLite `config` records, edited through validated `/api/*` controls                    | Selected providers, refresh policy, strategy parameters, selector state, risk, scheduler, initial account capital and observed high-water mark. Versioned changes are audited.                                             |
| Cloud deployment and tenants | Ignored `deploy/aws/.env`, `backend/src/config.ts`, DynamoDB entities                  | AWS target/model/quotas/infrastructure plus owned profiles, agent specs, revisions, permissions, reviewed actions and runtime state.                                                                                       |

The root ignored `.env` belongs to the local terminal. `deploy/aws/.env` belongs to cloud setup. Putting a local market selection into the AWS file does not change a running local SQLite workspace.

The local launcher loads the root `.env`. On a new database, `MARKET_PROVIDER` and `NEWS_PROVIDER` override the provider defaults. After that first startup, the saved **Settings → Data providers** selection wins. Editing `.env` does not silently replace an existing audited selection. This was the reason the inspected workspace continued to use fixtures.

`KRONO_CONFIG_PATH` may select another trusted operator JSON file. Its shape is strictly validated, it is cached per process, and edits require a restart. Persisted account capital and user settings are not overwritten by changing defaults. Apply per-workspace refresh changes through **Settings → Feed refresh**, or start a new workspace when changing its financial data assumptions.

## Values moved out of implementation code

- Coinbase/news base URLs, registered product names/IDs and default source selection.
- Provider HTTP timeouts, connection/concurrency limits, safe read retry count and backoff.
- Separate ticker, candle and news cache lifetimes plus outage retry cooldown.
- Default simulation capital, fee/slippage basis points, assumed liquidity and network cost.
- Quote lifetime, deadline, proposal lifetime and portfolio chart-snapshot interval.
- Default scheduler interval and conversational default asset.
- HSK chain/RPC/explorer/native metadata, provenance URLs and documented token registry.

Simulation quote descriptions are generated from those actual assumptions. Candidate expected costs use the same simulation model, rather than a separate fixed percentage. Backtests accept `initial_equity`, fee and slippage overrides with validated bounds.

## Values that deliberately remain trusted code

Hard safety ceilings, mandatory authorization, tenant ownership checks, supported adapter/strategy identifiers, no-LIVE enforcement, idempotency and the rule that news/model text cannot grant authority remain in code. They must not become user-overridable configuration.

The asset universe can select the reviewed BTC/ETH/SOL reference adapters. Adding another asset still needs schema/adapter/tests and verified identity; editing a symbol alone cannot create a blockchain token. Registry token addresses are documented configuration, not verified decimals, executable routes or permission to trade.

Indicator formulas and units such as 10,000 basis points per unit or 3,600 seconds per hour are algorithmic constants. Fixed synthetic candle/news fixtures are intentionally reproducible test inputs. They are not fallback live data. Placeholder performance returns, balances and deployments are not introduced.

Built-in strategy parameter defaults are validated `StrategyConfig` templates and are persisted/versioned per strategy; cloud user/agent parameters are validated Zod specifications. Bedrock model/region/output/timeout/usage settings are centralized environment configuration. Safety prompt text is trusted code; saved user style preferences remain subordinate.

## Safe change examples

Use current prices while simulating trades:

```dotenv
TERMINAL_MODE=SIMULATION
MARKET_PROVIDER=coinbase
NEWS_PROVIDER=cryptocurrency.cv
```

On an existing database, select those providers in Settings as well. If simulated fills already exist, a market-source change requires a new database, for example `TERMINAL_DB=.runtime/another-workspace.sqlite3`. Keep the old database; do not delete ledger rows to bypass provenance checks.

Changing a risk/strategy/provider version, runtime fingerprint or relevant source invalidates an old execution preview. Refresh and analyze again. This is a deliberate safety response, not a broken order button.

Never add AWS credentials, API keys, wallet keys or seed phrases to `config/runtime.json`, frontend variables, screenshots, source reference files or Git. API credentials remain server-side; wallet signing is not implemented for live HSKSwap execution.
