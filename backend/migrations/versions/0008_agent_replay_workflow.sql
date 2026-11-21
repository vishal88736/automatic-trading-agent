-- Keep the original request immutable while the current validation report advances.
ALTER TABLE paper_agents ALTER COLUMN report_id DROP NOT NULL;
ALTER TABLE paper_agents ADD COLUMN initial_report_id UUID;
UPDATE paper_agents SET initial_report_id = report_id;
ALTER TABLE paper_agents ADD FOREIGN KEY (owner_id, initial_report_id)
    REFERENCES platform_backtests (owner_id, id);
ALTER TABLE paper_agents ADD COLUMN next_review_at TIMESTAMPTZ;
UPDATE paper_agents SET next_review_at = now() + interval '7 days' WHERE stage = 'MONITOR';
ALTER TABLE paper_agents ADD CHECK (stage <> 'MONITOR' OR report_id IS NOT NULL);
