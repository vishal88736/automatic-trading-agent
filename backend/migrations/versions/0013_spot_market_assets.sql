ALTER TABLE paper_ledger_entries
    DROP CONSTRAINT paper_ledger_entry_shape,
    ADD CONSTRAINT paper_ledger_entry_shape CHECK (
        (kind = 'OPENING_CREDIT' AND amount > 0 AND amount <= 100000000
            AND order_id IS NULL AND asset IS NULL AND quantity IS NULL AND price IS NULL
            AND fee IS NULL AND cost_delta IS NULL AND realized_pnl IS NULL
            AND market_at IS NULL AND market_source IS NULL)
        OR
        (kind IN ('BUY', 'SELL') AND order_id IS NOT NULL
            AND asset IS NOT NULL AND asset ~ '^[A-Z0-9]{2,20}$'
            AND quantity IS NOT NULL AND price IS NOT NULL AND price > 0 AND price <= 100000000
            AND fee IS NOT NULL AND fee >= 0 AND fee <= 100000000
            AND cost_delta IS NOT NULL AND realized_pnl IS NOT NULL
            AND market_at IS NOT NULL AND market_source IS NOT NULL
            AND (CASE WHEN kind = 'BUY'
                THEN amount < 0 AND quantity > 0 AND cost_delta = -amount AND realized_pnl = 0
                ELSE amount > 0 AND quantity < 0 AND cost_delta <= 0
                     AND realized_pnl = amount + cost_delta END))
    );

ALTER TABLE platform_watchlist
    DROP CONSTRAINT platform_watchlist_asset_check,
    ADD CONSTRAINT platform_watchlist_asset_check CHECK (asset ~ '^[A-Z0-9]{2,20}$');

ALTER TABLE live_orders
    DROP CONSTRAINT live_orders_asset_check,
    ADD CONSTRAINT live_orders_asset_check CHECK (asset ~ '^[A-Z0-9]{2,20}$');
