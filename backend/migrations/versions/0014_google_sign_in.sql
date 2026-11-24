-- Google sign-in for self-hosted accounts, and a record of every sign-in.
-- An account may have a password, a linked Google identity, or both.
ALTER TABLE platform_credentials ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE platform_credentials ADD COLUMN google_subject TEXT UNIQUE
    CHECK (google_subject IS NULL OR length(google_subject) BETWEEN 1 AND 255);
ALTER TABLE platform_credentials ADD COLUMN last_sign_in_at TIMESTAMPTZ;
ALTER TABLE platform_credentials ADD CONSTRAINT platform_credentials_has_method
    CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL);

CREATE TABLE platform_sign_ins (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES platform_users (id),
    method TEXT NOT NULL CHECK (method IN ('password', 'google', 'registration')),
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_sign_ins_user ON platform_sign_ins (user_id, at DESC);
