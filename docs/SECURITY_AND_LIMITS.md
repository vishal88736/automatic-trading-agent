# Security model and verification boundary

This is a single-operator local terminal. Its implemented execution path is simulation; no server-side private-key input, signing endpoint, unlimited allowance or arbitrary-contract-call tool is exposed. Read-only HSKChain responses do not enable live swapping.

## Enforced controls

- HttpOnly SameSite local sessions, trusted Host/origin validation, CSRF headers for state changes, and optional server-configured bearer authentication for API clients.
- Strict request/configuration schemas and hard upper/lower limits independent of model output or disabled frontend controls.
- Exact Decimal accounting and string serialization for financial values. Missing marks propagate null financial metrics and reject new execution.
- Revalidated risk, balances, token/chain identity, quote arithmetic, fee/slippage/impact ceilings, expiry/deadline and configuration versions immediately before authorization.
- Persistent unique execution intent and ledger constraints. Replayed/concurrent authorization cannot produce duplicate fills. Unresolved submitted states require reconciliation after restart.
- Latched emergency stop, separate entry pause/evaluation stop, and a HOLD_AND_REVIEW breach policy. Chat cannot raise limits, disable mandatory checks or silently grant automatic fills.
- Fixed trusted provider destinations, bounded read-only concurrency/timeouts/retries, no news scraping or automatic payment, and safe stale-cache states.
- Untrusted news/model text has no configuration, signing or broker tools. Optional upstream research receives snapshot evidence, bounded output and no reflective memory side effects. Ambient graph tracing is disabled.
- No raw chat persistence. Audit entries record typed tool actions and configuration versions; request logs omit bodies, authorization headers and credentials. Runtime/caches, reference downloads, credentials and databases are ignored by Git.

## Remaining assumptions

The local OS account, browser-wallet extension and project filesystem are trusted. The local session design is not a multi-user identity/RBAC service. Public hosting needs separately validated HTTPS, identity, origin/proxy and deployment controls; it has not been deployed or penetration-tested. Use one backend worker.

RPC metadata, contract verification, router/quote interfaces, exact transaction simulation, allowance handling, wallet signing, finality/reorg handling and live wallet accounting remain incomplete. Wallet account requests and native-balance lookups are read-only; they do not prove ownership. Documented token addresses without verified decimals remain blocked. Unknown transaction status is never treated as success.

LLM provider execution and the full optional legacy broker/UI dependency set were not validated with live credentials. Existing source is preserved, not certified as production-safe by a checksum comparison. The new terminal's execution permissions are separate from the original Dash/CLI workflow.

Provider data can be incomplete, delayed or inaccurate. Domain-count news corroboration is a heuristic and cannot prove editorial independence. Lexicon sentiment and explanatory templates are not verified predictions. CEX reference prices, synthetic liquidity and backtest assumptions do not prove executable DEX opportunities.

`scripts/public_audit.py` checks candidate publication paths and a bounded set of credential patterns without printing matches. Passing that scan, builds, tests or CI is not a comprehensive security audit or proof of investment performance.
