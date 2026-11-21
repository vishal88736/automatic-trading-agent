CREATE TABLE platform_backtests (
    owner_id UUID NOT NULL,
    id UUID NOT NULL,
    strategy_id UUID NOT NULL,
    strategy_version INTEGER NOT NULL,
    dataset JSONB NOT NULL CHECK (jsonb_typeof(dataset) = 'object'),
    report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, id),
    FOREIGN KEY (owner_id, strategy_id, strategy_version)
        REFERENCES platform_strategy_versions (owner_id, strategy_id, version)
);

CREATE INDEX platform_backtests_strategy ON platform_backtests
    (owner_id, strategy_id, strategy_version, created_at DESC);
