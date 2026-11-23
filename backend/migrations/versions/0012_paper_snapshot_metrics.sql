ALTER TABLE paper_equity_snapshots
    ADD COLUMN available_cash NUMERIC,
    ADD COLUMN unrealized_pnl NUMERIC,
    ADD COLUMN realized_pnl NUMERIC,
    ADD COLUMN daily_pnl NUMERIC,
    ADD COLUMN drawdown NUMERIC;
