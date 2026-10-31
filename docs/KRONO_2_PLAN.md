# KRONO 2.0 implementation

The existing terminal is React/TypeScript with a Python FastAPI/LangGraph runtime, deterministic Decimal risk checks, SQLite execution intents and a reconciled simulation ledger. Its localhost authentication and global database are deliberately not reused as a public multi-tenant API.

1. Add an authenticated TypeScript control plane under `backend/src`, Cognito access-token verification, tenant-scoped DynamoDB repositories, versioned profiles and configuration. Keep the original terminal available locally.
2. Route platform model requests through one Bedrock Converse provider, with bounded tools, server-side schemas, usage reservations and configurable prompts. Default to `minimax.minimax-m2.5` in `ap-south-1`.
3. Implement conversational agent drafts, immutable revisions, digest-bound deployment approvals and actual AWS runtime lifecycle operations. Cloud status must come from ECS and worker heartbeats.
4. Define development, staging and production CDK stacks: private API and agent tasks, Cognito, DynamoDB, encrypted artifacts, ECR, deployment workflows, queues, scheduling, monitoring and cost controls. Agent roles must have an exact tenant/agent DynamoDB partition and S3 prefix; they cannot read profiles or conversations.
5. Adapt the Python strategy framework into five built-ins, add adaptive ranking and preserve the independent risk/execution pipeline. Keep HSKSwap live execution disabled until its routing and signing requirements are verified.
6. Extend the existing design with a platform workspace, authentication, conversational creation and real deployment monitoring. Retain the in-progress chart/Trading Desk work.
7. Validate isolation, schema and permission failures, concurrency/idempotency, model usage, runtime recovery, strategy adaptation and simulation. Synthesize infrastructure and build containers when the local tools support it.

AWS credentials, account/domain and an operating budget are supplied by the operator through environment configuration. This implementation must not report cloud deployments, account model access or blockchain transactions as verified before those checks actually run.
