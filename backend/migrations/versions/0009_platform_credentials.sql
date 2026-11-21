-- Self-hosted sign-in. Cognito deployments never write here; their subjects stay in Cognito.
CREATE TABLE platform_credentials (
    user_id UUID PRIMARY KEY REFERENCES platform_users (id),
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public leaderboard reads each agent's latest mark.
CREATE INDEX paper_agent_equity_latest ON paper_agent_equity (owner_id, agent_id, observed_at DESC);
