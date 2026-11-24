# KRONO 2.0 AWS setup

KRONO now has a TypeScript control plane in `backend/gateway` and an approved Python/LangGraph worker in `backend/cloud_worker.py`. The existing localhost terminal remains available with `npm run dev`. Its SQLite database and localhost session API are **not exposed as the cloud multi-tenant API**.

This checkout has no configured AWS profile or credentials. Infrastructure synthesis and fixture tests do not establish a deployment, Cognito email delivery, account-level Bedrock access, IAM enforcement in AWS, or a live blockchain transaction. Supply your account details through the ignored environment file and run the AWS acceptance steps below.

## Environment

```bash
cp deploy/aws/.env.example deploy/aws/.env
```

Edit `deploy/aws/.env`. Set `AWS_PROFILE` for an existing SSO/temporary credential profile, `AWS_ACCOUNT_ID`, `AWS_REGION`, `KRONO_ENV`, `KRONO_MONTHLY_BUDGET_USD` and `KRONO_BUDGET_EMAIL`. Use IAM task roles on ECS. Do not put AWS keys in Vite variables, source files, agent specifications or chat. The AWS SDKs and project-local CDK use the normal credential chain; the AWS CLI is not required by the Node deployment helper.

`KRONO_ENV` selects separate `krono-development`, `krono-staging` and `krono-production` stacks, databases, clusters, images and encryption resources. Prefer separate AWS accounts/profiles for production. Production deployment requires a domain, existing hosted zone ID/name and an existing **us-east-1** ACM certificate for CloudFront. The default CloudFront domain works for development. Supply `KRONO_HOSTED_ZONE_NAME` explicitly rather than deriving a DNS zone from a public suffix.

## Foundation and images

```bash
npm ci
npm run check:platform
npm run build:platform
npm run test:platform
npm run aws:synth
npm run aws:preflight
node --env-file=deploy/aws/.env --import tsx deploy/aws/manage.ts bootstrap
npm run aws:deploy
```

Synthesis is local and creates no AWS resources. Preflight verifies STS identity against the configured account. Bootstrap and deployment provision billable infrastructure and require suitable operator IAM permissions. Review CDK's IAM/security diff before applying it.

The first deployment creates the foundation with **zero API tasks**. It deliberately does not guess an image or run a mutable `latest` tag. Obtain the ECR repository URLs from:

```bash
node --env-file=deploy/aws/.env --import tsx deploy/aws/manage.ts outputs
```

Build the gateway, cloud worker and product images using `deploy/aws/Dockerfile.api`, `deploy/aws/Dockerfile.agent` and `deploy/paper/Dockerfile`. Push versioned tags to the three ECR repositories, then set `KRONO_API_IMAGE_DIGEST`, `KRONO_AGENT_IMAGE_DIGEST` and `KRONO_PRODUCT_IMAGE_DIGEST` to their published `sha256:...` digests. Redeploy the stack. The gateway requires the product digest, and the cloud worker requires its own published digest.

The optional **AWS container images** GitHub workflow builds and pushes all three images. Set `KRONO_GITHUB_REPOSITORY=owner/repository` before deploying to create an ECR-only OIDC publisher role. Configure the GitHub environment named exactly `development`, `staging` or `production` with `AWS_REGION`, `AWS_ACCOUNT_ID` and `AWS_IMAGE_PUBLISHER_ROLE_ARN` variables. Protect the environment and restrict its deployment branch to main. For subsequent stacks in the same account, set `KRONO_GITHUB_OIDC_PROVIDER_ARN` to reuse the existing provider.

The product digest enables an encrypted Aurora PostgreSQL Serverless v2 cluster in isolated subnets, the private Product API and the paper worker. A migration container must succeed before the Product API starts. The gateway reaches the API over private VPC HTTP, using a signing key in Secrets Manager. The Product API security group accepts connections from the gateway security group. The API and worker verify the RDS certificate when connecting. To enable exchange linking and mirroring, provide `KRONO_CREDENTIAL_KEY_SECRET_ARN` for a separate stable 64-character hex encryption key. Hold on to the original key when restoring the database.

The DNS firewall allows the built-in provider hosts and the private Product API domain. When using different endpoints, add their exact hostnames to `KRONO_AWS_EXTRA_EGRESS_HOSTS`. `KRONO_WAF_RATE_LIMIT` controls the gateway's IP rate threshold.

The API and worker containers run as UID 10001 with read-only root filesystems. The worker's `/app/.runtime` volume must be writable; CI checks this independently of AWS. Local Docker access may require your host's normal Docker permissions.

## Publish the frontend

```bash
VITE_KRONO_PLATFORM=true npm run build
node --env-file=deploy/aws/.env --import tsx deploy/aws/manage.ts publish
```

Only the non-secret build flag goes to Vite. This cloud build opens the Agent Platform and excludes navigation into the separate localhost terminal. S3 serves the frontend through CloudFront OAC. `/platform/*` reaches an internal ALB using a CloudFront VPC origin; the Python worker has no public HTTP listener. Invalidate `/index.html` in CloudFront after subsequent frontend releases. API responses are not cached, and API 404s are not rewritten into successful HTML responses.

