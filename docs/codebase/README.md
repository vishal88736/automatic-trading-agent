# Understanding KRONO

Start here to understand what runs, where the code lives, how a trade travels through the system, and which integrations still need external verification.

Read these pages in order:

1. [Directory map](01_DIRECTORY_MAP.md): the purpose of every active project area.
2. [Architecture and request flows](02_ARCHITECTURE_AND_FLOWS.md): local terminal versus AWS platform, analysis, approval, accounting and recovery.
3. [Python backend guide](03_PYTHON_BACKEND.md): each domain module and the functions to read first.
4. [AWS control-plane guide](04_AWS_PLATFORM.md): authentication, tenants, conversations, deployments and worker coordination.
5. [Configuration and hardcoded-value audit](05_CONFIGURATION.md): what to change, precedence, safety invariants and deliberately synthetic fixtures.
6. [Development and debugging](06_DEVELOPMENT_AND_DEBUGGING.md): setup, live feeds, errors, regression commands and common failures.
7. [Generated source reference](07_SOURCE_REFERENCE.md): actual API routes and Python class/function locations, generated from this checkout.
8. [Backend audit](08_BACKEND_AUDIT.md): reproduced defects, fixes, test evidence and remaining boundaries.

The entry points are [frontend/src/App.tsx](../../frontend/src/App.tsx), [backend/api.py](../../backend/api.py) for the local terminal, [backend/src/server.ts](../../backend/src/server.ts) for the cloud API, and [backend/cloud_worker.py](../../backend/cloud_worker.py) for isolated AWS workers.

There are two backends because they serve different trust boundaries. The local Python terminal is one operator's simulation workspace. The TypeScript service is the authenticated multi-tenant cloud control plane. The cloud service deploys the approved Python engine; it does not publish the local SQLite/session API to the internet.

Live **data** and live **execution** are separate. Current Coinbase prices and cryptocurrency.cv articles can drive a simulated account. They do not enable a wallet signature or HSKSwap swap. AWS SDK wiring and local tests also do not prove a real cloud deployment; account-level verification is listed in [AWS_SETUP.md](../AWS_SETUP.md).

This folder explains the application rather than copying the source. Follow its file links when making a change, then run the relevant checks. Regenerate the source reference with:

```bash
.venv/bin/python -m scripts.generate_code_reference
```
