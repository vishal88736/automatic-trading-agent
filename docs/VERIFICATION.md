# Verification

## Automated checks

```bash
.venv/bin/ruff check backend scripts tests/e2e
.venv/bin/ruff format --check backend scripts tests/e2e
.venv/bin/python -m pytest -q                       # unit tests; PostgreSQL tests need KRONO_TEST_DATABASE_DSN
npm run test:platform                               # gateway: auth, local sign-in, rules drafter, signing, isolation
npm run build                                       # strict types and production bundle
npm run test:e2e                                    # browser tests (see DEVELOPMENT.md for the fixture API)
.venv/bin/python -m scripts.public_audit            # tracked files contain no credential patterns
```

PostgreSQL integration tests create and drop their own schema in the database named by `KRONO_TEST_DATABASE_DSN`. With `make dev` running you can point it at a throwaway database in the dev container:

```bash
docker exec krono-dev-postgres psql -U krono -d krono -c "CREATE DATABASE krono_test"
KRONO_TEST_DATABASE_DSN=postgresql://krono:<dbPassword from .runtime/dev.json>@127.0.0.1:55432/krono_test \
  .venv/bin/python -m pytest -q backend/tests/test_platform_postgres.py
```

## What the suites cover

| Area                  | Evidence                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background agents     | `tests/e2e/paper-autonomy.spec.ts` closes the browser, stops the API and kills the worker; the agent keeps trading and resumes without duplicate fills |
| Strategy chat         | `backend/tests/platform/local.test.ts` (rules drafter), `tests/e2e/platform-strategy.spec.ts` (draft, revise, save)                                    |
| Leaderboard           | `test_leaderboard_ranks_every_tenant_by_return_without_exposing_other_ids`                                                                             |
| Local sign-in         | `local.test.ts` (signed sessions, CSRF, forged cookies), `test_self_hosted_accounts_are_unique_and_reserved_for_the_gateway`                           |
| Tenant isolation      | `test_platform_postgres.py`, `backend/tests/platform/isolation.test.ts`                                                                                |
| Paper ledger and risk | `test_order_execution_uses_one_ledger_for_fills_reservations_and_reset`, `test_parallel_submissions_share_cash_lock`                                   |
| Themes and layout     | `tests/e2e/theme.spec.ts` (system theme, persisted choice, responsive landing and navigation)                                                          |
