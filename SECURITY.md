# Security

Krono is under active development. Paper trading uses virtual funds. Live trading places orders on a user's own Binance account through a trade-only key (see [live trading](docs/LIVE_TRADING.md)).

## Trust boundaries

- **Browser → gateway.** Every `/platform/*` request is checked for an allowed origin and blocked if cross-site. Requests are rate limited per IP, with separate budgets for reads (600/min) and actions (120/min), so polling can't block a Stop or kill-switch request. Mutations require a double-submit CSRF token matching an HttpOnly, `SameSite=Strict` cookie.
- **Sign-in.** In `local` mode, passwords are stored as salted scrypt digests in PostgreSQL. Unknown emails cost the same scrypt work as wrong passwords. Sessions are HMAC-SHA256 signed and expire after 7 days. Production local mode requires an explicit `KRONO_SESSION_SECRET`. In `cognito` mode, access tokens are verified against the user pool's JWKS.
- **Gateway → product API.** Each forwarded request is signed with `KRONO_PRODUCT_API_KEY` over the expiry (20 s), subject, method, raw path and body digest. The product API rejects unsigned, expired or altered requests. Account routes under `/platform/internal/` accept only the gateway's service subject.
- **Tenant isolation.** Every query is scoped by the verified subject. The leaderboard is the only cross-tenant read: it returns display names or anonymous handles and never another user's agent ID.
- **Models.** Strategy chat output is untrusted data. The gateway validates every draft against the product schema, and a draft only becomes active after the user saves it and the worker's replay and risk validation pass. Models have no tools that place orders.
- **Public price routes.** `/platform/public/prices` and its stream serve Binance reference prices for BTC, ETH and SOL only, with no account data.
- **Exchange keys.** Linked API secrets are sealed with AES-256-GCM under `KRONO_CREDENTIAL_KEY`, with the owner and connection IDs as authenticated data. They are decrypted only inside the product API at the moment of a Binance call and are never returned to the browser or logged. Live keys with withdrawal permission are rejected. Disconnecting erases the ciphertext. Exchange error messages are scrubbed of key-shaped strings. Back up `KRONO_CREDENTIAL_KEY`: without it, users must re-link their keys.

## Secrets

Keep `.env`, `.runtime/` (including `.runtime/dev.json`), `deploy/*/.env` and any exchange or model credentials out of Git, chat and logs. Gateway logs redact authorization headers, cookies and request bodies. `scripts/public_audit.py` checks tracked files for common credential patterns; it is not a complete secret detector.

## Reporting

Report vulnerabilities privately to the maintainers without including working credentials.