CloudFront VPC origins currently do not support WebSockets; the observatory uses bounded polling of actual events, ECS state, heartbeats and CloudWatch metrics. See [AWS VPC origin documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).

For local control-plane development against your AWS stack, fill the remaining `KRONO_*` and Cognito runtime fields from the ECS API task environment/stack outputs, keep `KRONO_PUBLIC_ORIGIN` equal to the local browser origin, and run `npm run dev:platform` alongside `npm run dev`. Cognito IDs and service URLs are configuration; credentials remain in IAM/profile authentication.

## Bedrock and conversations

Default model: `minimax.minimax-m2.5`, region `ap-south-1`, Converse API. AWS documents tool calling, structured output and Mumbai support for this model; your account entitlement, quotas and selected region still need verification. [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html), [structured-output contract](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).

Set `KRONO_LLM_PROVIDER=groq` and supply `KRONO_GROQ_KEY_SECRET_ARN` to use Groq. Store the raw key in the secret and set `GROQ_MODEL` to choose the model. For another OpenAI-compatible provider, set `GROQ_BASE_URL` to its HTTPS endpoint. The stack adds that host to the DNS allowlist. Use the default Secrets Manager encryption key for externally supplied secret ARNs. Bedrock deployments continue to use the AWS task role. Model limits, retries, token budgets and pricing estimates are configurable. Each attempt has its own usage reservation. Automatic cloud simulation fills require a fresh matching model review by default.

Every model request records tenant, session, optional agent, configured model, duration, outcome and available token counts. Costs remain null unless both pricing values and a source URL are supplied. A timed-out request retains its budget reservation because its billing outcome is unknown. Structured tool inputs are validated again on the server; schemas sent to Bedrock omit unsupported numeric constraints while the full server schema retains them.

Conversation messages are individual bounded DynamoDB entities. The default retention is 30 days, configurable with `KRONO_MESSAGE_RETENTION_DAYS`. Conversation memory contains public user/assistant messages, not reasoning blocks. Message, request and corresponding version records have TTL fields; DynamoDB deletion is asynchronous. Audit events contain action metadata rather than raw chat. Do not enter signing secrets into conversations. Profile preferences are persisted only through a reviewed approval. A failed/timed-out conversation is not blindly replayed; inspect its request record and actual draft/audit state first.

## Tenant and runtime boundaries

| Store                  | Keys and purpose                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control table          | `TENANT#<verified Cognito sub>`, resource-specific sort keys for profiles, identities, agent specs, immutable versions, deployments, conversation/messages, usage, approvals and audit. Every repository operation requires the authenticated scope. |
| Agent-control table    | Separate exact `TENANT#sub#AGENT#id` configuration and `TENANT#sub#POLICY` emergency partition. Workers can read/check these; they cannot write them.                                                                                                |
| Runtime table          | Exact tenant/agent partition for heartbeat, run evidence, inbox, model requests, execution manifests, fencing lease and checkpoint pointer.                                                                                                          |
| Encrypted S3 artifacts | `tenants/sub/agents/id/` immutable checkpoint objects. A lease-checked DynamoDB transaction advances the pointer; a stale worker cannot overwrite a newer checkpoint.                                                                                |

Each deployment gets a distinct IAM task role bounded to its exact DynamoDB partition, read-only tenant emergency policy and S3 prefix. No agent role can read user profiles, conversations, another agent's ledger, or arbitrary Secrets Manager values. This uses concrete IAM conditions, not an assumption that ECS task tags become principal tags. [DynamoDB fine-grained IAM conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html).

Cognito access tokens are checked for signature, issuer, client ID, expiry and token type using AWS's JWT verifier. Browser sessions use HttpOnly, SameSite cookies and CSRF protection. Passwords, request bodies, bearer tokens and cookies are excluded from application logs. Email registration/verification, password reset, refresh and logout use Cognito APIs. Access JWT verification is local; global logout revokes refresh sessions, while an already stolen access JWT can remain valid until its short expiry. Optional OAuth providers and MFA challenge handling require further configuration/UI work.

Agent definitions are declarative and restricted to the approved Python image/template. No shell, arbitrary image, contract call, infrastructure action or arbitrary user code is accepted. Version-bound digest approvals are consumed before provisioning or controls. Step Functions creates a named CloudFormation workload; health reporting requires ECS HEALTHY status and a fresh worker heartbeat. The new worker remains inert until activation. Failed upgrades preserve the previous deployment paused, and require review before resuming. Unknown controls/executions are recorded separately and are not blindly resent.

The emergency stop first writes a tenant policy barrier. Every new cloud execution reservation checks that policy, the active deployment, current permissions, runtime expiry and lease in one DynamoDB transaction. Clearing the stop first pauses deployed agents and does not resume them. Accepted operations already in progress follow HOLD_AND_REVIEW; the stop does not blindly send liquidation swaps. Lowering a profile risk policy pauses active agents before saving it; old deployments cannot resume with a policy exceeding the new profile.

