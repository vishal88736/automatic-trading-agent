# Krono

Krono is an authenticated cryptocurrency research and autonomous paper-trading workspace. Build a strategy from a template, natural language, a visual rule editor, or JSON. Replay an immutable version against historical candles and run it with virtual funds. Manual and autonomous orders use the same PostgreSQL ledger, risk checks, and portfolio accounting.

The ten primary modules are Dashboard, AI Trading Agents, Strategies, Custom Strategy Builder, Backtesting Lab, Paper Trading, Market Analysis and AI Insights, Portfolio, Crypto News, and Settings. It uses simulated funds throughout.

## Run locally

Install the locked dependencies with `make setup` and `uv sync --frozen --extra platform`. Follow the [development setup](docs/DEVELOPMENT.md#run-the-app) to run PostgreSQL, the product API, the identity gateway, and the independent worker. Run `make demo` for the frontend and open [Krono](http://127.0.0.1:5173/). Authentication requires a configured Cognito environment. Model-assisted features use the configured server-side model provider.

## Autonomous paper trading

1. Sign in to provision your virtual account.
2. Create a versioned strategy or customize a prebuilt template.
3. Run a historical replay in Backtesting Lab, or start an agent directly from a saved strategy version and let the worker backtest it.
4. Set the agent's allocation, schedule, and deterministic loss limits. The worker checks the holdout and risk policy before placing any simulated orders.
5. Inspect the agent timeline and Portfolio. The worker continues after browser disconnect or sign-out, and uses PostgreSQL checkpoints to recover from restarts.
6. Pause or stop an agent from AI Trading Agents. Settings contains the account-wide emergency stop and virtual account reset.

The [architecture audit](ARCHITECTURE_AUDIT.md) and [consolidation map](docs/CONSOLIDATION.md) document the services and migration boundaries. The [verification guide](docs/VERIFICATION.md) includes historical runtime and contract checks. The [historical README](https://github.com/vishal88736/automatic-trading-agent/blob/1e1db6b/README.md) records the original interfaces and operator commands.

## Historical HashKey testnet evidence

The public registry records all three modules on **chain 133**:

| Contract         | Verified deployment                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| AegisVault       | [0xE14185B7beFeeFF8ab241c3Ffae13bA7Ed61df5d](https://testnet-explorer.hskchain.net/address/0xE14185B7beFeeFF8ab241c3Ffae13bA7Ed61df5d) |
| BandedTwapOracle | [0x521C86fD6fe77Fee7493dC9e7242BBed271dE73f](https://testnet-explorer.hskchain.net/address/0x521C86fD6fe77Fee7493dC9e7242BBed271dE73f) |
| DecisionLog      | [0xA015aEAB0E97857b7eE322c7F7ee98AE98Cd9A30](https://testnet-explorer.hskchain.net/address/0xA015aEAB0E97857b7eE322c7F7ee98AE98Cd9A30) |

| Recorded decision                  | Commit                                                                                                                     | Guarded swap                                                                                                               | Reveal                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **#1: stale-quote rejection**      | [0x6b72b4d8…](https://testnet-explorer.hskchain.net/tx/0x6b72b4d84d48f9dde5dc3b9e44ff4114fa8587ed2333a2a92b25c5a52fd9f77c) | Skipped; no swap transaction                                                                                               | [0x614e6ff7…](https://testnet-explorer.hskchain.net/tx/0x614e6ff788e6c5e70aa1201b3e1dd31815bb515b0d337cfc71c0d11b781835a8) |
| **#2: complete guarded lifecycle** | [0x2feb12ee…](https://testnet-explorer.hskchain.net/tx/0x2feb12eef781e1c261b93b29331bbc3fcc3715eeaf82c161519f790d05ac27ea) | [0x608bf335…](https://testnet-explorer.hskchain.net/tx/0x608bf3356bc586488b815b41d73bfad1db06c5c858517b27aaabf6b46f0a1a26) | [0x2a233028…](https://testnet-explorer.hskchain.net/tx/0x2a23302898edd33571f08f5759c4f3fc20fa529f4345a622188e603dff6adf93) |

Decision #1's quote was **57 seconds old** against a **20-second TTL**. The off-chain freshness gate rejected the swap; the on-chain reveal proves the exact unused commitment. Vault token balances were unchanged, while the agent paid commitment/reveal gas.

Decision #2 swapped **0.005 WHSK** into **0.270119936641739849 testnet USDT** and revealed **2,398 exact bytes**, with `consumed_by_vault: true` and `output_delta_raw: 0`. This is zero additional output delta against the recorded executable quote; its quoted fees and impact still apply. Receipt-reported lifecycle fees were **0.000695370676003869 HSK**. This was a bounded testnet stable exit.

[Deployment evidence](docs/evidence/hsk-onchain-deployment.json), [resume verification](docs/evidence/hsk-testnet-resume.json), and [deployments/133.json](deployments/133.json) retain the addresses, receipts, code pins and verification scope. A separate oversized-order `eth_call` checked the deployed `TradeLimit()` rejection; it was not a mined circuit-breaker transaction.

Verify the recorded decisions without unlocking a wallet or sending a transaction:

```bash
make verify-decision ARGS='--network testnet --decision-id 1 --reveal-tx 0x614e6ff788e6c5e70aa1201b3e1dd31815bb515b0d337cfc71c0d11b781835a8'
make verify-decision ARGS='--network testnet --decision-id 2 --reveal-tx 0x2a23302898edd33571f08f5759c4f3fc20fa529f4345a622188e603dff6adf93'
```

## Attribution

Krono extends the retained AlpacaTradingAgent/TradingAgents framework. Runtime code and notices remain; separate reference checkouts are unnecessary. [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) retain the component-specific Apache-2.0, MIT and GPL notices.

[Omega AI](https://github.com/ansu555/omega-ai-app) informed the added research-brief, decision-receipt and executable-route presentation patterns.
