CREATE TABLE platform_strategies (
    owner_id UUID NOT NULL REFERENCES platform_users (id),
    id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, id)
);

CREATE INDEX platform_strategies_active ON platform_strategies (owner_id, id)
    WHERE archived_at IS NULL;

CREATE TABLE platform_strategy_versions (
    owner_id UUID NOT NULL,
    strategy_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    document JSONB NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, strategy_id, version),
    FOREIGN KEY (owner_id, strategy_id) REFERENCES platform_strategies (owner_id, id)
);
