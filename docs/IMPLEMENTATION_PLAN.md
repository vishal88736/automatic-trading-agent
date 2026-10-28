# Implementation plan and initial audit

Audit date: 2026-10-28. Local repository began with README and ignore rules only.

Upstream: https://github.com/vishal88736/alpaca-trading-agent
Inspected revision: `2495276210d977dd09a5190def02755f5b96bea8` (Apache-2.0).

## Reuse map

| Existing component | Treatment |
| --- | --- |
| Python/LangGraph analyst, bull/bear, trader and manager roles | Preserve source and prompts; add a bounded read-only research bridge. Never treat an LLM risk opinion as execution authorization. |
| Structured TradeIntent schemas and persistent research logs | Preserve; adapt recommendations into validated terminal proposals. |
| Regime classifier and ATR/position sizing | Reuse deterministic calculations through an adapter; explicitly adapt crypto timeframe assumptions. |
| Backtrader recorded-decision/walk-forward engine | Preserve for compatible workflows; add chronological next-bar terminal backtests with explicit synthetic provenance. |
| Alpaca data/account/execution utilities | Preserve with original Dash/CLI; terminal exposes a separate paper-only boundary. Never route HSKSwap requests to Alpaca. |
| Dash UI and tests | Preserve in legacy entrypoints. Add React/TypeScript for the requested terminal. |
| Crypto-specific data tools | Preserve, but terminal news uses the hosted cryptocurrency.cv API and typed normalization. |
| Independent DEX risk, execution intents, reconciliation and wallet authorization | New implementation required. |

## Coherent increments

1. Preserve upstream package, entrypoints, tests, license and attribution. Establish domain models, SQLite storage and authenticated API contracts.
2. Implement bounded market/news providers, timestamps, source references, caching and unavailable states. Keep fixtures explicitly separate.
3. Adapt indicators/regime logic, create a focused strategy registry and LangGraph workflow, enforce deterministic risk, and implement idempotent simulation execution and accounting.
4. Investigate HSKSwap from primary sources. Implement read-only network/wallet inspection and isolate unverifiable quoting/signing behind a disabled adapter.
5. Build graphite/orange React terminal, strategy forms, news detail, observatory, portfolio, execution preview, risk settings and typed assistant actions.
6. Add persistent scheduler/recovery, backend and browser tests, reproducible demo, setup and verification documentation; publish coherent commits to the requested public repository.

## Verification boundaries

Simulation tests must never inherit live mode. No live funds or signing in tests. Network/contract discovery is not proof of successful swapping. Unknown data stays unavailable. Live execution stays disabled until exchange configuration, token metadata, executable routes and a secure wallet authorization flow have been independently validated.
