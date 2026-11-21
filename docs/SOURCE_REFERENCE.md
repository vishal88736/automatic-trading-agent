# Generated backend source reference

Generated from the active source. Regenerate with `.venv/bin/python -m scripts.generate_code_reference`; verify with `--check`.

This tool reads source only. It does not load environment files, databases, AWS credentials, models or providers. [Development](DEVELOPMENT.md) explains the module layout; this index supplies exact code locations.

## Product HTTP routes

- `GET /healthz` → [health](../backend/product/api.py#L145)
- `GET /platform/paper-account` → [paper_account](../backend/product/api.py#L248)
- `POST /platform/paper-account` → [provision_paper_account](../backend/product/api.py#L252)
- `GET /platform/paper-portfolio` → [paper_portfolio](../backend/product/api.py#L274)
- `GET /platform/paper-orders` → [paper_order_history](../backend/product/api.py#L278)
- `POST /platform/paper-orders` → [paper_order_submit](../backend/product/api.py#L287)
- `POST /platform/paper-orders/{order_id}/cancel` → [paper_order_cancel](../backend/product/api.py#L292)
- `POST /platform/paper-orders/{order_id}/evaluate` → [paper_order_evaluate](../backend/product/api.py#L299)
- `POST /platform/paper-account/reset` → [paper_reset](../backend/product/api.py#L309)
- `PUT /platform/paper-account/emergency` → [paper_emergency](../backend/product/api.py#L313)
- `GET /platform/paper-agents` → [paper_agent_list](../backend/product/api.py#L317)
- `POST /platform/paper-agents` → [paper_agent_start](../backend/product/api.py#L321)
- `POST /platform/paper-agents/{agent_id}/control` → [paper_agent_control](../backend/product/api.py#L331)
- `POST /platform/paper-agents/{agent_id}/close-position` → [paper_agent_close](../backend/product/api.py#L342)
- `GET /platform/paper-agents/{agent_id}/events` → [paper_agent_timeline](../backend/product/api.py#L357)
- `GET /platform/paper-agents/{agent_id}/stream` → [paper_agent_stream](../backend/product/api.py#L366)
- `GET /platform/paper-market/{asset}` → [paper_market](../backend/product/api.py#L395)
- `GET /platform/paper-news` → [paper_news](../backend/product/api.py#L406)
- `GET /platform/paper-watchlist` → [paper_watchlist](../backend/product/api.py#L423)
- `PUT /platform/paper-watchlist/{asset}` → [paper_watch](../backend/product/api.py#L431)
- `GET /platform/strategy-authoring` → [strategy_authoring](../backend/product/api.py#L446)
- `POST /platform/strategy-authoring/validate` → [validate_draft](../backend/product/api.py#L450)
- `POST /platform/strategy-authoring/start-agent` → [start_agent_from_draft](../backend/product/api.py#L454)
- `GET /platform/custom-strategies` → [strategies](../backend/product/api.py#L462)
- `POST /platform/custom-strategies` → [new_strategy](../backend/product/api.py#L471)
- `GET /platform/custom-strategies/{strategy_id}` → [strategy](../backend/product/api.py#L476)
- `PUT /platform/custom-strategies/{strategy_id}` → [edit_strategy](../backend/product/api.py#L488)
- `POST /platform/custom-strategies/{strategy_id}/archive` → [remove_strategy](../backend/product/api.py#L494)
- `GET /platform/custom-strategies/{strategy_id}/versions` → [versions](../backend/product/api.py#L500)
- `POST /platform/custom-strategies/{strategy_id}/backtests` → [create_backtest](../backend/product/api.py#L514)
- `GET /platform/backtests/{run_id}` → [backtest_report](../backend/product/api.py#L531)

## Operator HTTP routes

- `GET /api/aegis/state` → [aegis_state](../backend/operator/api.py#L432)
- `GET /api/aegis/market-details` → [aegis_market_details](../backend/operator/api.py#L447)
- `GET /api/aegis/vault` → [aegis_vault](../backend/operator/api.py#L453)
- `POST /api/aegis/vault/prepare` → [aegis_owner_prepare](../backend/operator/api.py#L459)
- `POST /api/aegis/vault/receipt` → [aegis_owner_receipt](../backend/operator/api.py#L472)
- `POST /api/aegis/verify` → [aegis_verify](../backend/operator/api.py#L478)
- `POST /api/aegis/check` → [aegis_check](../backend/operator/api.py#L515)
- `PUT /api/aegis/settings` → [aegis_settings](../backend/operator/api.py#L519)
- `POST /api/aegis/settings/confirm` → [aegis_settings_confirm](../backend/operator/api.py#L526)
- `POST /api/aegis/settings/rollback` → [aegis_settings_rollback](../backend/operator/api.py#L536)
- `GET /api/selection` → [selection_config](../backend/operator/api.py#L542)
- `PUT /api/selection` → [update_selection](../backend/operator/api.py#L547)
- `POST /api/aegis/control` → [aegis_control](../backend/operator/api.py#L555)
- `GET /api/aegis/sessions` → [aegis_sessions](../backend/operator/api.py#L564)
- `GET /api/aegis/sessions/{session_id}` → [aegis_session](../backend/operator/api.py#L568)
- `POST /api/aegis/chat` → [aegis_chat](../backend/operator/api.py#L577)
- `POST /api/session` → [session](../backend/operator/api.py#L583)
- `GET /api/health` → [health](../backend/operator/api.py#L622)
- `GET /api/ready` → [ready](../backend/operator/api.py#L626)
- `GET /api/status` → [status](../backend/operator/api.py#L664)
- `GET /api/dashboard` → [dashboard](../backend/operator/api.py#L707)
- `GET /api/markets` → [markets](../backend/operator/api.py#L730)
- `GET /api/correlations` → [correlation_data](../backend/operator/api.py#L734)
- `GET /api/markets/{symbol}` → [market](../backend/operator/api.py#L739)
- `GET /api/desk/budget/{symbol}` → [desk_budget](../backend/operator/api.py#L754)
- `GET /api/alerts` → [alerts](../backend/operator/api.py#L759)
- `POST /api/alerts` → [create_alert](../backend/operator/api.py#L763)
- `DELETE /api/alerts/{alert_id}` → [delete_alert](../backend/operator/api.py#L768)
- `GET /api/news` → [news](../backend/operator/api.py#L772)
- `POST /api/news/refresh` → [refresh_news](../backend/operator/api.py#L793)
- `GET /api/news/{article_id}` → [article](../backend/operator/api.py#L797)
- `GET /api/strategies` → [strategies](../backend/operator/api.py#L818)
- `PUT /api/strategies/{strategy_id}` → [strategy_config](../backend/operator/api.py#L835)
- `POST /api/runs` → [run](../backend/operator/api.py#L842)
- `GET /api/runs/{run_id}` → [run_detail](../backend/operator/api.py#L846)
- `GET /api/runs/{run_id}/brief` → [run_brief](../backend/operator/api.py#L853)
- `GET /api/risk` → [risk](../backend/operator/api.py#L860)
- `PUT /api/risk` → [risk_config](../backend/operator/api.py#L870)
- `GET /api/portfolio` → [portfolio](../backend/operator/api.py#L877)
- `POST /api/positions/{symbol}/exit-preview` → [exit_preview](../backend/operator/api.py#L882)
- `GET /api/history/{kind}` → [history](../backend/operator/api.py#L928)
- `GET /api/trades` → [trades](../backend/operator/api.py#L937)
- `GET /api/trades/{workspace}/{trade_id}` → [trade_detail](../backend/operator/api.py#L947)
- `POST /api/execution/preview` → [preview](../backend/operator/api.py#L955)
- `POST /api/execution/authorize` → [authorize](../backend/operator/api.py#L963)
- `POST /api/execution/{intent_id}/reconcile` → [reconcile](../backend/operator/api.py#L967)
- `POST /api/agent/control` → [control](../backend/operator/api.py#L971)
- `POST /api/emergency-stop` → [emergency_stop](../backend/operator/api.py#L975)
- `POST /api/backtests` → [backtests](../backend/operator/api.py#L982)
- `PUT /api/settings/providers` → [provider_settings](../backend/operator/api.py#L986)
- `GET /api/settings/news-scoring` → [news_scoring](../backend/operator/api.py#L1002)
- `GET /api/settings/provider-refresh` → [provider_refresh](../backend/operator/api.py#L1011)
- `PUT /api/settings/provider-refresh` → [change_provider_refresh](../backend/operator/api.py#L1016)
- `PUT /api/settings/news-scoring` → [change_news_scoring](../backend/operator/api.py#L1024)
- `GET /api/wallet/{address}` → [wallet](../backend/operator/api.py#L1031)
- `POST /api/chat` → [chat](../backend/operator/api.py#L1040)
- `GET /api/{path:path}` → [unknown_api](../backend/operator/api.py#L1334)

## Gateway HTTP routes

Cognito access-token identity and tenant-aware repositories protect application resources. Authentication endpoints establish or clear sessions; `/platform/health` is public and does not attest AWS account availability.

- `GET /platform/health` → [server.ts:253](../backend/gateway/server.ts#L253)
- `GET /platform/ready` → [server.ts:265](../backend/gateway/server.ts#L265)
- `GET /platform/emergency` → [server.ts:273](../backend/gateway/server.ts#L273)
- `POST /platform/emergency-stop` → [server.ts:281](../backend/gateway/server.ts#L281)
- `POST /platform/emergency-clear` → [server.ts:284](../backend/gateway/server.ts#L284)
- `GET /platform/profile` → [server.ts:324](../backend/gateway/server.ts#L324)
- `POST /platform/profile/preview` → [server.ts:326](../backend/gateway/server.ts#L326)
- `GET /platform/agents` → [server.ts:343](../backend/gateway/server.ts#L343)
- `GET /platform/portfolio` → [server.ts:347](../backend/gateway/server.ts#L347)
- `POST /platform/agents` → [server.ts:348](../backend/gateway/server.ts#L348)
- `GET /platform/agent-templates` → [server.ts:349](../backend/gateway/server.ts#L349)
- `POST /platform/agent-templates/:id/instantiate` → [server.ts:352](../backend/gateway/server.ts#L352)
- `GET /platform/agents/:id` → [server.ts:360](../backend/gateway/server.ts#L360)
- `GET /platform/agents/:id/preview` → [server.ts:363](../backend/gateway/server.ts#L363)
- `POST /platform/agents/:id/deploy` → [server.ts:366](../backend/gateway/server.ts#L366)
- `POST /platform/agents/:id/configuration/preview` → [server.ts:369](../backend/gateway/server.ts#L369)
- `POST /platform/agents/:id/rollback/preview` → [server.ts:391](../backend/gateway/server.ts#L391)
- `POST /platform/agents/:id/control` → [server.ts:413](../backend/gateway/server.ts#L413)
- `GET /platform/agents/:id/events` → [server.ts:437](../backend/gateway/server.ts#L437)
- `GET /platform/agents/:id/logs` → [server.ts:442](../backend/gateway/server.ts#L442)
- `GET /platform/agents/:id/metrics` → [server.ts:447](../backend/gateway/server.ts#L447)
- `GET /platform/agents/:id/versions` → [server.ts:456](../backend/gateway/server.ts#L456)
- `POST /platform/conversations` → [server.ts:462](../backend/gateway/server.ts#L462)
- `GET /platform/conversations` → [server.ts:465](../backend/gateway/server.ts#L465)
- `GET /platform/conversations/:id/messages` → [server.ts:469](../backend/gateway/server.ts#L469)
- `POST /platform/conversations/:id/messages` → [server.ts:475](../backend/gateway/server.ts#L475)
- `GET /platform/conversations/:id/requests/:requestId` → [server.ts:484](../backend/gateway/server.ts#L484)
- `POST /platform/actions/:id/approve` → [server.ts:494](../backend/gateway/server.ts#L494)
- `GET /platform/history/:kind` → [server.ts:504](../backend/gateway/server.ts#L504)
- `GET /platform/strategies` → [server.ts:519](../backend/gateway/server.ts#L519)
- `POST /platform/auth/register` → [cognito.ts:112](../backend/gateway/auth/cognito.ts#L112)
- `POST /platform/auth/verify` → [cognito.ts:133](../backend/gateway/auth/cognito.ts#L133)
- `POST /platform/auth/login` → [cognito.ts:144](../backend/gateway/auth/cognito.ts#L144)
- `POST /platform/auth/refresh` → [cognito.ts:158](../backend/gateway/auth/cognito.ts#L158)
- `POST /platform/auth/forgot` → [cognito.ts:171](../backend/gateway/auth/cognito.ts#L171)
- `POST /platform/auth/reset` → [cognito.ts:183](../backend/gateway/auth/cognito.ts#L183)
- `POST /platform/auth/logout` → [cognito.ts:195](../backend/gateway/auth/cognito.ts#L195)
- `GET /platform/auth/session` → [cognito.ts:219](../backend/gateway/auth/cognito.ts#L219)
- `POST /platform/market-insights/:asset` → [routes.ts:98](../backend/gateway/product/routes.ts#L98)
- `POST /platform/strategy-authoring/generate` → [routes.ts:171](../backend/gateway/product/routes.ts#L171)
- `GET /platform/paper-agents/:id/stream` → [routes.ts:260](../backend/gateway/product/routes.ts#L260)

## Python classes and functions

### backend/backtesting.py

- [backtest](../backend/backtesting.py#L20) — `backtest(market: Market, news: NewsFeed, request: BacktestRequest, strategy_config, risk: RiskConfig)`
- [backtest_rules](../backend/backtesting.py#L26) — `backtest_rules(market: Market, request: BacktestAssumptions, definition: StrategyDefinition, risk: RiskConfig)`
- [_replay](../backend/backtesting.py#L34) — `_replay(market: Market, request: BacktestAssumptions, risk: RiskConfig, strategy: StrategyConfig | StrategyDefinition, strategy_id: str, news: NewsFeed | None=None)`
- [_replay.segment](../backend/backtesting.py#L56) — `segment(start, end)`
- [_replay.segment.close_position](../backend/backtesting.py#L70) — `close_position(at, raw_price, reason)`

### backend/cloud_worker.py

- [control_scalars](../backend/cloud_worker.py#L30) — `control_scalars(value)`
- [risk_adapter](../backend/cloud_worker.py#L43) — `risk_adapter(r)`
- [CloudWorker](../backend/cloud_worker.py#L60) — class
- [CloudWorker.__init__](../backend/cloud_worker.py#L61) — `__init__(self)`
- [CloudWorker.control](../backend/cloud_worker.py#L89) — `control(self)`
- [CloudWorker.event](../backend/cloud_worker.py#L96) — `event(self, name, data)`
- [CloudWorker.heartbeat](../backend/cloud_worker.py#L114) — `heartbeat(self, status, **extra)`
- [CloudWorker.lease](../backend/cloud_worker.py#L132) — `lease(self)`
- [CloudWorker.release](../backend/cloud_worker.py#L153) — `release(self)`
- [CloudWorker.checkpoint](../backend/cloud_worker.py#L163) — `checkpoint(self)`
- [CloudWorker.initialize](../backend/cloud_worker.py#L210) — `async initialize(self, spec)`
- [CloudWorker.initialize.configure](../backend/cloud_worker.py#L237) — `configure(name, value)`
- [CloudWorker.recover_manifests](../backend/cloud_worker.py#L266) — `recover_manifests(self, store)`
- [CloudWorker.renew_loop](../backend/cloud_worker.py#L291) — `async renew_loop(self)`
- [CloudWorker.execution_permitted](../backend/cloud_worker.py#L302) — `execution_permitted(self)`
- [CloudWorker.request_analysis](../backend/cloud_worker.py#L319) — `request_analysis(self, packet)`
- [CloudWorker.reviewed](../backend/cloud_worker.py#L342) — `reviewed(self, spec, asset)`
- [CloudWorker.reserve_execution](../backend/cloud_worker.py#L356) — `reserve_execution(self, intent, spec, asset)`
- [CloudWorker.run_once](../backend/cloud_worker.py#L420) — `async run_once(self, spec, *, request_review=True, assets=None)`
- [CloudWorker.run](../backend/cloud_worker.py#L630) — `async run(self)`
- [main](../backend/cloud_worker.py#L732) — `main()`

### backend/data.py

- [fixture_market](../backend/data.py#L28) — `fixture_market(symbol: str, count=238)`
- [parse_coinbase_candles](../backend/data.py#L79) — `parse_coinbase_candles(rows, closed_by: datetime)`
- [canonical_url](../backend/data.py#L103) — `canonical_url(raw: str)`
- [text_content](../backend/data.py#L130) — `text_content(raw, limit=1500)`
- [parse_time](../backend/data.py#L134) — `parse_time(raw)`
- [normalize_news](../backend/data.py#L142) — `normalize_news(payload: dict, retrieved: datetime, breaking=False, scoring: NewsScoring | None=None)`
- [fixture_news](../backend/data.py#L252) — `fixture_news()`
- [Providers](../backend/data.py#L308) — class
- [Providers.__init__](../backend/data.py#L309) — `__init__(self, store: Store, market_provider='fixture', news_provider='fixture', transport=None, news_key='', refresh: ProviderRefresh | None=None)`
- [Providers.close](../backend/data.py#L340) — `async close(self)`
- [Providers.request](../backend/data.py#L343) — `async request(self, url, **kwargs)`
- [Providers._candles](../backend/data.py#L357) — `async _candles(self, symbol: str, refresh: bool)`
- [Providers._cached_market](../backend/data.py#L374) — `_cached_market(self, cached, *, failed: bool=False)`
- [Providers.market](../backend/data.py#L388) — `async market(self, symbol: str, refresh=False)`
- [Providers.news](../backend/data.py#L452) — `async news(self, breaking=False, refresh=False)`

### backend/desk.py

- [AlertRequest](../backend/desk.py#L12) — class
- [PriceAlert](../backend/desk.py#L18) — class
- [PriceAlerts](../backend/desk.py#L30) — class
- [PriceAlerts.__init__](../backend/desk.py#L38) — `__init__(self, store: Store)`
- [PriceAlerts._load](../backend/desk.py#L42) — `_load(self)`
- [PriceAlerts.view](../backend/desk.py#L46) — `view(self)`
- [PriceAlerts._save](../backend/desk.py#L51) — `_save(self, rows, version)`
- [PriceAlerts._valid](../backend/desk.py#L57) — `_valid(self, market: Market | None)`
- [PriceAlerts.create](../backend/desk.py#L68) — `create(self, request: AlertRequest, markets: dict[str, Market])`
- [PriceAlerts.delete](../backend/desk.py#L83) — `delete(self, identifier: str)`
- [PriceAlerts.evaluate](../backend/desk.py#L93) — `evaluate(self, markets: dict[str, Market])`
- [sizing_preview](../backend/desk.py#L139) — `sizing_preview(portfolio, config: RiskConfig, symbol: str)`

### backend/engine.py

- [WorkflowState](../backend/engine.py#L50) — class
- [Engine](../backend/engine.py#L54) — class
- [Engine.__init__](../backend/engine.py#L55) — `__init__(self, store: Store, providers: Providers, research=None)`
- [Engine.strategies](../backend/engine.py#L80) — `strategies(self)`
- [Engine.refresh_markets](../backend/engine.py#L108) — `async refresh_markets(self)`
- [Engine._persist](../backend/engine.py#L122) — `_persist(self, run)`
- [Engine._node](../backend/engine.py#L125) — `_node(self, name)`
- [Engine._node.node](../backend/engine.py#L126) — `async node(state)`
- [Engine._stage](../backend/engine.py#L151) — `async _stage(self, name, ctx)`
- [Engine.run](../backend/engine.py#L408) — `async run(self, request: RunRequest, *, external_evidence=None)`
- [Engine.authorize](../backend/engine.py#L456) — `async authorize(self, request: Authorize)`
- [Engine.state](../backend/engine.py#L478) — `state(self)`
- [Engine.control](../backend/engine.py#L482) — `control(self, request: SchedulerAction)`
- [Engine.scheduler_loop](../backend/engine.py#L541) — `async scheduler_loop(self)`
- [Engine.recover](../backend/engine.py#L594) — `recover(self)`
- [Engine.close](../backend/engine.py#L616) — `async close(self)`

### backend/exchanges.py

- [IntegrationUnavailable](../backend/exchanges.py#L18) — class
- [QuoteProvider](../backend/exchanges.py#L22) — class
- [QuoteProvider.quote](../backend/exchanges.py#L23) — `async quote(self, proposal: Proposal, notional: Decimal)`
- [SwapExecutor](../backend/exchanges.py#L26) — class
- [SwapExecutor.submit](../backend/exchanges.py#L27) — `async submit(self, intent_id: str, quote: Quote)`
- [TransactionStatusProvider](../backend/exchanges.py#L30) — class
- [TransactionStatusProvider.transaction_status](../backend/exchanges.py#L31) — `async transaction_status(self, tx_hash: str)`
- [ExchangeAdapter](../backend/exchanges.py#L34) — class
- [SimulationAdapter](../backend/exchanges.py#L38) — class
- [SimulationAdapter.__init__](../backend/exchanges.py#L41) — `__init__(self, settings: SimulationSettings | None=None)`
- [SimulationAdapter.estimate_costs](../backend/exchanges.py#L44) — `estimate_costs(self, notional: Decimal, side: str)`
- [SimulationAdapter.quote](../backend/exchanges.py#L52) — `async quote(self, proposal: Proposal, notional: Decimal)`
- [SimulationAdapter.transaction_status](../backend/exchanges.py#L104) — `async transaction_status(self, tx_hash: str)`
- [HSKSwapAdapter](../backend/exchanges.py#L111) — class
- [HSKSwapAdapter.__init__](../backend/exchanges.py#L120) — `__init__(self, transport=None, settings: NetworkSettings | None=None)`
- [HSKSwapAdapter.close](../backend/exchanges.py#L136) — `async close(self)`
- [HSKSwapAdapter.configuration](../backend/exchanges.py#L139) — `configuration(self)`
- [HSKSwapAdapter.rpc](../backend/exchanges.py#L165) — `async rpc(self, method, params)`
- [HSKSwapAdapter.wallet](../backend/exchanges.py#L187) — `async wallet(self, address: str)`
- [HSKSwapAdapter.quote](../backend/exchanges.py#L213) — `async quote(self, proposal: Proposal, notional: Decimal)`
- [HSKSwapAdapter.submit](../backend/exchanges.py#L216) — `async submit(self, intent_id: str, quote: Quote)`
- [HSKSwapAdapter.transaction_status](../backend/exchanges.py#L221) — `async transaction_status(self, tx_hash: str)`
- [AlpacaPaperAdapter](../backend/exchanges.py#L242) — class
- [AlpacaPaperAdapter.account](../backend/exchanges.py#L245) — `account(self)`
- [AlpacaPaperAdapter.quote](../backend/exchanges.py#L256) — `async quote(self, proposal, notional)`

### backend/execution.py

- [Execution](../backend/execution.py#L19) — class
- [Execution.__init__](../backend/execution.py#L20) — `__init__(self, store: Store, portfolio: Portfolio, markets: dict, adapter=None)`
- [Execution.risk](../backend/execution.py#L38) — `risk(self)`
- [Execution.stopped](../backend/execution.py#L42) — `stopped(self)`
- [Execution.decision](../backend/execution.py#L46) — `decision(self, proposal: Proposal)`
- [Execution.record_risk](../backend/execution.py#L92) — `record_risk(self, decision)`
- [Execution.preview](../backend/execution.py#L96) — `async preview(self, proposal: Proposal)`
- [Execution.validate_context](../backend/execution.py#L100) — `validate_context(self, proposal: Proposal)`
- [Execution._preview](../backend/execution.py#L125) — `async _preview(self, proposal: Proposal)`
- [Execution.authorize](../backend/execution.py#L166) — `async authorize(self, request: Authorize)`
- [Execution.recover](../backend/execution.py#L281) — `recover(self)`
- [Execution.reconcile](../backend/execution.py#L301) — `reconcile(self, intent_id)`

### backend/models.py

- [now](../backend/models.py#L15) — `now()`
- [uid](../backend/models.py#L19) — `uid()`
- [Model](../backend/models.py#L27) — class
- [Mode](../backend/models.py#L31) — class
- [Token](../backend/models.py#L37) — class
- [Token.identity](../backend/models.py#L49) — `identity(self)`
- [Candle](../backend/models.py#L65) — class
- [Candle.valid_bar](../backend/models.py#L75) — `valid_bar(self)`
- [Market](../backend/models.py#L83) — class
- [Article](../backend/models.py#L97) — class
- [NewsFeed](../backend/models.py#L121) — class
- [NewsScoring](../backend/models.py#L135) — class
- [NewsScoring.validate_terms](../backend/models.py#L169) — `validate_terms(self)`
- [VersionedNewsScoring](../backend/models.py#L177) — class
- [StrategyConfig](../backend/models.py#L182) — class
- [StrategyConfig.periods](../backend/models.py#L203) — `periods(self)`
- [Signal](../backend/models.py#L211) — class
- [ResearchEvidence](../backend/models.py#L226) — class
- [RiskConfig](../backend/models.py#L234) — class
- [Proposal](../backend/models.py#L255) — class
- [Check](../backend/models.py#L280) — class
- [RiskDecision](../backend/models.py#L288) — class
- [Quote](../backend/models.py#L300) — class
- [IntentState](../backend/models.py#L325) — class
- [Position](../backend/models.py#L339) — class
- [StageTiming](../backend/models.py#L356) — class
- [ExecutionIntent](../backend/models.py#L362) — class
- [ExecutionIntent.consistent_intent](../backend/models.py#L378) — `consistent_intent(self)`
- [RunRequest](../backend/models.py#L394) — class
- [VersionedStrategy](../backend/models.py#L399) — class
- [VersionedRisk](../backend/models.py#L404) — class
- [Authorize](../backend/models.py#L409) — class
- [SchedulerAction](../backend/models.py#L415) — class
- [ChatTurn](../backend/models.py#L427) — class
- [ChatRequest](../backend/models.py#L432) — class
- [BacktestAssumptions](../backend/models.py#L438) — class
- [BacktestRequest](../backend/models.py#L449) — class

### backend/operator/aegis_bridge.py

- [strategy_catalog](../backend/operator/aegis_bridge.py#L18) — `strategy_catalog(store)`
- [collect_library](../backend/operator/aegis_bridge.py#L39) — `async collect_library(engine, state: dict)`

### backend/operator/analytics.py

- [ChartPoint](../backend/operator/analytics.py#L11) — class
- [ChartIndicators](../backend/operator/analytics.py#L21) — class
- [chart_indicators](../backend/operator/analytics.py#L30) — `chart_indicators(market: Market)`
- [aggregate](../backend/operator/analytics.py#L78) — `aggregate(market: Market, timeframe: str)`
- [correlations](../backend/operator/analytics.py#L117) — `correlations(markets: dict[str, Market])`

### backend/operator/api.py

- [PreviewRequest](../backend/operator/api.py#L72) — class
- [ProviderSettings](../backend/operator/api.py#L76) — class
- [RefreshSettings](../backend/operator/api.py#L82) — class
- [AegisControl](../backend/operator/api.py#L87) — class
- [AegisSettings](../backend/operator/api.py#L101) — class
- [AegisSettingsConfirm](../backend/operator/api.py#L106) — class
- [AegisRollback](../backend/operator/api.py#L113) — class
- [VersionedSelection](../backend/operator/api.py#L118) — class
- [diff](../backend/operator/api.py#L123) — `diff(before: dict, after: dict)`
- [OwnerRequest](../backend/operator/api.py#L129) — class
- [OwnerReceipt](../backend/operator/api.py#L137) — class
- [DecisionProof](../backend/operator/api.py#L143) — class
- [create_app](../backend/operator/api.py#L149) — `create_app(db_path=None, *, testing=False, transport=None, api_token=None, aegis_factory=None, testnet_factory=None)`
- [create_app.lifespan](../backend/operator/api.py#L178) — `async lifespan(app)`
- [create_app.lifespan.reference_source](../backend/operator/api.py#L231) — `async reference_source(state)`
- [create_app.lifespan.terminal_tool](../backend/operator/api.py#L234) — `async terminal_tool(name: str, args: dict)`
- [create_app.error](../backend/operator/api.py#L293) — `error(request, code, message, status=400, details=None)`
- [create_app.origin_allowed](../backend/operator/api.py#L306) — `origin_allowed(request)`
- [create_app.authorize_api](../backend/operator/api.py#L314) — `async authorize_api(request: Request)`
- [create_app.boundary](../backend/operator/api.py#L330) — `async boundary(request: Request, call_next)`
- [create_app.chain_data_error](../backend/operator/api.py#L407) — `async chain_data_error(request, exc)`
- [create_app.value_error](../backend/operator/api.py#L412) — `async value_error(request, exc)`
- [create_app.validation_error](../backend/operator/api.py#L416) — `async validation_error(request, exc)`
- [create_app.engine](../backend/operator/api.py#L428) — `engine(request: Request)`
- [create_app.aegis_state](../backend/operator/api.py#L432) — `async aegis_state(request: Request)`
- [create_app.aegis_market_details](../backend/operator/api.py#L447) — `async aegis_market_details(request: Request, asset: Literal['WHSK', 'WETH', 'WBTC']='WHSK')`
- [create_app.aegis_vault](../backend/operator/api.py#L453) — `async aegis_vault(network: Literal['testnet', 'mainnet']='testnet')`
- [create_app.aegis_owner_prepare](../backend/operator/api.py#L459) — `async aegis_owner_prepare(body: OwnerRequest)`
- [create_app.aegis_owner_receipt](../backend/operator/api.py#L472) — `async aegis_owner_receipt(body: OwnerReceipt)`
- [create_app.aegis_verify](../backend/operator/api.py#L478) — `async aegis_verify(body: DecisionProof, request: Request)`
- [create_app.aegis_verify.verify](../backend/operator/api.py#L483) — `verify()`
- [create_app.aegis_check](../backend/operator/api.py#L515) — `async aegis_check(request: Request)`
- [create_app.aegis_settings](../backend/operator/api.py#L519) — `async aegis_settings(body: AegisSettings, request: Request)`
- [create_app.aegis_settings_confirm](../backend/operator/api.py#L526) — `async aegis_settings_confirm(body: AegisSettingsConfirm, request: Request)`
- [create_app.aegis_settings_rollback](../backend/operator/api.py#L536) — `async aegis_settings_rollback(body: AegisRollback, request: Request)`
- [create_app.selection_config](../backend/operator/api.py#L542) — `async selection_config(e: Engine=Depends(engine))`
- [create_app.update_selection](../backend/operator/api.py#L547) — `async update_selection(body: VersionedSelection, e: Engine=Depends(engine))`
- [create_app.aegis_control](../backend/operator/api.py#L555) — `async aegis_control(body: AegisControl, request: Request)`
- [create_app.aegis_sessions](../backend/operator/api.py#L564) — `async aegis_sessions(request: Request)`
- [create_app.aegis_session](../backend/operator/api.py#L568) — `async aegis_session(session_id: str, request: Request)`
- [create_app.aegis_chat](../backend/operator/api.py#L577) — `async aegis_chat(body: ChatRequest, request: Request)`
- [create_app.session](../backend/operator/api.py#L583) — `async session(request: Request)`
- [create_app.health](../backend/operator/api.py#L622) — `async health()`
- [create_app.ready](../backend/operator/api.py#L626) — `async ready(e: Engine=Depends(engine))`
- [create_app.market_summary](../backend/operator/api.py#L635) — `market_summary(market)`
- [create_app.status](../backend/operator/api.py#L664) — `async status(request: Request, e: Engine=Depends(engine))`
- [create_app.dashboard](../backend/operator/api.py#L707) — `async dashboard(e: Engine=Depends(engine))`
- [create_app.markets](../backend/operator/api.py#L730) — `async markets(e: Engine=Depends(engine))`
- [create_app.correlation_data](../backend/operator/api.py#L734) — `async correlation_data(e: Engine=Depends(engine))`
- [create_app.market](../backend/operator/api.py#L739) — `async market(symbol: Literal['BTC', 'ETH', 'SOL'], timeframe: Literal['1h', '4h', '1d']='1h', e: Engine=Depends(engine))`
- [create_app.desk_budget](../backend/operator/api.py#L754) — `async desk_budget(symbol: Literal['BTC', 'ETH', 'SOL'], e: Engine=Depends(engine))`
- [create_app.alerts](../backend/operator/api.py#L759) — `async alerts(e: Engine=Depends(engine))`
- [create_app.create_alert](../backend/operator/api.py#L763) — `async create_alert(body: AlertRequest, e: Engine=Depends(engine))`
- [create_app.delete_alert](../backend/operator/api.py#L768) — `async delete_alert(alert_id: str, e: Engine=Depends(engine))`
- [create_app.news](../backend/operator/api.py#L772) — `async news(breaking: bool=False, q: str=Query(default='', max_length=200), asset: str=Query(default='', max_length=20), e: Engine=Depends(engine))`
- [create_app.refresh_news](../backend/operator/api.py#L793) — `async refresh_news(breaking: bool=False, e: Engine=Depends(engine))`
- [create_app.article](../backend/operator/api.py#L797) — `async article(article_id: str, e: Engine=Depends(engine))`
- [create_app.strategies](../backend/operator/api.py#L818) — `async strategies(e: Engine=Depends(engine))`
- [create_app.save_strategy](../backend/operator/api.py#L821) — `save_strategy(e: Engine, strategy_id: str, config: StrategyConfig, expected_version: int)`
- [create_app.strategy_config](../backend/operator/api.py#L835) — `async strategy_config(strategy_id: str, body: VersionedStrategy, e: Engine=Depends(engine))`
- [create_app.run](../backend/operator/api.py#L842) — `async run(body: RunRequest, e: Engine=Depends(engine))`
- [create_app.run_detail](../backend/operator/api.py#L846) — `async run_detail(run_id: str, e: Engine=Depends(engine))`
- [create_app.run_brief](../backend/operator/api.py#L853) — `async run_brief(run_id: str, e: Engine=Depends(engine))`
- [create_app.risk](../backend/operator/api.py#L860) — `async risk(e: Engine=Depends(engine))`
- [create_app.risk_config](../backend/operator/api.py#L870) — `async risk_config(body: VersionedRisk, e: Engine=Depends(engine))`
- [create_app.portfolio](../backend/operator/api.py#L877) — `async portfolio(e: Engine=Depends(engine))`
- [create_app.exit_preview](../backend/operator/api.py#L882) — `async exit_preview(symbol: Literal['BTC', 'ETH', 'SOL'], e: Engine=Depends(engine))`
- [create_app.history](../backend/operator/api.py#L928) — `async history(kind: Literal['runs', 'risks', 'intents', 'ledger', 'audit', 'snapshots'], limit: int=Query(default=50, ge=1, le=200), offset: int=Query(default=0, ge=0), e: E...`
- [create_app.trades](../backend/operator/api.py#L937) — `async trades(request: Request, workspace: Literal['research', 'aegis']='research', filters: TradeFilters=Depends())`
- [create_app.trade_detail](../backend/operator/api.py#L947) — `async trade_detail(workspace: Literal['research', 'aegis'], trade_id: str, request: Request)`
- [create_app.preview](../backend/operator/api.py#L955) — `async preview(body: PreviewRequest, e: Engine=Depends(engine))`
- [create_app.authorize](../backend/operator/api.py#L963) — `async authorize(body: Authorize, e: Engine=Depends(engine))`
- [create_app.reconcile](../backend/operator/api.py#L967) — `async reconcile(intent_id: str, e: Engine=Depends(engine))`
- [create_app.control](../backend/operator/api.py#L971) — `async control(body: SchedulerAction, e: Engine=Depends(engine))`
- [create_app.emergency_stop](../backend/operator/api.py#L975) — `async emergency_stop(request: Request, e: Engine=Depends(engine))`
- [create_app.backtests](../backend/operator/api.py#L982) — `async backtests(body: BacktestRequest, e: Engine=Depends(engine))`
- [create_app.provider_settings](../backend/operator/api.py#L986) — `async provider_settings(body: ProviderSettings, e: Engine=Depends(engine))`
- [create_app.news_scoring](../backend/operator/api.py#L1002) — `async news_scoring(e: Engine=Depends(engine))`
- [create_app.provider_refresh](../backend/operator/api.py#L1011) — `async provider_refresh(e: Engine=Depends(engine))`
- [create_app.change_provider_refresh](../backend/operator/api.py#L1016) — `async change_provider_refresh(body: RefreshSettings, e: Engine=Depends(engine))`
- [create_app.change_news_scoring](../backend/operator/api.py#L1024) — `async change_news_scoring(body: VersionedNewsScoring, e: Engine=Depends(engine))`
- [create_app.wallet](../backend/operator/api.py#L1031) — `async wallet(address: str, request: Request)`
- [create_app.chat](../backend/operator/api.py#L1040) — `async chat(body: ChatRequest, request: Request, e: Engine=Depends(engine))`
- [create_app.unknown_api](../backend/operator/api.py#L1334) — `async unknown_api(path: str)`

### backend/operator/assistant_tools.py

- [run_backtest](../backend/operator/assistant_tools.py#L19) — `async run_backtest(engine, body: BacktestRequest)`
- [execute](../backend/operator/assistant_tools.py#L60) — `async execute(engine, name: str, arguments: dict, *, save_strategy)`

### backend/operator/research_brief.py

- [Finding](../backend/operator/research_brief.py#L20) — class
- [Citation](../backend/operator/research_brief.py#L27) — class
- [RiskPlan](../backend/operator/research_brief.py#L39) — class
- [BriefBody](../backend/operator/research_brief.py#L55) — class
- [SnapshotReceipt](../backend/operator/research_brief.py#L80) — class
- [ResearchBrief](../backend/operator/research_brief.py#L87) — class
- [_url](../backend/operator/research_brief.py#L91) — `_url(value: Any)`
- [_money](../backend/operator/research_brief.py#L103) — `_money(value: Any)`
- [build_brief](../backend/operator/research_brief.py#L111) — `build_brief(run: dict)`
- [build_brief.output](../backend/operator/research_brief.py#L114) — `output(name: str)`

### backend/operator/trade_history.py

- [realized_deltas](../backend/operator/trade_history.py#L19) — `realized_deltas(records: list[dict])`
- [research_record](../backend/operator/trade_history.py#L46) — `research_record(record: dict, realized: str)`
- [research_history](../backend/operator/trade_history.py#L76) — `research_history(store, filters: TradeFilters)`
- [research_detail](../backend/operator/trade_history.py#L113) — `research_detail(store, trade_id: str)`

### backend/portfolio.py

- [Portfolio](../backend/portfolio.py#L13) — class
- [Portfolio.__init__](../backend/portfolio.py#L14) — `__init__(self, store: Store)`
- [Portfolio.view](../backend/portfolio.py#L21) — `view(self, markets: dict[str, Market])`
- [Portfolio.observe](../backend/portfolio.py#L151) — `observe(self, markets)`
- [Portfolio.snapshot](../backend/portfolio.py#L163) — `snapshot(self, markets)`

### backend/product/accounts.py

- [PaperAccount](../backend/product/accounts.py#L15) — class
- [get_account](../backend/product/accounts.py#L22) — `get_account(db: Connection, owner_id: UUID)`
- [ensure_account](../backend/product/accounts.py#L40) — `ensure_account(db: Connection, owner_id: UUID, initial_usdt: Decimal=DEFAULT_INITIAL_USDT)`

### backend/product/agents.py

- [AgentStartSettings](../backend/product/agents.py#L28) — class
- [AgentStart](../backend/product/agents.py#L38) — class
- [AgentStart.select_validation_source](../backend/product/agents.py#L44) — `select_validation_source(self)`
- [DraftAgentStart](../backend/product/agents.py#L54) — class
- [AgentCommand](../backend/product/agents.py#L58) — class
- [event](../backend/product/agents.py#L62) — `event(db, owner, agent, kind, detail)`
- [list_agents](../backend/product/agents.py#L69) — `list_agents(db, owner: UUID)`
- [timeline](../backend/product/agents.py#L107) — `timeline(db, owner: UUID, agent: UUID, after: int=0)`
- [start_agent](../backend/product/agents.py#L119) — `start_agent(db, owner: UUID, request: AgentStart)`
- [start_draft_agent](../backend/product/agents.py#L208) — `start_draft_agent(db, owner: UUID, request: DraftAgentStart)`
- [_validate_allocation](../backend/product/agents.py#L231) — `_validate_allocation(db, owner, epoch, cash, capital, exclude=None)`
- [control_agent](../backend/product/agents.py#L256) — `control_agent(db, owner: UUID, agent: UUID, action: str)`
- [claim_agent](../backend/product/agents.py#L289) — `claim_agent(db, lease_seconds=60)`
- [fence](../backend/product/agents.py#L330) — `fence(db, work)`
- [checkpoint](../backend/product/agents.py#L343) — `checkpoint(db, work, *, stage='MONITOR', status='RUNNING', failures=0, delay=None, candle=None, quote=None, peak=None)`
- [mark_agent](../backend/product/agents.py#L376) — `mark_agent(db, work, quantity, price, at)`
- [position_asset](../backend/product/agents.py#L410) — `position_asset(db, owner, agent)`
- [close_agent_position](../backend/product/agents.py#L425) — `close_agent_position(db, owner, agent, request_key, epoch, quotes)`

### backend/product/api.py

- [StrategyEdit](../backend/product/api.py#L75) — class
- [StrategyArchive](../backend/product/api.py#L80) — class
- [PaperReset](../backend/product/api.py#L84) — class
- [PositionClose](../backend/product/api.py#L89) — class
- [PaperEmergency](../backend/product/api.py#L94) — class
- [ProductError](../backend/product/api.py#L98) — class
- [ProductError.__init__](../backend/product/api.py#L99) — `__init__(self, status: int, code: str, message: str)`
- [create_product_api](../backend/product/api.py#L105) — `create_product_api(dsn: str, key: str, initial_usdt: Decimal=DEFAULT_INITIAL_USDT, *, history_source=load_candles, quote_source=load_quotes, fixture_feeds=False)`
- [create_product_api.lifespan](../backend/product/api.py#L121) — `async lifespan(application)`
- [create_product_api.health](../backend/product/api.py#L145) — `health()`
- [create_product_api.product_error](../backend/product/api.py#L156) — `async product_error(_request, exc)`
- [create_product_api.validation_error](../backend/product/api.py#L162) — `async validation_error(_request, exc)`
- [create_product_api.database_error](../backend/product/api.py#L178) — `async database_error(_request, _exc)`
- [create_product_api.missing_strategy](../backend/product/api.py#L185) — `async missing_strategy(_request, _exc)`
- [create_product_api.conflict](../backend/product/api.py#L192) — `async conflict(_request, _exc)`
- [create_product_api.owner](../backend/product/api.py#L198) — `async owner(request: Request)`
- [create_product_api.database](../backend/product/api.py#L239) — `database()`
- [create_product_api.paper_account](../backend/product/api.py#L248) — `paper_account(subject: Principal, db: Database)`
- [create_product_api.provision_paper_account](../backend/product/api.py#L252) — `provision_paper_account(subject: Principal, db: Database)`
- [create_product_api.financial](../backend/product/api.py#L255) — `financial(data, status=200)`
- [create_product_api.quotes_for](../backend/product/api.py#L260) — `quotes_for(db, subject, asset=None)`
- [create_product_api.paper_portfolio](../backend/product/api.py#L274) — `paper_portfolio(subject: Principal, db: Database)`
- [create_product_api.paper_order_history](../backend/product/api.py#L278) — `paper_order_history(subject: Principal, db: Database, epoch: Annotated[int | None, Query(ge=1)]=None, limit: Annotated[int, Query(ge=1, le=100)]=50)`
- [create_product_api.paper_order_submit](../backend/product/api.py#L287) — `paper_order_submit(order: OrderRequest, subject: Principal, db: Database)`
- [create_product_api.paper_order_cancel](../backend/product/api.py#L292) — `paper_order_cancel(order_id: UUID, subject: Principal, db: Database)`
- [create_product_api.paper_order_evaluate](../backend/product/api.py#L299) — `paper_order_evaluate(order_id: UUID, subject: Principal, db: Database)`
- [create_product_api.paper_reset](../backend/product/api.py#L309) — `paper_reset(reset: PaperReset, subject: Principal, db: Database)`
- [create_product_api.paper_emergency](../backend/product/api.py#L313) — `paper_emergency(change: PaperEmergency, subject: Principal, db: Database)`
- [create_product_api.paper_agent_list](../backend/product/api.py#L317) — `paper_agent_list(subject: Principal, db: Database)`
- [create_product_api.paper_agent_start](../backend/product/api.py#L321) — `paper_agent_start(request: AgentStart, subject: Principal, db: Database)`
- [create_product_api.paper_agent_control](../backend/product/api.py#L331) — `paper_agent_control(agent_id: UUID, command: AgentCommand, subject: Principal, db: Database)`
- [create_product_api.paper_agent_close](../backend/product/api.py#L342) — `paper_agent_close(agent_id: UUID, command: PositionClose, subject: Principal, db: Database)`
- [create_product_api.paper_agent_timeline](../backend/product/api.py#L357) — `paper_agent_timeline(agent_id: UUID, subject: Principal, db: Database, after: Annotated[int, Query(ge=0)]=0)`
- [create_product_api.paper_agent_stream](../backend/product/api.py#L366) — `async paper_agent_stream(agent_id: UUID, request: Request, subject: Principal, after: Annotated[int, Query(ge=0)]=0)`
- [create_product_api.paper_agent_stream.latest](../backend/product/api.py#L372) — `latest(cursor)`
- [create_product_api.paper_agent_stream.events](../backend/product/api.py#L376) — `async events()`
- [create_product_api.paper_market](../backend/product/api.py#L395) — `async paper_market(asset: Asset, request: Request, subject: Principal)`
- [create_product_api.paper_news](../backend/product/api.py#L406) — `async paper_news(request: Request, subject: Principal, asset: Asset | None=None, breaking: bool=False, refresh: bool=False)`
- [create_product_api.paper_watchlist](../backend/product/api.py#L423) — `paper_watchlist(subject: Principal, db: Database)`
- [create_product_api.paper_watch](../backend/product/api.py#L431) — `paper_watch(subject: Principal, db: Database, asset: Asset, change: PaperEmergency)`
- [create_product_api.strategy_authoring](../backend/product/api.py#L446) — `strategy_authoring(subject: Principal)`
- [create_product_api.validate_draft](../backend/product/api.py#L450) — `validate_draft(draft: StrategyDraft, subject: Principal)`
- [create_product_api.start_agent_from_draft](../backend/product/api.py#L454) — `start_agent_from_draft(request: DraftAgentStart, subject: Principal, db: Database)`
- [create_product_api.strategies](../backend/product/api.py#L462) — `strategies(subject: Principal, db: Database, after: UUID | None=None, limit: Annotated[int, Query(ge=1, le=100)]=50)`
- [create_product_api.new_strategy](../backend/product/api.py#L471) — `new_strategy(document: StrategyDraft, subject: Principal, db: Database)`
- [create_product_api.strategy](../backend/product/api.py#L476) — `strategy(strategy_id: UUID, subject: Principal, db: Database, version: Annotated[int | None, Query(ge=1, le=2 ** 31 - 1)]=None)`
- [create_product_api.edit_strategy](../backend/product/api.py#L488) — `edit_strategy(strategy_id: UUID, edit: StrategyEdit, subject: Principal, db: Database)`
- [create_product_api.remove_strategy](../backend/product/api.py#L494) — `remove_strategy(strategy_id: UUID, archive: StrategyArchive, subject: Principal, db: Database)`
- [create_product_api.versions](../backend/product/api.py#L500) — `versions(strategy_id: UUID, subject: Principal, db: Database, before: Annotated[int, Query(ge=2, le=2 ** 31)]=2 ** 31, limit: Annotated[int, Query(ge=1, le=100)]=50)`
- [create_product_api.create_backtest](../backend/product/api.py#L514) — `create_backtest(strategy_id: UUID, study: HistoricalBacktestRequest, subject: Principal, db: Database)`
- [create_product_api.backtest_report](../backend/product/api.py#L531) — `backtest_report(run_id: UUID, subject: Principal, db: Database, include_dataset: bool=False)`
- [app_from_environment](../backend/product/api.py#L542) — `app_from_environment()`

### backend/product/backtests.py

- [save_replay](../backend/product/backtests.py#L21) — `save_replay(db: Connection, owner_id: UUID, strategy: StoredStrategy, request: HistoricalBacktestRequest, market: Market)`
- [get_replay](../backend/product/backtests.py#L70) — `get_replay(db: Connection, owner_id: UUID, run_id: UUID, *, include_dataset: bool)`

### backend/product/database.py

- [open_database](../backend/product/database.py#L15) — `open_database(dsn: str)`
- [migrate](../backend/product/database.py#L19) — `migrate(db: Connection, directory: Path=MIGRATIONS)`

### backend/product/execution.py

- [OrderRequest](../backend/product/execution.py#L27) — class
- [PaperQuote](../backend/product/execution.py#L36) — class
- [PaperTerms](../backend/product/execution.py#L43) — class
- [PaperTerms.costs_within_policy](../backend/product/execution.py#L49) — `costs_within_policy(self)`
- [lock_account](../backend/product/execution.py#L58) — `lock_account(db: Connection, owner: UUID)`
- [positions](../backend/product/execution.py#L68) — `positions(db: Connection, owner: UUID, epoch: int, *, actor_only=False, agent_id: UUID | None=None)`
- [reservations](../backend/product/execution.py#L86) — `reservations(db: Connection, owner: UUID, epoch: int, exclude: UUID | None=None, agent_id: UUID | None=None)`
- [agent_cash_reserved](../backend/product/execution.py#L108) — `agent_cash_reserved(db, owner, epoch, exclude=None)`
- [_fresh](../backend/product/execution.py#L124) — `_fresh(quotes: dict[str, PaperQuote], asset: str, at: datetime, max_age: int)`
- [_cost](../backend/product/execution.py#L132) — `_cost(quantity: Decimal, price: Decimal, terms: PaperTerms)`
- [_finish](../backend/product/execution.py#L138) — `_finish(db: Connection, order_id: UUID, status: str, reason: str | None, at: datetime)`
- [_buy_risk](../backend/product/execution.py#L148) — `_buy_risk(db, owner, account, asset, gross, fee, held, quotes, at, terms)`
- [get_order](../backend/product/execution.py#L214) — `get_order(db: Connection, owner: UUID, order_id: UUID)`
- [_evaluate](../backend/product/execution.py#L228) — `_evaluate(db, owner, account, stopped, order_id, request, quotes, terms, at, *, pending, agent_id=None)`
- [submit_order](../backend/product/execution.py#L330) — `submit_order(db, owner: UUID, request: OrderRequest, quotes, terms: PaperTerms, *, clock=now, agent_id=None)`
- [process_limit](../backend/product/execution.py#L382) — `process_limit(db, owner: UUID, order_id: UUID, quotes, terms: PaperTerms, *, clock=now)`
- [cancel_order](../backend/product/execution.py#L396) — `cancel_order(db, owner: UUID, order_id: UUID)`
- [set_emergency](../backend/product/execution.py#L406) — `set_emergency(db, owner: UUID, enabled: bool)`
- [_halt_agents](../backend/product/execution.py#L418) — `_halt_agents(db, owner, epoch, status, reason)`
- [_cancel_open](../backend/product/execution.py#L433) — `_cancel_open(db, owner, epoch, reason)`
- [reset_account](../backend/product/execution.py#L444) — `reset_account(db, owner: UUID, expected_epoch: int, opening_credit: Decimal)`
- [_mark_holding](../backend/product/execution.py#L469) — `_mark_holding(row, quotes, at, max_age)`
- [_positions_by_actor](../backend/product/execution.py#L480) — `_positions_by_actor(db, owner, epoch)`
- [portfolio](../backend/product/execution.py#L498) — `portfolio(db, owner: UUID, quotes: dict[str, PaperQuote], *, clock=now, max_age=20)`
- [order_history](../backend/product/execution.py#L576) — `order_history(db, owner: UUID, *, epoch: int | None=None, limit=50)`

### backend/product/history.py

- [HistoricalBacktestRequest](../backend/product/history.py#L20) — class
- [HistoricalBacktestRequest.validate_window](../backend/product/history.py#L27) — `validate_window(self)`
- [load_candles](../backend/product/history.py#L39) — `load_candles(symbol: str, start: datetime, end: datetime, *, transport=None)`

### backend/product/market.py

- [load_quotes](../backend/product/market.py#L10) — `load_quotes(assets: set[str])`

### backend/product/rules.py

- [Condition](../backend/product/rules.py#L35) — class
- [RuleGroup](../backend/product/rules.py#L41) — class
- [StrategyDefinition](../backend/product/rules.py#L46) — class
- [StrategyDraft](../backend/product/rules.py#L58) — class
- [_threshold](../backend/product/rules.py#L64) — `_threshold(condition: Condition, values: dict)`
- [_matches](../backend/product/rules.py#L70) — `_matches(condition: Condition, current: dict, previous: dict)`
- [rule_signal](../backend/product/rules.py#L93) — `rule_signal(definition: StrategyDefinition, market: Market, *, holding: bool)`
- [authoring_options](../backend/product/rules.py#L119) — `authoring_options()`
- [authoring_options.group](../backend/product/rules.py#L136) — `group(rule)`

### backend/product/strategies.py

- [StoredStrategy](../backend/product/strategies.py#L15) — class
- [_stored](../backend/product/strategies.py#L22) — `_stored(row)`
- [_insert_version](../backend/product/strategies.py#L26) — `_insert_version(db: Connection, owner_id: UUID, strategy_id: UUID, version: int, draft: StrategyDraft)`
- [create_strategy](../backend/product/strategies.py#L40) — `create_strategy(db: Connection, owner_id: UUID, draft: StrategyDraft, *, strategy_id: UUID | None=None)`
- [get_strategy](../backend/product/strategies.py#L52) — `get_strategy(db: Connection, owner_id: UUID, strategy_id: UUID, version: int | None=None)`
- [list_strategies](../backend/product/strategies.py#L71) — `list_strategies(db: Connection, owner_id: UUID, *, after: UUID | None=None, limit: int=50)`
- [strategy_history](../backend/product/strategies.py#L97) — `strategy_history(db: Connection, owner_id: UUID, strategy_id: UUID, *, before_version: int=2 ** 31, limit: int=50)`
- [_lock_current](../backend/product/strategies.py#L120) — `_lock_current(db: Connection, owner_id: UUID, strategy_id: UUID, expected_version: int)`
- [update_strategy](../backend/product/strategies.py#L139) — `update_strategy(db: Connection, owner_id: UUID, strategy_id: UUID, draft: StrategyDraft, *, expected_version: int)`
- [archive_strategy](../backend/product/strategies.py#L154) — `archive_strategy(db: Connection, owner_id: UUID, strategy_id: UUID, *, expected_version: int)`

### backend/product/worker.py

- [Tick](../backend/product/worker.py#L44) — class
- [research](../backend/product/worker.py#L52) — `research(state: Tick)`
- [rules](../backend/product/worker.py#L56) — `rules(state: Tick)`
- [trade_graph](../backend/product/worker.py#L60) — `trade_graph()`
- [PaperWorker](../backend/product/worker.py#L70) — class
- [PaperWorker.__init__](../backend/product/worker.py#L71) — `__init__(self, history=load_candles, quotes=load_quotes, *, allow_fixture=False, clock=now, market_clock=None)`
- [PaperWorker.tick](../backend/product/worker.py#L87) — `tick(self, db, work)`
- [PaperWorker._fail](../backend/product/worker.py#L93) — `_fail(self, db, work, reason)`
- [PaperWorker._tick](../backend/product/worker.py#L116) — `_tick(self, db, work)`
- [PaperWorker._validate](../backend/product/worker.py#L254) — `_validate(self, db, work, strategy, terms, *, revalidation)`
- [heartbeat_fresh](../backend/product/worker.py#L320) — `heartbeat_fresh(db, worker_id=None)`
- [worker_identity](../backend/product/worker.py#L333) — `worker_identity()`
- [service](../backend/product/worker.py#L337) — `service(dsn: str, stop: Event, worker: PaperWorker)`
- [main](../backend/product/worker.py#L377) — `main()`

### backend/product/workflow.py

- [Activation](../backend/product/workflow.py#L11) — class
- [review_holdout](../backend/product/workflow.py#L20) — `review_holdout(state: Activation)`
- [activation_risk](../backend/product/workflow.py#L37) — `activation_risk(state: Activation)`
- [activation_graph](../backend/product/workflow.py#L54) — `activation_graph()`

### backend/research.py

- [NoMemory](../backend/research.py#L22) — class
- [NoMemory.get_memories](../backend/research.py#L23) — `get_memories(self, situation, n_matches=2)`
- [BoundedResearchLLM](../backend/research.py#L27) — class
- [BoundedResearchLLM.__init__](../backend/research.py#L28) — `__init__(self, llm)`
- [BoundedResearchLLM.invoke](../backend/research.py#L31) — `invoke(self, prompt)`
- [ResearchBridge](../backend/research.py#L41) — class
- [ResearchBridge.__init__](../backend/research.py#L44) — `__init__(self, llm=None)`
- [ResearchBridge.analyze](../backend/research.py#L69) — `async analyze(self, market_report: str, news_report: str)`
- [ResearchBridge.analyze.invoke](../backend/research.py#L102) — `async invoke(factory)`

### backend/risk.py

- [assess](../backend/risk.py#L12) — `assess(proposal: Proposal, portfolio: dict, config: RiskConfig, version: int, *, stopped=False, pending=False, recent_failures=0, last_trade: datetime | None=None, clo...`
- [assess.check](../backend/risk.py#L27) — `check(code, passed, actual, limit, reason)`
- [validate_quote](../backend/risk.py#L248) — `validate_quote(quote: Quote, proposal: Proposal, decision: RiskDecision, config: RiskConfig, clock=None, wallet=None)`

### backend/selection.py

- [selection_inputs](../backend/selection.py#L14) — `selection_inputs(store, symbol: str, market: Market)`
- [SelectionConfig](../backend/selection.py#L36) — class
- [rank_strategies](../backend/selection.py#L53) — `rank_strategies(market: Market, news: NewsFeed, signals: list[Signal], config: SelectionConfig, previous: dict | None=None, performance: dict | None=None, contextual_a...`
- [rank_strategies.clip](../backend/selection.py#L74) — `clip(x)`

### backend/settings.py

- [SettingsModel](../backend/settings.py#L20) — class
- [public_https](../backend/settings.py#L24) — `public_https(value: str)`
- [ProviderRefresh](../backend/settings.py#L50) — class
- [ReferenceAsset](../backend/settings.py#L57) — class
- [DataSettings](../backend/settings.py#L62) — class
- [DataSettings.supported_identity](../backend/settings.py#L77) — `supported_identity(self)`
- [SimulationSettings](../backend/settings.py#L86) — class
- [SimulationSettings.deadline_after_expiry](../backend/settings.py#L98) — `deadline_after_expiry(self)`
- [SchedulerSettings](../backend/settings.py#L104) — class
- [DocumentedToken](../backend/settings.py#L109) — class
- [NetworkSettings](../backend/settings.py#L114) — class
- [RuntimeSettings](../backend/settings.py#L125) — class
- [RuntimeSettings.default_asset_available](../backend/settings.py#L133) — `default_asset_available(self)`
- [RuntimeSettings.fingerprint](../backend/settings.py#L139) — `fingerprint(self)`
- [get_settings](../backend/settings.py#L146) — `get_settings()`

### backend/storage.py

- [json_default](../backend/storage.py#L17) — `json_default(value)`
- [encode](../backend/storage.py#L27) — `encode(value)`
- [safe](../backend/storage.py#L31) — `safe(value: Any)`
- [Store](../backend/storage.py#L47) — class
- [Store.__init__](../backend/storage.py#L48) — `__init__(self, path: str)`
- [Store.transaction](../backend/storage.py#L84) — `transaction(self)`
- [Store.close](../backend/storage.py#L99) — `close(self)`
- [Store.config](../backend/storage.py#L102) — `config(self, name: str, default=None)`
- [Store.update_config](../backend/storage.py#L116) — `update_config(self, name: str, value, expected: int | None=None)`
- [Store.audit](../backend/storage.py#L131) — `audit(self, kind: str, payload)`
- [Store.put](../backend/storage.py#L138) — `put(self, table: str, identifier: str, payload, *, state: str='', proposal_id: str='')`
- [Store.get](../backend/storage.py#L172) — `get(self, table: str, identifier: str)`
- [Store.financial_history](../backend/storage.py#L182) — `financial_history(self, table: str)`
- [Store.history](../backend/storage.py#L191) — `history(self, table: str, limit=50, offset=0)`
- [Store.snapshot](../backend/storage.py#L208) — `snapshot(self, payload)`
- [Store.prune_chat](../backend/storage.py#L215) — `prune_chat(self)`

### backend/strategies.py

- [indicators](../backend/strategies.py#L68) — `indicators(market: Market)`
- [evaluate](../backend/strategies.py#L140) — `evaluate(strategy_id: str, market: Market, news: NewsFeed, config: StrategyConfig, holding=False, clock=None)`

### backend/strategy_registry.py

- [StrategyEvaluation](../backend/strategy_registry.py#L13) — class
- [TradingStrategy](../backend/strategy_registry.py#L27) — class
- [TradingStrategy.evaluate](../backend/strategy_registry.py#L31) — `evaluate(self, market: Market, news: NewsFeed, holding: bool=False, clock=None)`
- [TradingStrategy.validate](../backend/strategy_registry.py#L34) — `validate(self, market: Market)`
- [TradingStrategy.get_configuration](../backend/strategy_registry.py#L35) — `get_configuration(self)`
- [RuleStrategy](../backend/strategy_registry.py#L38) — class
- [RuleStrategy.__init__](../backend/strategy_registry.py#L39) — `__init__(self, identifier: str, configuration: StrategyConfig)`
- [RuleStrategy.get_configuration](../backend/strategy_registry.py#L44) — `get_configuration(self)`
- [RuleStrategy.validate](../backend/strategy_registry.py#L47) — `validate(self, market)`
- [RuleStrategy.evaluate](../backend/strategy_registry.py#L56) — `evaluate(self, market, news, holding=False, clock=None)`
- [builtins](../backend/strategy_registry.py#L78) — `builtins(configurations: dict[str, StrategyConfig])`

## TypeScript exported entry points and contracts

### backend/gateway/agents/agent.service.ts

- [AgentService](../backend/gateway/agents/agent.service.ts#L39)

### backend/gateway/auth/cognito.ts

- [Authenticator](../backend/gateway/auth/cognito.ts#L20)
- [CognitoAuth](../backend/gateway/auth/cognito.ts#L23)

### backend/gateway/config.ts

- [Config](../backend/gateway/config.ts#L96)
- [loadConfig](../backend/gateway/config.ts#L111)

### backend/gateway/domain/errors.ts

- [PlatformError](../backend/gateway/domain/errors.ts#L1)

### backend/gateway/domain/schemas.ts

- [AgentSpec](../backend/gateway/domain/schemas.ts#L262)
- [Profile](../backend/gateway/domain/schemas.ts#L263)
- [DeploymentState](../backend/gateway/domain/schemas.ts#L278)
- [Agent](../backend/gateway/domain/schemas.ts#L279)
- [Deployment](../backend/gateway/domain/schemas.ts#L295)
- [Principal](../backend/gateway/domain/schemas.ts#L308)
- [RecordItem](../backend/gateway/domain/schemas.ts#L313)

### backend/gateway/integrations/llm/agent-analysis.service.ts

- [AgentAnalysisService](../backend/gateway/integrations/llm/agent-analysis.service.ts#L28)

### backend/gateway/integrations/llm/analysis-consumer.ts

- [consumeAnalysis](../backend/gateway/integrations/llm/analysis-consumer.ts#L8)

### backend/gateway/integrations/llm/bedrock.client.ts

- [createBedrockClient](../backend/gateway/integrations/llm/bedrock.client.ts#L5)

### backend/gateway/integrations/llm/conversation.service.ts

- [ConversationService](../backend/gateway/integrations/llm/conversation.service.ts#L54)

### backend/gateway/integrations/llm/groq.provider.ts

- [toOpenAIMessages](../backend/gateway/integrations/llm/groq.provider.ts#L26)
- [GroqProvider](../backend/gateway/integrations/llm/groq.provider.ts#L70)

### backend/gateway/integrations/llm/llm.interface.ts

- [ModelMessage](../backend/gateway/integrations/llm/llm.interface.ts#L1)
- [ToolDefinition](../backend/gateway/integrations/llm/llm.interface.ts#L15)
- [LLMContext](../backend/gateway/integrations/llm/llm.interface.ts#L20)
- [LLMRequest](../backend/gateway/integrations/llm/llm.interface.ts#L26)
- [LLMResponse](../backend/gateway/integrations/llm/llm.interface.ts#L33)
- [LLMProvider](../backend/gateway/integrations/llm/llm.interface.ts#L40)

### backend/gateway/integrations/llm/minimax.provider.ts

- [MiniMaxProvider](../backend/gateway/integrations/llm/minimax.provider.ts#L15)

### backend/gateway/integrations/llm/prompt-manager.ts

- [PromptManager](../backend/gateway/integrations/llm/prompt-manager.ts#L4)

### backend/gateway/integrations/llm/structured-output.ts

- [validateOutput](../backend/gateway/integrations/llm/structured-output.ts#L3)
- [bedrockSchema](../backend/gateway/integrations/llm/structured-output.ts#L14)

### backend/gateway/integrations/llm/token-usage.service.ts

- [TokenUsageService](../backend/gateway/integrations/llm/token-usage.service.ts#L14)

### backend/gateway/integrations/llm/tool-registry.ts

- [ToolRegistry](../backend/gateway/integrations/llm/tool-registry.ts#L18)

### backend/gateway/product/routes.ts

- [registerProductRoutes](../backend/gateway/product/routes.ts#L51)

### backend/gateway/profiles/profile.service.ts

- [ProfileService](../backend/gateway/profiles/profile.service.ts#L9)

### backend/gateway/runtime/agent-template.ts

- [agentTemplate](../backend/gateway/runtime/agent-template.ts#L6)

### backend/gateway/runtime/aws-runtime.ts

- [AwsRuntime](../backend/gateway/runtime/aws-runtime.ts#L51)

### backend/gateway/runtime/broker.ts

- [handler](../backend/gateway/runtime/broker.ts#L18)

### backend/gateway/runtime/janitor.ts

- [handler](../backend/gateway/runtime/janitor.ts#L12)

### backend/gateway/runtime/runtime.interface.ts

- [RuntimeStatus](../backend/gateway/runtime/runtime.interface.ts#L7)
- [RuntimeProvider](../backend/gateway/runtime/runtime.interface.ts#L32)

### backend/gateway/server.ts

- [createPlatform](../backend/gateway/server.ts#L39)

### backend/gateway/storage/tenant-store.ts

- [Write](../backend/gateway/storage/tenant-store.ts#L11)
- [Page](../backend/gateway/storage/tenant-store.ts#L17)
- [TenantStore](../backend/gateway/storage/tenant-store.ts#L21)
- [DynamoTenantStore](../backend/gateway/storage/tenant-store.ts#L67)
- [MemoryTenantStore](../backend/gateway/storage/tenant-store.ts#L195)
