# Security

Krono is under active development. Paper trading uses virtual funds only, and live trading is not enabled (see [live trading design](docs/LIVE_TRADING.md)).

## Trust boundaries

- **Browser → gateway.** Every `/platform/*` request is checked for an allowed origin and blocked if cross-site. Requests are rate limited per IP. Mutations require a double-submit CSRF token matching an HttpOnly, `SameSite=Strict` cookie.
- **Sign-in.** In `local` mode, passwords are stored as salted scrypt digests in PostgreSQL. Unknown emails cost the same scrypt work as wrong passwords. Sessions are HMAC-SHA256 signed and expire after 7 days. Production local mode requires an explicit `KRONO_SESSION_SECRET`. In `cognito` mode, access tokens are verified against the user pool's JWKS.
- **Gateway → product API.** Each forwarded request is signed with `KRONO_PRODUCT_API_KEY` over the expiry (20 s), subject, method, raw path and body digest. The product API rejects unsigned, expired or altered requests. Account routes under `/platform/internal/` accept only the gateway's service subject.
- **Tenant isolation.** Every query is scoped by the verified subject. The leaderboard is the only cross-tenant read: it returns display names or anonymous handles and never another user's agent ID.
- **Models.** Strategy chat output is untrusted data. The gateway validates every draft against the product schema, and a draft only becomes active after the user saves it and the worker's replay and risk validation pass. Models have no tools that place orders.
- **Public market route.** `/platform/public/market/:asset` serves reference prices for BTC, ETH and SOL only, with no account data.

## Secrets

Keep `.env`, `.runtime/` (including `.runtime/dev.json`), `deploy/*/.env` and any exchange or model credentials out of Git, chat and logs. Gateway logs redact authorization headers, cookies and request bodies. `scripts/public_audit.py` checks tracked files for common credential patterns; it is not a complete secret detector.

## Reporting

Report vulnerabilities privately to the maintainers without including working credentials.