Private workloads use outbound HTTPS and a DNS firewall allowlist for AWS, supported exchanges, news and model providers. Network controls rely on reviewed, immutable container images and restrict traffic by security group. Secrets Manager protects the origin access secret. Linked exchange credentials are encrypted by the Product API when the operator configures its credential key. The Product API and paper worker use that key.

## Quotas, accounting and retained resources

Defaults are three concurrent agents/user, twenty agent definitions/user, 256 CPU units and 1024 MiB/template, one-hour deployment budgets, 30-minute idle shutdown, 100,000 model tokens/user/day and 14,400 reserved runtime seconds/user/day. Schemas cap CPU/memory, intervals and runtime duration. Quotas are reserved atomically, including upgrades. A stopped agent must reserve a slot again before restarting. Explicitly deleting an undeployed draft releases its definition quota while retaining audit/version evidence. Configuration changes and risk bounds are versioned and audited.

An EventBridge-triggered janitor independently scales expired/stopped agent services to zero. A worker also refuses fills beyond its budget. CloudWatch tracks service CPU/memory, errors, queue dead letters and janitor health. Monthly Budget notifications are alerts, **not an account spending cap**. Activate the `Project` cost-allocation tag. NAT gateways, ALB, DNS firewall, KMS, Cognito plans, logs and idle infrastructure can incur costs even with no agents. Compute reservations are conservative allocation accounting, not an AWS invoice estimate.

The Aurora cluster uses a final snapshot policy and production deletion protection. DynamoDB tables, buckets, encryption keys, logs and ECR repositories use retain policies. Deleting a simulation agent requests deletion of its workload stack and keeps its audit and ledger evidence. Failed or obsolete workload stacks and retained artifacts require operator review and lifecycle cleanup. An unresolved simulation requires reconciliation of its checkpoint and execution manifest before it can resume.

## Actual capabilities and remaining boundaries

- Five initial registered strategies: Momentum, Mean Reversion, Trend Following, Breakout, Arbitrage Detection. The last is ineligible without verified routes. The former news-aware function remains for compatibility/backtests; news is supporting intelligence rather than a sixth built-in.
- Versioned KRONO-managed market-research/news-monitor templates and user-created specifications use the same isolated lifecycle. Template instantiation creates an owned draft, never a fictitious deployment. The builder can inspect and instantiate them conversationally.
- Python indicator/strategy/risk/execution code is reused. Ranking is recalculated from measured features, strategy evaluation, valid holdout performance when available, disclosed simulation costs and bounded model advice. Switching preserves owned-position exit management and applies hold/cooldown policies.
- Research agents publish opportunities into an encrypted queue. The broker resolves a stored record and verifies ownership/current deployment before delivering it to explicitly linked agents. The trading graph records the opportunity reference and still independently generates its signal and risk result.
- Each isolated cloud simulation agent has its own ledger and virtual initial equity. Combined simulation P&L sums those ledgers when snapshots are fresh and complete. The Product API serves the paper ledger and linked spot exchange accounts.
- Hourly strategies use the configured reference markets. Paper market search includes eligible spot listings from the venue. Four-hour and daily charts are descriptive.
- Live exchange execution (see [live trading design](LIVE_TRADING.md)), exchange PAPER mode, OAuth/MFA challenges, custom code sandboxes, ElastiCache, time-series archival, OpenTelemetry tracing, paid subscription billing and a dedicated WebSocket service remain unavailable. Core persistence uses DynamoDB/S3 rather than provisioning unused Redis infrastructure.

## AWS acceptance run

After deploying real images and publishing the cloud frontend:

1. Register and verify two accounts through Cognito. Check login/reset/logout. Use separate browser contexts and confirm cross-user profile/agent/conversation/history URLs return denial.
2. Create a conservative BTC agent conversationally; inspect its persisted specification, permissions, risk policy and audit. Save a preference through a reviewed action, start another conversation and confirm it is retrieved.
3. Review and explicitly authorize a SIMULATION deployment. Verify the named Step Functions execution, CloudFormation stack, ECS service/task, exact IAM role, CloudWatch stream and fresh heartbeat. A queued/provisioning response does not pass this check.
4. Pause/resume/restart/stop and check actual desired/running tasks and heartbeat state. Upgrade a configuration and deliberately fail a new image in a disposable development environment; verify the original checkpoint and paused deployment remain available.
5. Link an owned research agent to a trading agent. Verify broker delivery, opportunity evidence in the actual graph, independent risk decisions and absence of duplicate fills.
6. Exercise the tenant emergency barrier during an in-flight analysis, quota exhaustion, model denial/timeout and worker restart with an unresolved execution manifest. Verify no blind replay.
7. For simulation accounting and position closure, run the existing backend/browser suites without funds. A cloud lifecycle check does not substitute for that financial ledger test, or for a live swap test.

Until these account-level checks are run, report them as **pending**, not passed. Record sanitized outputs and timestamps; keep raw tokens, credentials, emails and private runtime artifacts out of Git.
