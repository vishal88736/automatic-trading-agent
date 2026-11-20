ALTER TABLE paper_accounts ADD COLUMN emergency_stop BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE paper_orders (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    account_id UUID NOT NULL,
    epoch BIGINT NOT NULL,
    request_key UUID NOT NULL,
    request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'FILLED', 'REJECTED', 'CANCELLED')),
    reason TEXT,
    reserved_cash NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_cash >= 0),
    reserved_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (owner_id, account_id, epoch)
        REFERENCES paper_account_epochs (owner_id, account_id, epoch),
    UNIQUE (owner_id, request_key),
    UNIQUE (owner_id, account_id, epoch, id),
    CHECK (status = 'OPEN' OR (reserved_cash = 0 AND reserved_quantity = 0))
);
CREATE INDEX paper_order_history ON paper_orders (owner_id, epoch, created_at DESC, id DESC);
CREATE INDEX paper_order_open ON paper_orders (owner_id, epoch) WHERE status = 'OPEN';

ALTER TABLE paper_ledger_entries
    DROP CONSTRAINT paper_ledger_entries_kind_check,
    DROP CONSTRAINT paper_ledger_entries_amount_check,
    DROP CONSTRAINT paper_ledger_entries_owner_id_account_id_epoch_kind_key,
    ADD COLUMN order_id UUID,
    ADD COLUMN asset TEXT,
    ADD COLUMN quantity NUMERIC,
    ADD COLUMN price NUMERIC,
    ADD COLUMN fee NUMERIC,
    ADD COLUMN cost_delta NUMERIC,
    ADD COLUMN realized_pnl NUMERIC,
    ADD COLUMN market_at TIMESTAMPTZ,
    ADD COLUMN market_source TEXT,
    ADD CONSTRAINT paper_ledger_order_fk FOREIGN KEY (owner_id, account_id, epoch, order_id)
        REFERENCES paper_orders (owner_id, account_id, epoch, id),
    ADD CONSTRAINT paper_ledger_cash_precision CHECK (amount = trunc(amount, 6)),
    ADD CONSTRAINT paper_ledger_entry_shape CHECK (
        (kind = 'OPENING_CREDIT' AND amount > 0 AND amount <= 100000000
            AND order_id IS NULL AND asset IS NULL AND quantity IS NULL AND price IS NULL
            AND fee IS NULL AND cost_delta IS NULL AND realized_pnl IS NULL
            AND market_at IS NULL AND market_source IS NULL)
        OR
        (kind IN ('BUY', 'SELL') AND order_id IS NOT NULL
            AND asset IS NOT NULL AND asset IN ('BTC', 'ETH', 'SOL')
            AND quantity IS NOT NULL AND price IS NOT NULL AND price > 0 AND price <= 100000000
            AND fee IS NOT NULL AND fee >= 0 AND fee <= 100000000
            AND cost_delta IS NOT NULL AND realized_pnl IS NOT NULL
            AND market_at IS NOT NULL AND market_source IS NOT NULL
            AND (CASE WHEN kind = 'BUY'
                THEN amount < 0 AND quantity > 0 AND cost_delta = -amount AND realized_pnl = 0
                ELSE amount > 0 AND quantity < 0 AND cost_delta <= 0
                     AND realized_pnl = amount + cost_delta END))
    );

CREATE UNIQUE INDEX paper_ledger_one_opening_credit ON paper_ledger_entries (owner_id, account_id, epoch)
    WHERE kind = 'OPENING_CREDIT';
CREATE UNIQUE INDEX paper_ledger_one_fill ON paper_ledger_entries (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX paper_ledger_epoch ON paper_ledger_entries (owner_id, epoch, id DESC);

CREATE FUNCTION paper_reject_ledger_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Paper ledger is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER paper_ledger_immutable BEFORE UPDATE OR DELETE ON paper_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION paper_reject_ledger_mutation();
CREATE TRIGGER paper_ledger_no_truncate BEFORE TRUNCATE ON paper_ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION paper_reject_ledger_mutation();

CREATE TABLE paper_equity_snapshots (
    owner_id UUID NOT NULL,
    account_id UUID NOT NULL,
    epoch BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    equity NUMERIC NOT NULL CHECK (equity >= 0),
    PRIMARY KEY (owner_id, account_id, epoch, observed_at),
    FOREIGN KEY (owner_id, account_id, epoch)
        REFERENCES paper_account_epochs (owner_id, account_id, epoch)
);
