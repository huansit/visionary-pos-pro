CREATE TABLE IF NOT EXISTS devices (
  device_id    varchar(191) PRIMARY KEY,
  terminal_uuid varchar(191) UNIQUE,
  name         varchar(255) NOT NULL,
  branch_id    varchar(191),
  token_hash   varchar(255) NOT NULL,
  terminal_secret_hash varchar(64),
  app_version varchar(80),
  status       enum('ACTIVE','DISABLED','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  revoked_at   datetime,
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at datetime,
  INDEX devices_status_idx (status),
  INDEX devices_branch_status_idx (branch_id, status)
);

CREATE TABLE IF NOT EXISTS terminal_activation_codes (
  id           varchar(191) PRIMARY KEY,
  code_hash    varchar(64) NOT NULL UNIQUE,
  branch_id    varchar(191) NOT NULL,
  terminal_name varchar(255) NOT NULL,
  created_by   varchar(191),
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   datetime NOT NULL,
  used_at      datetime,
  used_by_terminal_uuid varchar(191),
  revoked_at   datetime,
  INDEX terminal_activation_codes_active_idx (expires_at, used_at, revoked_at)
);

CREATE TABLE IF NOT EXISTS events (
  id         varchar(191) PRIMARY KEY,
  type       varchar(80) NOT NULL,
  branch_id  varchar(191),
  device_id  varchar(191),
  client_ts  bigint,
  server_ts  bigint NOT NULL,
  payload    json NOT NULL,
  CONSTRAINT events_device_fk FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX events_server_ts_idx ON events (server_ts);
CREATE INDEX events_type_idx ON events (type);
CREATE INDEX events_branch_idx ON events (branch_id);

CREATE TABLE IF NOT EXISTS records (
  id          varchar(191) NOT NULL,
  type        varchar(80) NOT NULL,
  branch_id   varchar(191),
  device_id   varchar(191),
  updated_at  bigint NOT NULL,
  server_ts   bigint NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  payload     json NOT NULL,
  PRIMARY KEY (type, id),
  CONSTRAINT records_device_fk FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX records_server_ts_idx ON records (server_ts);
CREATE INDEX records_type_idx ON records (type);
CREATE INDEX records_branch_idx ON records (branch_id);

CREATE TABLE IF NOT EXISTS barcode_catalog (
  id           varchar(191) PRIMARY KEY,
  barcode      varchar(191) NOT NULL UNIQUE,
  barcode_type varchar(80) NOT NULL DEFAULT 'code128',
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX barcode_catalog_barcode_lookup_idx
  ON barcode_catalog (barcode);

CREATE TABLE IF NOT EXISTS products (
  id                 varchar(191) PRIMARY KEY,
  branch_id          varchar(191) NOT NULL,
  barcode_catalog_id varchar(191) NOT NULL,
  name               varchar(255) NOT NULL,
  category_id        varchar(191),
  cost_price         decimal(12, 2) NOT NULL DEFAULT 0,
  selling_price      decimal(12, 2) NOT NULL DEFAULT 0,
  stock              int NOT NULL DEFAULT 0,
  reorder_level      int NOT NULL DEFAULT 0,
  image              text,
  status             varchar(40) NOT NULL DEFAULT 'active',
  created_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_barcode_catalog_fk FOREIGN KEY (barcode_catalog_id) REFERENCES barcode_catalog(id),
  CONSTRAINT products_branch_barcode_catalog_unique UNIQUE (branch_id, barcode_catalog_id)
);

CREATE INDEX products_barcode_catalog_idx ON products (barcode_catalog_id);
CREATE INDEX products_branch_idx ON products (branch_id);
CREATE INDEX products_status_idx ON products (status);

CREATE TABLE IF NOT EXISTS credentials (
  id            varchar(191) PRIMARY KEY,
  kind          enum('admin', 'user', 'cashier') NOT NULL,
  name          varchar(255),
  email         varchar(255),
  phone         varchar(80),
  pin_hash      varchar(255),
  password_hash varchar(255),
  branch_id     varchar(191),
  rights        json NOT NULL,
  status        enum('active', 'inactive', 'deleted') NOT NULL DEFAULT 'active',
  last_login    datetime,
  created_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX credentials_email_idx ON credentials (email);
CREATE INDEX credentials_phone_idx ON credentials (phone);
CREATE INDEX credentials_status_idx ON credentials (status);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           varchar(191) PRIMARY KEY,
  user_id      varchar(191) NOT NULL,
  token_hash   varchar(255) NOT NULL UNIQUE,
  device_name  varchar(255),
  ip_address   varchar(80),
  login_time   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   datetime NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  CONSTRAINT user_sessions_user_fk FOREIGN KEY (user_id) REFERENCES credentials(id) ON DELETE CASCADE
);

CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, is_active);
CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id          bigint PRIMARY KEY AUTO_INCREMENT,
  user_id     varchar(191),
  event       varchar(80) NOT NULL,
  device_name varchar(255),
  ip_address  varchar(80),
  detail      json NOT NULL,
  created_at  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX auth_audit_log_user_idx ON auth_audit_log (user_id);
CREATE INDEX auth_audit_log_created_idx ON auth_audit_log (created_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              varchar(191) PRIMARY KEY,
  user_id         varchar(191),
  token_hash      varchar(64) NOT NULL UNIQUE,
  requested_email varchar(255) NOT NULL,
  ip_address      varchar(80),
  used_at         datetime,
  expires_at      datetime NOT NULL,
  created_at      datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES credentials(id) ON DELETE CASCADE
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
CREATE INDEX password_reset_tokens_lookup_idx ON password_reset_tokens (token_hash, used_at, expires_at);
CREATE INDEX password_reset_tokens_rate_idx ON password_reset_tokens (requested_email, ip_address, created_at);

CREATE TABLE IF NOT EXISTS user_fingerprints (
  id                       varchar(191) PRIMARY KEY,
  user_id                  varchar(191) NOT NULL,
  finger_template          longtext NOT NULL,
  finger_template_hash     varchar(64) NOT NULL,
  device_serial            varchar(191),
  created_at               datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_fingerprints_user_fk FOREIGN KEY (user_id) REFERENCES credentials(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX user_fingerprints_user_idx ON user_fingerprints (user_id);
CREATE INDEX user_fingerprints_hash_idx ON user_fingerprints (finger_template_hash);

CREATE TABLE IF NOT EXISTS auth_verification_codes (
  id bigint PRIMARY KEY AUTO_INCREMENT,
  channel enum('email', 'phone') NOT NULL,
  target varchar(255) NOT NULL,
  code_hash varchar(255) NOT NULL,
  purpose varchar(80) NOT NULL DEFAULT 'owner_signup',
  attempts int NOT NULL DEFAULT 0,
  consumed_at datetime,
  expires_at datetime NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX auth_verification_codes_lookup_idx
  ON auth_verification_codes (channel, target, purpose, consumed_at, expires_at);
