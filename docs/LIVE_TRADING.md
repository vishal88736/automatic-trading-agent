# Live trading design

Status: **not implemented**. The Live Trading page explains the flow, and its Connect buttons are disabled. This document is the recommended design for linking a user's exchange account so their agents can trade real funds.

## Principles

1. **Non-custodial.** Funds stay on the user's exchange account. Krono gets permission to place and cancel orders, never to withdraw.
2. **Same agent, same rules.** A live agent runs the exact strategy version, risk limits and worker code that ran on paper. Only the execution adapter changes.
3. **Earn your way to live.** An agent is promoted to live only after it has run on paper (for example 7+ days, within its drawdown and loss limits, with closed trades).

## Linking an account

Offer two methods, chosen per exchange:

| Method  | When                                                                                 | How it works                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth   | The exchange offers OAuth to third-party apps (Coinbase; others via broker programs) | User clicks **Connect**, signs in on the exchange and approves trade scopes. Krono stores the refresh token. No key copy-paste, and the user can revoke it from the exchange.                      |
| API key | Everything else (Binance, Kraken, Bybit, OKX)                                        | User creates a key with **trade only** permission, **withdrawals disabled** and an **IP allow-list** containing Krono's static egress IP, then pastes the key and secret (plus passphrase on OKX). |

When a key is linked, Krono checks it before saving:

- It authenticates and reads balances.
- It reads the key's permissions from the exchange (for example Binance `GET /sapi/v1/account/apiRestrictions`) and **rejects any key that can withdraw**.
- It records the permission snapshot and re-checks it periodically. If the permissions change, the connection is paused.

Use [CCXT](https://github.com/ccxt/ccxt) in the Python worker to get one interface for balances, markets, orders and fills across exchanges. Begin with one exchange and its testnet: Binance Spot Testnet, Bybit Testnet and Coinbase Sandbox all exist.

## Storing credentials

- **Envelope encryption.** Generate a data key per connection with AWS KMS (the infra stack already provisions a KMS key) and encrypt the secret with AES-GCM. Store only the ciphertext and the encrypted data key in PostgreSQL.
- Decrypt only inside the worker, at order time, and keep secrets out of logs, the gateway and the browser. The UI shows the exchange, a label and the last 4 characters.
- Require the user's password (and 2FA, when added) to link, promote or delete a connection.

Suggested tables (next migration):

```sql
exchange_connections (id, owner_id, exchange, method, label, ciphertext, encrypted_data_key,
                      key_hint, permissions jsonb, status, verified_at, created_at)
paper_agents + mode ('PAPER' | 'LIVE'), connection_id, live_budget
live_orders (id, owner_id, agent_id, client_order_id UNIQUE, exchange_order_id, side, asset,
             quantity, status, filled_quantity, average_price, fee, raw jsonb, updated_at)
```

## Executing orders

- **Idempotency.** Derive the exchange `clientOrderId` from the worker's existing fill key, so a crash-and-retry can never double-submit. On restart, query open and recent orders by client ID before acting.
- **Exchange is the source of truth.** Reconcile balances, fills, partial fills and fees from the exchange, not from the simulated ledger. Respect lot size, tick size and minimum notional from the market metadata.
- **Pre-trade checks.** Apply the live budget, per-order notional cap, daily loss limit, max drawdown and trade frequency limits (the paper engine's checks) before every order.
- **Kill switch.** One action cancels all open orders and pauses every live agent for that user. An automatic trip fires on repeated API errors, an unexpected balance drop, or permission changes.

## Rollout

1. Build the CCXT adapter and run it against one exchange's testnet end to end.
2. Add connection linking with permission checks and encrypted storage.
3. Add the promotion gate and live budget, then an invite-only beta with small budgets.
4. Get legal advice before launch. Placing automated orders on users' accounts can be regulated depending on where you and your users are.
