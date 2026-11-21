-- Linked exchange accounts. Secrets are AES-GCM ciphertext; revoking erases them.
CREATE TABLE live_connections (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES platform_users (id),
    exchange TEXT NOT NULL CHECK (exchange IN ('binance')),
    environment TEXT NOT NULL CHECK (environment IN ('testnet', 'live')),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
    key_hint TEXT NOT NULL,
    nonce BYTEA,
    ciphertext BYTEA,
    permissions JSONB NOT NULL DEFAULT '{}',
    max_order_usdt NUMERIC NOT NULL CHECK (max_order_usdt > 0 AND max_order_usdt <= 100000),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, id),
    CHECK ((status = 'REVOKED') = (ciphertext IS NULL))
);
CREATE INDEX live_connections_owner ON live_connections (owner_id, created_at DESC);

-- Every live order Krono submits. The client order ID makes submission idempotent.
CREATE TABLE live_orders (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    request_key UUID NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    exchange_order_id BIGINT,
    asset TEXT NOT NULL CHECK (asset IN ('BTC', 'ETH', 'SOL')),
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quote_amount NUMERIC NOT NULL CHECK (quote_amount > 0),
    status TEXT NOT NULL,
    executed_qty NUMERIC,
    quote_filled NUMERIC,
    average_price NUMERIC,
    fees JSONB NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, connection_id) REFERENCES live_connections (owner_id, id),
    UNIQUE (owner_id, request_key)
);
CREATE INDEX live_orders_connection ON live_orders (owner_id, connection_id, created_at DESC);
