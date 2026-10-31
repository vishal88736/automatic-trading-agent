# Development and debugging

## Local terminal

Install the locked dependencies using the root README's project-local cache settings:

```bash
uv sync --python 3.12
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`. FastAPI normally listens at `127.0.0.1:8787`. `/api/health` checks process availability; the dashboard/status/settings reveal the selected providers and actual data state. Current defaults use live read-only feeds while trades stay simulated.

For a deterministic demo, explicitly select both fixture providers before trading, or use a separate database configured with `MARKET_PROVIDER=fixture` and `NEWS_PROVIDER=fixture`. Follow [DEMO.md](../DEMO.md). Do not expect a real market always to produce a BUY signal.

The root `.env` is loaded by `scripts/dev.mjs`. A manually launched Python process does not automatically load that file. Restart after Python/operator-file changes unless you deliberately start a reload-enabled server. Vite updates frontend code independently; seeing a frontend change does not mean the backend process has restarted.

## Debug a failing screen

1. Open browser Network tools and inspect the exact `/api/*` or `/platform/*` request, status and response `error.request_id`/`error.requestId`.
2. Find the route in [the generated reference](07_SOURCE_REFERENCE.md), then follow its domain call in the module guide.
3. Check source, status, publication/price time and retrieval time. They describe different observations.
4. Check Settings for saved providers and refresh policy. A saved selection takes precedence over first-run environment defaults.
5. Check audit/run stage records. A rejected risk check or HOLD is often an expected result, not an HTTP failure.
6. Reproduce in a new isolated test database. Do not repair a ledger by deleting rows or resubmitting an uncertain intent.

## Common symptoms

| Symptom                                       | Check and response                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prices and stories never change               | The providers may still be `fixture` in SQLite. Select Coinbase and cryptocurrency.cv in Settings. Fixtures intentionally stay deterministic.                                                                                         |
| Prices update only every few minutes          | Check Feed refresh. Tickers now have their own short cache; closed hourly history uses a longer cache. This is periodic REST polling, not a WebSocket tick stream.                                                                    |
| Only three latest stories                     | The inspected unauthenticated news API reports `limited: true` and `maxResults: 3`. The UI preserves this provider limitation. An authorized server-side API key may change your allowance; the application never pays automatically. |
| Breaking feed freezes                         | It must poll while selected. A provider/source switch must not retain another source's old breaking list.                                                                                                                             |
| News is unavailable or stale                  | Check upstream health, retry cooldown, credentials/allowance and original retrieval time. Cached data does not become current merely because a page refreshed.                                                                        |
| A preview cannot be authorized                | Inspect quote expiry, market movement, provider/configuration versions, risk, pause/emergency and duplicate state. Obtain new analysis/quote instead of replaying old authorization.                                                  |
| No simulated order from a real market         | Inspect each actual strategy/risk stage. Current conditions may legitimately yield HOLD; unavailable liquidity or incomplete evidence must not be invented.                                                                           |
| Local chat cannot enable a strategy           | Use an actual registry name. The retired standalone news strategy is not a sixth built-in. Arbitrage remains disabled without verified routes.                                                                                        |
| Account/session requests return conflict      | Concurrent initialization is retried safely. An actual version mismatch still requires reloading the reviewed resource. Provider capacity failures are not configuration conflicts.                                                   |
| Cloud workspace is unavailable                | Configure the AWS file, publish real images and deploy the services. The local terminal's sessions/database do not authenticate the cloud API.                                                                                        |
| HSK shows no tradable chart or whale activity | There is no verified HSK price/whale provider wired into the approved market adapter. HSK news/native read-only balance support does not imply those feeds.                                                                           |

## Regression commands

```bash
.venv/bin/ruff check backend scripts
.venv/bin/ruff format --check backend scripts
.venv/bin/python -m pytest backend/tests legacy_tests/test_regime_detection.py legacy_tests/test_backtest_engine.py legacy_tests/test_portfolio_intelligence.py -q
npm run check:platform
npm run test:platform
npm run build
npm run test:e2e
.venv/bin/python -m scripts.production_smoke
npm run aws:synth
.venv/bin/python -m scripts.generate_code_reference --check
.venv/bin/python -m scripts.public_audit
git diff --check
```

The tests force simulation and fixture providers. The platform browser harness labels its fake cloud providers and does not contact AWS. `aws:synth` produces local templates, not deployments.

An opt-in read-only real-provider check is separate:

```bash
.venv/bin/python -m scripts.verify_providers --network
```

It reports source timestamps and provider availability without signing/submitting any transaction. Raw diagnostics go into ignored `artifacts/`; publish only sanitized evidence. Never copy environment contents or credentials into an issue or guide.
