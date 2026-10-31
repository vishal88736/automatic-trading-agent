# AWS control-plane guide

The control plane lives under `backend/src`. It coordinates declarative agents and actual AWS services. The approved worker remains Python. This split preserves the existing framework and isolates user-facing cloud authentication from the local terminal.

| Module                                       | What to read and why                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.ts`                                  | `createPlatform` registers `/platform/*`, origin restrictions, request IDs, safe errors and bounded HTTP bodies. Production dependency overrides are forbidden.                      |
| `config.ts`                                  | `loadConfig` validates server environment fields, Bedrock settings and quota limits. Credentials come from IAM/temporary AWS authentication, not a request body.                     |
| `domain/schemas.ts`                          | Strict Zod profile, agent specification, permissions, runtime resource and approval contracts. LIVE/PAPER/arbitrary user code are rejected.                                          |
| `domain/errors.ts`                           | Structured `PlatformError` and authorization/conflict/not-found helpers.                                                                                                             |
| `auth/cognito.ts`                            | JWT verification plus registration, verification, login, reset, refresh and logout. Browser sessions use HttpOnly cookies; a verified Cognito subject defines ownership.             |
| `storage/tenant-store.ts`                    | Exact tenant partition keys, scoped cursors, conditional/versioned atomic writes and audit. `MemoryTenantStore` is a test-only implementation.                                       |
| `profiles/profile.service.ts`                | Persistent identity/profile defaults, concurrent session initialization and versioned profile updates.                                                                               |
| `agents/agent.service.ts`                    | Managed templates, user drafts, validation, risk bounds, previews, deployment approval, quotas, control, rollback and observed status. Start here for agent lifecycle defects.       |
| `integrations/llm/llm.interface.ts`          | Provider-neutral message, tool and usage contracts.                                                                                                                                  |
| `integrations/llm/bedrock.client.ts`         | The centralized Bedrock SDK client; no individual worker creates a model client.                                                                                                     |
| `integrations/llm/minimax.provider.ts`       | Converse calls, structured output, bounded retries/timeouts, reasoning suppression and usage reservation/settlement.                                                                 |
| `integrations/llm/token-usage.service.ts`    | Atomic daily reservations, actual available token counts and optional sourced price estimates. Unknown billing outcomes retain their reservation.                                    |
| `integrations/llm/prompt-manager.ts`         | Trusted safety instructions with subordinate stored style preferences. External articles/specifications are data, not instructions.                                                  |
| `integrations/llm/structured-output.ts`      | Bedrock-compatible JSON schemas and full server-side validation.                                                                                                                     |
| `integrations/llm/tool-registry.ts`          | Read tools and permission-limited draft/change proposals. Sensitive changes produce reviewed single-use actions; no shell, arbitrary infrastructure or signing tool exists.          |
| `integrations/llm/conversation.service.ts`   | Persisted conversations, bounded public context, tool rounds, request idempotency and per-message retention. Raw private reasoning is not saved.                                     |
| `integrations/llm/agent-analysis.service.ts` | Resolves stored worker requests, validates tenant/deployment/evidence and writes per-asset model advice.                                                                             |
| `integrations/llm/analysis-consumer.ts`      | Bounded SQS dispatcher and graceful shutdown for shared model reviews.                                                                                                               |
| `runtime/runtime.interface.ts`               | The contract for actual deployment/control/status/events/logs.                                                                                                                       |
| `runtime/agent-template.ts`                  | Trusted CloudFormation workload: approved image, private Fargate service, non-root/read-only container and a narrowly scoped role. The LLM never writes this template.               |
| `runtime/aws-runtime.ts`                     | Real Step Functions, CloudFormation, ECS, DynamoDB and CloudWatch calls. Health requires observed task state and a fresh heartbeat. CloudWatch cursors are tenant/deployment scoped. |
| `runtime/broker.ts`                          | Treats queue bodies as pointers; resolves the persisted opportunity and delivers only to explicitly linked same-tenant agents.                                                       |
| `runtime/janitor.ts`                         | Independent scheduled sweep scales expired/stopped/failed services to zero. Budget alerts are not an account-wide hard spending cap.                                                 |

File links and exported symbols are in the [generated reference](07_SOURCE_REFERENCE.md).

## Infrastructure

`infra/stack.ts` defines the VPC/private subnets, CloudFront/S3 frontend, private ALB, Cognito, DynamoDB tables, KMS, encrypted artifacts, ECR, API task, workflow, queues, broker/janitor, logs, alarms and optional DNS/OIDC publisher. `infra/app.ts` selects the environment and public deployment inputs.

`deploy/aws/manage.ts` performs local synthesis or explicitly requested account operations after STS/preflight checks. `Dockerfile.api` builds the Node service without CDK tooling in its final image. `Dockerfile.agent` includes the Python engine and validated `config/` defaults. Image publication uses temporary OIDC credentials when configured.

The worker's task role cannot read profiles, conversations, another agent's runtime partition, or arbitrary secrets. It can only read its control/emergency state, update its own runtime state, access its checkpoint prefix and publish allowed queue messages. The shared API is a trusted control plane with broader service permissions, so its authentication and data-access boundaries remain critical.

## Evidence boundary

Tests verify JWT cryptography, tenant scoping, CAS/replay handling, schema failures, lifecycle contracts and synthesized infrastructure. They use test providers for cloud operations. Real Cognito delivery, Bedrock account/model entitlement, Fargate health, IAM behavior in AWS, scaling and recovery still require the account-level run in [AWS_SETUP.md](../AWS_SETUP.md). No environment file contents are part of this guide.
