CREATE TABLE platform_users (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE paper_accounts (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL UNIQUE REFERENCES platform_users (id),
    currency TEXT NOT NULL DEFAULT 'USDT' CHECK (currency = 'USDT'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, id)
);

CREATE TABLE paper_account_epochs (
    owner_id UUID NOT NULL,
    account_id UUID NOT NULL,
    epoch BIGINT NOT NULL CHECK (epoch > 0),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ CHECK (closed_at >= opened_at),
    PRIMARY KEY (owner_id, account_id, epoch),
    FOREIGN KEY (owner_id, account_id) REFERENCES paper_accounts (owner_id, id)
);

CREATE UNIQUE INDEX paper_account_one_open_epoch
    ON paper_account_epochs (owner_id, account_id) WHERE closed_at IS NULL;

CREATE TABLE paper_ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id UUID NOT NULL,
    account_id UUID NOT NULL,
    epoch BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'OPENING_CREDIT'),
    amount NUMERIC NOT NULL CHECK (
        amount > 0 AND amount <= 100000000 AND amount = trunc(amount, 6)
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, account_id, epoch)
        REFERENCES paper_account_epochs (owner_id, account_id, epoch),
    UNIQUE (owner_id, account_id, epoch, kind)
);
