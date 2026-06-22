-- Visionary POS sync schema
-- Append-only business events merge by union-on-id.
-- Mutable records merge by last server write.

CREATE TABLE IF NOT EXISTS devices (
  device_id    text PRIMARY KEY,
  name         text NOT NULL,
  branch_id    text,
  token_hash   text NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CONSTRAINT devices_token_hash_is_bcrypt CHECK (token_hash ~ '^\$2[aby]\$')
);

CREATE TABLE IF NOT EXISTS events (
  id         text PRIMARY KEY,
  type       text NOT NULL,
  branch_id  text,
  device_id  text REFERENCES devices(device_id),
  client_ts  bigint,
  server_ts  bigint NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS events_server_ts_idx ON events (server_ts);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
CREATE INDEX IF NOT EXISTS events_branch_idx ON events (branch_id);

CREATE TABLE IF NOT EXISTS records (
  id          text NOT NULL,
  type        text NOT NULL,
  branch_id   text,
  device_id   text REFERENCES devices(device_id),
  updated_at  bigint NOT NULL,
  server_ts   bigint NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (type, id),
  CONSTRAINT user_records_have_no_plain_credentials CHECK (
    type <> 'user'
    OR (
      NOT (payload ? 'password')
      AND NOT (payload ? 'pin')
      AND NOT (payload ? 'plainPassword')
      AND NOT (payload ? 'plainPin')
    )
  )
);

CREATE INDEX IF NOT EXISTS records_server_ts_idx ON records (server_ts);
CREATE INDEX IF NOT EXISTS records_type_idx ON records (type);
CREATE INDEX IF NOT EXISTS records_branch_idx ON records (branch_id);

CREATE TABLE IF NOT EXISTS credentials (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('admin', 'user', 'cashier')),
  name          text,
  email         text,
  phone         text,
  pin_hash      text,
  password_hash text,
  branch_id     text,
  rights        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_has_auth_secret CHECK (pin_hash IS NOT NULL OR password_hash IS NOT NULL),
  CONSTRAINT credential_pin_hash_is_bcrypt CHECK (pin_hash IS NULL OR pin_hash ~ '^\$2[aby]\$'),
  CONSTRAINT credential_password_hash_is_bcrypt CHECK (password_hash IS NULL OR password_hash ~ '^\$2[aby]\$')
);

CREATE UNIQUE INDEX IF NOT EXISTS credentials_email_idx ON credentials (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS credentials_phone_idx ON credentials (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_verification_codes (
  id bigserial PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  target text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL DEFAULT 'owner_signup',
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_verification_code_hash_is_bcrypt CHECK (code_hash ~ '^\$2[aby]\$')
);

CREATE INDEX IF NOT EXISTS auth_verification_codes_lookup_idx
  ON auth_verification_codes (channel, target, purpose, consumed_at, expires_at);
