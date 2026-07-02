-- Visionary POS sync schema
-- Append-only business events merge by union-on-id.
-- Mutable records merge by last server write.

CREATE TABLE IF NOT EXISTS devices (
  device_id    text PRIMARY KEY,
  terminal_uuid text UNIQUE,
  name         text NOT NULL,
  branch_id    text,
  token_hash   text NOT NULL,
  terminal_secret_hash text,
  app_version text,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (upper(status) IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CONSTRAINT devices_token_hash_is_bcrypt CHECK (token_hash ~ '^\$2[aby]\$')
);

CREATE INDEX IF NOT EXISTS devices_status_idx ON devices (status);
CREATE INDEX IF NOT EXISTS devices_branch_status_idx ON devices (branch_id, status);
CREATE INDEX IF NOT EXISTS devices_terminal_uuid_idx ON devices (terminal_uuid);

CREATE TABLE IF NOT EXISTS terminal_activation_codes (
  id           text PRIMARY KEY,
  code_hash    text NOT NULL UNIQUE,
  branch_id    text NOT NULL,
  terminal_name text NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by_terminal_uuid text,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS terminal_activation_codes_active_idx ON terminal_activation_codes (expires_at, used_at, revoked_at);

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
CREATE UNIQUE INDEX IF NOT EXISTS records_product_sku_unique_idx
  ON records (lower((payload->>'sku')))
  WHERE type = 'product'
    AND deleted = false
    AND payload->>'sku' IS NOT NULL
    AND payload->>'sku' <> '';

CREATE TABLE IF NOT EXISTS barcode_catalog (
  id           text PRIMARY KEY,
  barcode      text NOT NULL,
  barcode_type text NOT NULL DEFAULT 'code128',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS barcode_catalog_barcode_unique_idx
  ON barcode_catalog (lower(barcode));
CREATE INDEX IF NOT EXISTS barcode_catalog_barcode_lookup_idx
  ON barcode_catalog (barcode);

CREATE TABLE IF NOT EXISTS products (
  id                 text PRIMARY KEY,
  barcode_catalog_id text NOT NULL REFERENCES barcode_catalog(id),
  name               text NOT NULL,
  sku                text,
  category_id        text,
  brand              text,
  unit               text,
  cost_price         numeric(12, 2) NOT NULL DEFAULT 0,
  image              text,
  description        text,
  status             text NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_barcode_catalog_idx ON products (barcode_catalog_id);
CREATE INDEX IF NOT EXISTS products_sku_idx ON products (sku);
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique_idx
  ON products (lower(sku))
  WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS products_status_idx ON products (status);

CREATE TABLE IF NOT EXISTS branch_products (
  id             text PRIMARY KEY,
  product_id     text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id      text NOT NULL,
  selling_price      numeric(12, 2) NOT NULL DEFAULT 0,
  stock              integer NOT NULL DEFAULT 0,
  reorder_level      integer NOT NULL DEFAULT 0,
  shelf_location     text,
  availability       boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS branch_products_branch_product_unique_idx
  ON branch_products (branch_id, product_id);
CREATE INDEX IF NOT EXISTS branch_products_product_idx ON branch_products (product_id);
CREATE INDEX IF NOT EXISTS branch_products_branch_idx ON branch_products (branch_id);
CREATE INDEX IF NOT EXISTS branch_products_availability_idx ON branch_products (availability);

CREATE TABLE IF NOT EXISTS credentials (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('admin', 'user', 'cashier')),
  name          text,
  email         text,
  phone         text,
  pin_hash      text,
  pin_lookup_hash text,
  password_hash text,
  branch_id     text,
  rights        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active',
  email_verified boolean NOT NULL DEFAULT false,
  last_login    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credential_status_valid CHECK (status IN ('active', 'inactive', 'deleted')),
  CONSTRAINT credential_has_auth_secret CHECK (pin_hash IS NOT NULL OR password_hash IS NOT NULL),
  CONSTRAINT credential_pin_hash_is_bcrypt CHECK (pin_hash IS NULL OR pin_hash ~ '^\$2[aby]\$'),
  CONSTRAINT credential_password_hash_is_bcrypt CHECK (password_hash IS NULL OR password_hash ~ '^\$2[aby]\$')
);

CREATE UNIQUE INDEX IF NOT EXISTS credentials_email_idx ON credentials (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS credentials_phone_idx ON credentials (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS credentials_status_idx ON credentials (status);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_pin_lookup_hash_unique_idx
  ON credentials (pin_lookup_hash)
  WHERE pin_lookup_hash IS NOT NULL AND status <> 'deleted';

CREATE TABLE IF NOT EXISTS user_sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  device_id    text,
  terminal_uuid text,
  device_name  text,
  ip_address   text,
  login_time   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions (user_id, is_active);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);
CREATE INDEX IF NOT EXISTS user_sessions_terminal_idx ON user_sessions (terminal_uuid, is_active);
CREATE INDEX IF NOT EXISTS user_sessions_device_idx ON user_sessions (device_id, is_active);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id          bigserial PRIMARY KEY,
  user_id     text,
  event       text NOT NULL,
  device_name text,
  ip_address  text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_audit_log_user_idx ON auth_audit_log (user_id);
CREATE INDEX IF NOT EXISTS auth_audit_log_created_idx ON auth_audit_log (created_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              text PRIMARY KEY,
  user_id         text REFERENCES credentials(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  requested_email text NOT NULL,
  ip_address      text,
  used_at         timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_lookup_idx ON password_reset_tokens (token_hash, used_at, expires_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_rate_idx ON password_reset_tokens (requested_email, ip_address, created_at);

CREATE TABLE IF NOT EXISTS user_fingerprints (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  finger_template          text NOT NULL,
  finger_template_hash     text NOT NULL,
  device_serial            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_fingerprints_user_idx ON user_fingerprints (user_id);
CREATE INDEX IF NOT EXISTS user_fingerprints_hash_idx ON user_fingerprints (finger_template_hash);

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
