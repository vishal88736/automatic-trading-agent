# Directory map

```text
automatic-trading-agent/
├── backend/
│   ├── api.py                 Local FastAPI routes, sessions and app lifecycle
│   ├── settings.py            Validated public operator defaults
│   ├── models.py              Pydantic domain and request contracts
│   ├── data.py                Market/news providers, normalization and caches
│   ├── engine.py              LangGraph workflow and local scheduler
│   ├── strategies.py          Five strategy definitions and indicators
│   ├── strategy_registry.py   Structured strategy interface
│   ├── selection.py           Adaptive ranking and switching policies
│   ├── risk.py                Independent deterministic enforcement
│   ├── exchanges.py           Simulation, HSK read-only and Alpaca boundaries
│   ├── execution.py           Intents, final checks, fills and reconciliation
│   ├── portfolio.py           Cash, inventory, average cost and drawdown
│   ├── storage.py             SQLite transactions, history and audit
│   ├── analytics.py           Causal chart indicators and correlations
│   ├── desk.py                Sizing previews and persisted price alerts
│   ├── backtesting.py         Chronological simulation with holdout accounting
│   ├── research.py            Optional preserved upstream research adapter
│   ├── cloud_worker.py        Approved Fargate simulation/monitoring worker
│   ├── src/                   TypeScript AWS control plane; see page 4
│   └── tests/                 Python regressions and platform/*.test.ts
├── config/runtime.json        Public provider, simulation and network defaults
├── frontend/
│   ├── src/App.tsx            Shell, routes, polling and local workspace state
│   ├── src/api.ts             Local API session/CSRF client
│   ├── src/types.ts           Local dashboard API types
│   ├── src/workspaces.tsx     Overview, markets, news, risk, wallet and settings
│   ├── src/TradingDesk.tsx    Interactive chart, sizing ticket and activity dock
│   ├── src/charts.tsx         SVG equity/candle/indicator charts
│   ├── src/discovery.tsx      Strategy discovery controls and measured states
│   ├── src/platform/          Cloud authentication, builder and observatory
│   ├── src/ui.tsx             Shared controls, formatting and empty states
│   ├── src/brand.tsx          Original KRONO vector identity
│   ├── src/*.css              Shared theme and workspace design rules
│   └── vite.config.ts         Local API proxies and production asset build
├── infra/                     CDK stacks, environment selection and assertions
├── deploy/aws/                Container recipes, AWS helper and env template
├── scripts/                   Dev launcher, provider probes, smoke/audit tools
├── e2e/                       Isolated Chromium simulation and platform tests
├── tradingagents/             Preserved Alpaca/LangGraph strategy/research code
├── webui/                     Preserved original upstream web interface
├── cli/                       Preserved original upstream CLI
├── legacy_tests/              Preserved numerical regression suites
├── docs/                      Setup, provenance, limits and verification
├── docs/codebase/             This explanation and generated source reference
├── .github/workflows/         CI validation and opt-in AWS image publishing
├── pyproject.toml, uv.lock    Active Python runtime dependencies
└── package.json, package-lock.json  UI, platform and infrastructure dependencies
```

Runtime directories such as `.runtime/`, `.cache/`, `.venv/`, `node_modules/`, `cdk.out/` and `artifacts/` are generated or private and ignored by Git. Do not publish a database, cloud output file or environment file to explain the application.

The old root requirements/upstream documentation describe the preserved original application. Use `pyproject.toml` and the root README for the active KRONO terminal. Optional upstream LLM or broker workflows may require their separate dependency set.

For a UI bug, start with the workspace component, its request in `api.ts` or `platform/client.ts`, and the corresponding backend route. For an accounting bug, start with `execution.py`, `portfolio.py` and `storage.py`; changing a displayed number alone does not fix its source.
