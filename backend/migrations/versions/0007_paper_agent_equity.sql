CREATE TABLE paper_agent_equity (
    owner_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    equity NUMERIC NOT NULL,
    PRIMARY KEY (owner_id, agent_id, observed_at),
    FOREIGN KEY (owner_id, agent_id) REFERENCES paper_agents (owner_id, id)
);
