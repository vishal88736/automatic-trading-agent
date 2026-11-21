# Strategy registry and assumptions

All terminal strategies produce typed BUY/HOLD/SELL signals; they cannot submit orders. Confidence is a transparent rule-agreement heuristic, not a calibrated probability of profit. Parameters are Pydantic-validated and saved with versions/audit events. Disabled strategies cannot produce executable candidates.

## KRONO 2.0 built-in registry

The active registry has exactly five initial entries. `backend/strategy_registry.py` provides the common validation/evaluation/configuration contract over the retained numerical implementation. All evaluation outputs include measured evidence, public rationale, direction, invalid conditions and exit policy; risk/reward stays unavailable when there is no defensible target estimate.

| ID                   | Entry and exit logic                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `momentum_v1`        | Configurable EMA, RSI, MACD and volume agreement; owned-position invalidation and ATR stop.                                                                                            |
| `mean_reversion_v1`  | Bollinger displacement and RSI in a constrained range; mean recovery or standing invalidation.                                                                                         |
| `trend_following_v1` | Persistent slow EMA slope, SMA50/EMA alignment, positive MACD and participation; slow EMA/slope reversal or ATR stop.                                                                  |
| `breakout_v1`        | Prior-only Donchian channel plus configurable ATR buffer and volume confirmation; channel-midpoint invalidation or ATR stop. The latest candle is excluded from the reference channel. |
| `spread_research_v1` | Arbitrage detection boundary; ineligible while compatible fresh routes, net fees/gas/slippage and settlement proof are unavailable.                                                    |

`backend/selection.py` recalculates continuous feature and signal scores for all enabled strategies, assesses costs, optionally incorporates sufficiently sampled source/asset-matched chronological holdout results, and accepts only bounded eligible model advice. Missing performance is null, not an invented win rate. Configurable weights, minimum hold, switching cooldown and a score-improvement margin reduce churn. Selection never closes a position merely because its entry strategy lost rank. News is supporting intelligence; one unverified headline cannot replace deterministic strategy and risk checks.

## Original terminal signals (compatibility reference)

The following describes the earlier signal implementation. Its `news_aware_v1` evaluator remains available to direct compatibility/backtest callers; it is not a sixth built-in strategy in KRONO 2.0.

| Strategy             | Entry evidence                                                                                                                                          | Exit / invalidation                                                                                        | Unavailable conditions                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `momentum_v1`        | Fast EMA above slow EMA; MACD above its signal; RSI between 45 and the entry ceiling; current volume above its configured trailing ratio                | Owned-strategy EMA/RSI invalidation or breached ATR policy; final action still requires risk/authorization | Fewer than 80 consecutive closed hourly bars, invalid ATR/volume, stale source, disabled asset/strategy                                  |
| `mean_reversion_v1`  | Price below the lower Bollinger band, low RSI, limited distance from SMA50 and non-turbulent volatility                                                 | Reclaim rolling mean or ATR invalidation for owned inventory                                               | Strong trend/volatility filter, insufficient history, unavailable data                                                                   |
| `news_aware_v1`      | At least two independent source domains with relevant, recent, available bullish items, no opposing bearish source, plus the full momentum confirmation | Corroborated bearish evidence with market invalidation, or owned-position stop policy                      | Missing/future publication or availability, stale/cross-clock stories, fewer sources, single unverified headline, no market confirmation |
| `spread_research_v1` | None until two compatible fresh executable routes and complete net costs exist                                                                          | Research only                                                                                              | Currently disabled: executable routes and settlement/cost proof are unavailable                                                          |

Indicator values use the actual validated candle history. Wilder ATR and deterministic regime classification are reused from upstream. RSI uses explicitly seeded exponential smoothing; Bollinger bands use a 20-bar population standard deviation. MACD uses 12/26/9. The strategy's configurable fast/slow EMA pair is separate from MACD. Volume confirmation excludes the latest bar from the trailing baseline.

Hourly crypto volatility uses √8760. The wrapper adjusts the upstream equity-oriented absolute volatility threshold rather than presenting √252 output as crypto-hourly annualization. This is a descriptive volatility estimate, not a forecast.

The consolidated trader requires a supported deterministic direction. Conflicting directions produce HOLD. A configured model can veto that consensus but cannot create an otherwise unsupported action, change notional or override risk. The final proposal includes source times, evidence references, strategy/configuration versions, exit policy and expiry.

## Costs and evaluation

Simulation assumes a 10 bps trading fee, 10 bps slippage and size divided by $1m assumed liquidity as impact, with no network transaction. These are labeled assumptions, not measured HSKSwap conditions. Fresh quote validation enforces independent fee, impact, slippage and minimum-output limits.

Backtests freeze configuration, use past-only warm-up and chronological holdout portfolios, and fill a prior closed-bar signal at the next open. They reject an opening entry already below its stop, account for stops within an entry bar, and include fees/slippage in cash and realized/unrealized accounting. An OHLC bar cannot establish exact intrabar timestamps, so that limitation is recorded.

The fixed supported-asset universe is not a survivorship-adjusted market study. Current news feeds cannot reconstruct historical knowledge; publication **and** observed availability must precede a news signal. Annualized return is omitted for sub-year windows, Sharpe is unreported when its assumptions are unverified, and missing win-rate/profit-factor metrics stay null. No in-sample or fixture result establishes profitability.

## Earlier regime/strategy reference

The initial project brief also supplied grid trading, mean-reversion/pairs, time-series momentum, and statistical-arbitrage/funding-rate farming as strategy families. Their relevant ideas and risks are retained here rather than presented as completed integrations:

| Family                                  | Appropriate research context                                      | Boundary in this terminal                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grid trading                            | Sideways markets; repeated inventory exchange                     | Deferred until verified limit-order/cancellation support and breakout/inventory policies exist. A one-way breakout can accumulate losses.                                                 |
| Pairs trading                           | Mean-reverting relative prices with reliable comparable histories | Correlation display is implemented; cointegration, borrow/short semantics and paired execution are not. A structural change can prevent convergence.                                      |
| Time-series momentum                    | Sustained trends with multiple confirmations                      | Implemented as the focused spot momentum signal above. Choppy regimes can produce whipsaws and costs.                                                                                     |
| Statistical arbitrage / funding farming | Compatible venues, instruments and reliable execution/cost data   | Route research stays disabled without executable quotes, fee/gas/latency proof and settlement infrastructure. No cross-chain arbitrage, perpetual leverage or funding capture is claimed. |
