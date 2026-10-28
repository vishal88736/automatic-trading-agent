# Integration evidence and boundaries

Research started 2026-10-28. The later opt-in probe at `2026-10-28T18:39:48Z` corresponds to 2026-10-29 IST. It used public read-only HTTP/RPC, no signing credentials and no transaction submission. The timestamped [provider evidence](evidence/provider-verification.json) is a historical observation, not a promise of future availability.

## Cryptocurrency news

Primary references: [hosted OpenAPI](https://cryptocurrency.cv/api/openapi.json), [developer portal](https://cryptocurrency.cv/developers), and [service repository](https://github.com/nirholas/cryptocurrency.cv).

The current specification and observed hosted responses were inspected. The adapter consumes `/api/news` and `/api/breaking`; both returned JSON `articles` arrays in the probe. Observed article fields include `title`, `link`, `description`, `pubDate`, `source`, `category` and, for some records, `contentType`. Required semantic fields are checked rather than inferred from an open-ended OpenAPI object.

The probe normalized three latest-feed items and ten breaking-feed items with publication times. The feed can contain market snapshots such as gas information; those are not treated as actionable original news. These counts are specific to that response and are not hardcoded into the application.

Older documentation and the current specification differ. The inspected specification advertises `sort` and `sources` on `/api/news`, `lang` on `/api/breaking`, and `semantic` on `/api/search`. Some routes advertise authentication or payment responses even when the observed unauthenticated call succeeds. The implementation does not assume undocumented query fields, purchase access or follow payment challenges.

Category, asset and headline filters operate on the normalized loaded feed. Optional provider prices, sentiment, fear/greed, AI summaries, narratives and historical search are not depended on without response-semantic validation. Search here is not advertised as historical search. There is no website scraping or local deployment of the news service.

Deduplication uses canonical URL and normalized title. Publication time stays nullable; first availability is retained across refreshes. Missing/future publication dates cannot authorize news-derived signals. Sentiment uses bounded, validated word lists; mixed polarity is uncertain. `/api/settings/news-scoring` exposes versioned configuration. Relevance is a transparent supported-asset mention heuristic, not a verified causal relationship. Articles and metadata are untrusted inputs.

## Market reference data

Primary reference: [Coinbase Exchange candle API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles) and the corresponding public product ticker endpoint.

`/products/{BTC|ETH|SOL}-USD/candles?granularity=3600` supplies hourly reference candles. The adapter validates six-value OHLCV rows, sorts/deduplicates them, excludes unclosed bars and retains at most 300 closed candles. `/ticker` supplies a separately timestamped reference price. The probe returned 300 closed BTC candles and a fresh ticker. This is CEX context, not HSKSwap liquidity or an executable DEX quote.

The price-change display compares the ticker with an hourly prior baseline; its effective span can differ from exactly 24 hours by the ticker/candle offset. Source and observation times remain visible. Strategy evidence requires consecutive history and rejects stale data. Volume is base-asset candle volume; no DEX liquidity is inferred from it.

## HSKChain / HSKSwap

Primary references:

- [HSKSwap application](https://app.hskswap.com/?lng=en-US)
- [official current network information](https://docs.hskchain.net/docs/Build-on-HashKey-Chain/network-info)
- [official token registry](https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Token-Contracts)
- [official fee information](https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Fee)

The current network document identifies mainnet chain **177**, native token HSK, RPC `https://mainnet.hsk.xyz` and the HashKey Blockscout explorer. The opt-in probe independently returned chain 177 and block 29,432,828. These observations establish a read-only network boundary, not swap readiness.

The application HTML and entry bundle were accessible. Referenced deeper bundles returned HTTP 403 in this environment. The current official contract-address page inspected during research lists system contracts; it did not establish a fully verified executable HSKSwap route/ABI for this implementation. Addresses found in unrelated projects or unverified SDK examples were not copied into a signing path.

Officially documented token addresses are stored separately from symbols. Decimals remain null and verification false until RPC metadata validation is implemented. Bridged WBTC/WETH are not silently substituted for the terminal's BTC/ETH reference identifiers.

Implemented read-only methods: allowlisted chain/block lookup, native HSK balance, and transaction receipt status with distinct pending/unknown, reverted and confirmed states. A confirmed receipt does not imply balance reconciliation. Wallet connection uses an injected EIP-1193 provider for an explicit account request and checks the chain. A balance lookup does not authenticate ownership. No private key is exported and no signing/approval method is exposed by the terminal.

Live execution remains unavailable pending all of:

1. On-chain token decimals and metadata validation against the official registry.
2. Independently verified router contract, ABI and a current compatible executable quote interface.
3. Binding quote amounts/route/minimum output to allowlisted calldata, recipient and deadline.
4. Minimum-allowance approval handling, L1 plus L2 fee validation, simulation of the exact transaction and final wallet authorization.
5. Receipt, finality/reorg and wallet-balance/position reconciliation tests.

`HSKSwapAdapter.quote()` and `.submit()` fail closed. No fabricated SDK methods, router addresses, token decimals or quote endpoints are supplied. `TERMINAL_MODE=LIVE` cannot bypass this boundary.

## Alpaca and optional model research

The preserved `tradingagents/dataflows/alpaca_utils.py` and Dash/CLI retain the original broker workflow. The terminal's paper-account adapter checks paper configuration and is never an HSKSwap execution fallback. Full brokerage/provider integrations need their original dependencies and credentials and remain unverified here.

Optional research uses the original provider factory and schema. Install provider dependencies in a reviewed environment, set `RESEARCH_ENABLED=true`, `LLM_PROVIDER` and `RESEARCH_MODEL`, and supply the provider's server-side credentials. Never put them into the client bundle. Model calls can consume provider credits. The local verification used a deterministic fixture model to exercise the actual researcher nodes; it did not validate an external LLM, embeddings, reflective learning or investment performance.
