-- More exchanges, quantity-sized live orders, and paper agents promoted to live trading.
ALTER TABLE live_connections DROP CONSTRAINT live_connections_exchange_check;
ALTER TABLE live_connections ADD CONSTRAINT live_connections_exchange_check
    CHECK (exchange IN ('binance', 'bybit', 'okx'));

ALTER TABLE live_orders ALTER COLUMN quote_amount DROP NOT NULL;
-- Bybit and OKX order IDs are long strings.
ALTER TABLE live_orders ALTER COLUMN exchange_order_id TYPE TEXT;
ALTER TABLE live_orders DROP CONSTRAINT live_orders_quote_amount_check;
ALTER TABLE live_orders
    ADD COLUMN quantity NUMERIC,
    ADD COLUMN agent_id UUID,
    ADD COLUMN paper_order_id UUID UNIQUE,
    ADD CONSTRAINT live_orders_size_check CHECK (
        (quote_amount IS NOT NULL AND quote_amount > 0 AND quantity IS NULL)
        OR (quantity IS NOT NULL AND quantity > 0 AND quote_amount IS NULL)
    ),
    ADD CONSTRAINT live_orders_agent_fk FOREIGN KEY (owner_id, agent_id)
        REFERENCES paper_agents (owner_id, id);
CREATE INDEX live_orders_agent ON live_orders (owner_id, agent_id, created_at) WHERE agent_id IS NOT NULL;

-- A promoted agent mirrors each paper fill to its linked exchange, scaled to live_budget.
ALTER TABLE paper_agents
    ADD COLUMN live_connection_id UUID,
    ADD COLUMN live_budget NUMERIC CHECK (live_budget > 0 AND live_budget <= 100000),
    ADD COLUMN live_since TIMESTAMPTZ,
    ADD CONSTRAINT paper_agents_live_fk FOREIGN KEY (owner_id, live_connection_id)
        REFERENCES live_connections (owner_id, id),
    ADD CONSTRAINT paper_agents_live_shape CHECK (
        (live_connection_id IS NULL) = (live_budget IS NULL)
        AND (live_connection_id IS NULL) = (live_since IS NULL)
    );
CREATE INDEX paper_agents_live ON paper_agents (live_connection_id) WHERE live_connection_id IS NOT NULL;
