# Live trading

## Status

| Piece                                                                        | State                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| Link Binance, Bybit or OKX (testnet/demo or live) with key permission checks | **Built**: `backend/product/exchanges.py`, `live.py` |
| Reject live keys that can withdraw; record IP restriction                    | **Built**                                            |
| Encrypted key storage (AES-256-GCM, bound to owner and connection)           | **Built**: `backend/product/credentials.py`          |
| Live balances valued with streaming Binance prices                           | **Built**                                            |
| Manual market orders sized in USDT, idempotent, reconciled after timeouts    | **Built**                                            |
| Per-connection max order size, kill switch (pause + cancel), disconnect      | **Built**                                            |
| Promote a paper agent to live; each paper fill mirrored, scaled to a budget  | **Built**: `mirror_fills` in the agents worker       |
| View-only browser wallet (MetaMask and other EIP-1193 wallets)               | **Built**: `frontend/src/platform/WalletView.tsx`    |
| Kraken (no spot testnet) and Coinbase (OAuth app registration required)      | Not built                                            |
| KMS-wrapped data keys instead of one server key                              | Not built                                            |

The Bybit and OKX adapters are tested against mocked APIs that follow their published v5 specifications. Run a testnet/demo order before using them with real funds.

### Promoting an agent

Open **My Agents**, pick a running agent that passed its validation replay, choose an exchange account and a live budget, and click **Go live**.

- The agent keeps trading on paper unchanged. The agents worker copies every new paper fill to the exchange through an outbox: paper fills with no `live_orders` row. Each fill is mirrored exactly once, even across crashes or several workers.
- **Buys** are scaled: paper notional × live budget ÷ paper capital, capped by the connection's max order size. Orders below 5 USDT are recorded as `SKIPPED`.
- **Sells** sell the same share of the live position as the paper sale did of the paper position. The position is net of fees charged in the coin.
- While a connection's kill switch is on, mirrored fills are recorded as `SKIPPED`.
- Real-funds connections require `KRONO_LIVE_PROMOTION_DAYS` (default 7) days of paper history and an explicit confirmation. Testnet connections can be used immediately.
- **Stop live trading** can also sell the agent's live position.

### Try it with free test funds

1. Run `make dev` (it generates `KRONO_CREDENTIAL_KEY` into `.runtime/dev.json`).
2. Open [testnet.binance.vision](https://testnet.binance.vision/), log in with GitHub and click **Generate HMAC_SHA256 Key**.
3. In Krono, open **Live Trading**, keep **Testnet** selected, paste the key and secret, and click **Verify and link**.
4. Place a small market order. It fills on the Binance testnet and appears in Order history.

### API

| Route                                             | Purpose                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET/POST /platform/live/connections`             | List connections, or verify and link a key                                                            |
| `DELETE /platform/live/connections/{id}`          | Disconnect and erase the stored key                                                                   |
| `GET /platform/live/connections/{id}/account`     | Balances and their USDT value                                                                         |
| `GET/POST /platform/live/connections/{id}/orders` | Order history, or a market order (`request_key`, `asset`, `side`, `quote_amount`, `acknowledge_live`) |
| `POST /platform/live/connections/{id}/control`    | `pause` (kill switch: block orders, cancel open orders) or `resume`                                   |

Each order's `request_key` becomes the Binance `newClientOrderId` (`kr-<uuid hex>`). A repeated request returns the stored order. If Binance times out, Krono queries the order by client ID before reporting a result, so an order is never sent twice.
