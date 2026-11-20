CREATE TABLE platform_watchlist (
    owner_id UUID NOT NULL REFERENCES platform_users (id),
    asset TEXT NOT NULL CHECK (asset IN ('BTC', 'ETH', 'SOL')),
    PRIMARY KEY (owner_id, asset)
);

CREATE TABLE paper_worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    seen_at TIMESTAMPTZ NOT NULL
);
