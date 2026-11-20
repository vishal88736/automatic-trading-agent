CREATE TABLE paper_agents (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    account_id UUID NOT NULL,
    epoch BIGINT NOT NULL,
    name TEXT NOT NULL,
    strategy_id UUID NOT NULL,
    strategy_version INTEGER NOT NULL,
    report_id UUID NOT NULL,
    capital NUMERIC NOT NULL CHECK (capital > 0 AND capital <= 100000),
    max_drawdown NUMERIC NOT NULL CHECK (max_drawdown > 0 AND max_drawdown <= 0.10),
    max_daily_loss NUMERIC NOT NULL CHECK (max_daily_loss > 0 AND max_daily_loss <= 0.03),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 10 AND 3600),
    status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED', 'FAILED')),
    stage TEXT NOT NULL CHECK (stage IN ('VALIDATE', 'MONITOR')),
    next_run TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    heartbeat TIMESTAMPTZ,
    failures INTEGER NOT NULL DEFAULT 0,
    last_candle TIMESTAMPTZ,
    last_quote TIMESTAMPTZ,
    peak_price NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, account_id, epoch)
        REFERENCES paper_account_epochs (owner_id, account_id, epoch),
    FOREIGN KEY (owner_id, strategy_id, strategy_version)
        REFERENCES platform_strategy_versions (owner_id, strategy_id, version),
    FOREIGN KEY (owner_id, report_id) REFERENCES platform_backtests (owner_id, id),
    UNIQUE (owner_id, account_id, epoch, id),
    UNIQUE (owner_id, id)
);
CREATE INDEX paper_agents_due ON paper_agents (next_run) WHERE status = 'RUNNING';
CREATE INDEX paper_agents_owner ON paper_agents (owner_id, created_at DESC);

ALTER TABLE paper_orders ADD COLUMN agent_id UUID;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_agent_fk
    FOREIGN KEY (owner_id, account_id, epoch, agent_id)
    REFERENCES paper_agents (owner_id, account_id, epoch, id);
CREATE INDEX paper_orders_agent ON paper_orders (owner_id, agent_id, epoch);
ALTER TABLE paper_orders ADD COLUMN next_check TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX paper_limits_due ON paper_orders (next_check) WHERE status = 'OPEN';

CREATE TABLE paper_agent_events (
    seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL,
    detail JSONB NOT NULL,
    FOREIGN KEY (owner_id, agent_id) REFERENCES paper_agents (owner_id, id)
);
CREATE INDEX paper_agent_timeline ON paper_agent_events (owner_id, agent_id, seq DESC);
