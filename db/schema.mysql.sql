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

CREATE TABLE IF NOT EXISTS invoice_sequences (
  branch_id    varchar(191) PRIMARY KEY,
  last_number  bigint NOT NULL DEFAULT 0,
  updated_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transfer_sequences (
  sequence_key varchar(191) PRIMARY KEY,
  last_number  bigint NOT NULL DEFAULT 0,
  updated_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
  barcode_catalog_id varchar(191) NOT NULL,
  name               varchar(255) NOT NULL,
  sku                varchar(191),
  category_id        varchar(191),
  brand              varchar(191),
  unit               varchar(80),
  cost_price         decimal(12, 2) NOT NULL DEFAULT 0,
  image              text,
  description        text,
  status             varchar(40) NOT NULL DEFAULT 'active',
  created_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_barcode_catalog_fk FOREIGN KEY (barcode_catalog_id) REFERENCES barcode_catalog(id)
);

CREATE INDEX products_barcode_catalog_idx ON products (barcode_catalog_id);
CREATE INDEX products_sku_idx ON products (sku);
CREATE INDEX products_status_idx ON products (status);

CREATE TABLE IF NOT EXISTS branch_products (
  id                 varchar(191) PRIMARY KEY,
  product_id         varchar(191) NOT NULL,
  branch_id          varchar(191) NOT NULL,
  selling_price      decimal(12, 2) NOT NULL DEFAULT 0,
  stock              int NOT NULL DEFAULT 0,
  reorder_level      int NOT NULL DEFAULT 0,
  shelf_location     varchar(191),
  availability       boolean NOT NULL DEFAULT true,
  created_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT branch_products_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT branch_products_branch_product_unique UNIQUE (branch_id, product_id)
);

CREATE INDEX branch_products_product_idx ON branch_products (product_id);
CREATE INDEX branch_products_branch_idx ON branch_products (branch_id);
CREATE INDEX branch_products_availability_idx ON branch_products (availability);

CREATE TABLE IF NOT EXISTS credentials (
  id            varchar(191) PRIMARY KEY,
  kind          enum('admin', 'user', 'cashier') NOT NULL,
  name          varchar(255),
  email         varchar(255),
  phone         varchar(80),
  pin_hash      varchar(255),
  pin_lookup_hash varchar(64),
  password_hash varchar(255),
  branch_id     varchar(191),
  rights        json NOT NULL,
  status        enum('active', 'inactive', 'deleted') NOT NULL DEFAULT 'active',
  email_verified boolean NOT NULL DEFAULT false,
  last_login    datetime,
  created_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX credentials_email_idx ON credentials (email);
CREATE INDEX credentials_phone_idx ON credentials (phone);
CREATE INDEX credentials_status_idx ON credentials (status);
CREATE UNIQUE INDEX credentials_pin_lookup_hash_unique_idx ON credentials (pin_lookup_hash);

CREATE TABLE IF NOT EXISTS user_sessions (
  id           varchar(191) PRIMARY KEY,
  user_id      varchar(191) NOT NULL,
  token_hash   varchar(255) NOT NULL UNIQUE,
  device_id    varchar(191),
  terminal_uuid varchar(191),
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
CREATE INDEX user_sessions_terminal_idx ON user_sessions (terminal_uuid, is_active);
CREATE INDEX user_sessions_device_idx ON user_sessions (device_id, is_active);

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

CREATE TABLE IF NOT EXISTS kopokopo_webhook_events (
  event_id      varchar(191) PRIMARY KEY,
  topic         varchar(100) NOT NULL,
  resource_id   varchar(191),
  payload       json NOT NULL,
  received_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX kopokopo_webhook_events_topic_idx
  ON kopokopo_webhook_events (topic, received_at);

CREATE TABLE IF NOT EXISTS kopokopo_transactions (
  id                varchar(191) PRIMARY KEY,
  webhook_event_id  varchar(191) NOT NULL,
  reference         varchar(191) NOT NULL,
  reference_last4   varchar(4) NOT NULL,
  amount_cents      bigint NOT NULL,
  allocated_cents   bigint NOT NULL DEFAULT 0,
  currency          varchar(20) NOT NULL DEFAULT 'KES',
  status            varchar(40) NOT NULL,
  till_number       varchar(80),
  branch_id         varchar(191),
  payer_name        varchar(255),
  payer_phone_last4 varchar(4),
  purpose           varchar(40) NOT NULL DEFAULT 'customer_payment',
  purpose_changed_at datetime,
  purpose_changed_by varchar(191),
  purpose_changed_by_name varchar(255),
  purpose_note      varchar(500),
  cross_branch_allowed boolean NOT NULL DEFAULT false,
  cross_branch_changed_at datetime,
  cross_branch_changed_by varchar(191),
  cross_branch_changed_by_name varchar(255),
  origination_time  datetime,
  reversed_at       datetime,
  created_at        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT kopokopo_transactions_reference_unique UNIQUE (reference)
);

CREATE INDEX kopokopo_transactions_lookup_idx
  ON kopokopo_transactions (branch_id, reference_last4, status, origination_time);

CREATE INDEX kopokopo_transactions_phone_lookup_idx
  ON kopokopo_transactions (branch_id, payer_phone_last4, origination_time);

CREATE INDEX kopokopo_transactions_purpose_idx
  ON kopokopo_transactions (branch_id, purpose, origination_time);

CREATE TABLE IF NOT EXISTS kopokopo_transaction_purpose_events (
  id                 varchar(191) PRIMARY KEY,
  transaction_id     varchar(191) NOT NULL,
  from_purpose       varchar(40) NOT NULL,
  to_purpose         varchar(40) NOT NULL,
  note               varchar(500),
  changed_by         varchar(191),
  changed_by_name    varchar(255),
  changed_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT kopokopo_transaction_purpose_events_transaction_fk FOREIGN KEY (transaction_id) REFERENCES kopokopo_transactions(id)
);

CREATE INDEX kopokopo_transaction_purpose_events_transaction_idx
  ON kopokopo_transaction_purpose_events (transaction_id, changed_at);

CREATE TABLE IF NOT EXISTS kopokopo_incoming_payment_requests (
  id                       varchar(191) PRIMARY KEY,
  idempotency_key          varchar(191) NOT NULL UNIQUE,
  branch_id                varchar(191) NOT NULL,
  till_number              varchar(80) NOT NULL,
  amount_cents             bigint NOT NULL,
  currency                 varchar(20) NOT NULL DEFAULT 'KES',
  status                   varchar(40) NOT NULL DEFAULT 'creating',
  provider_status          varchar(80),
  provider_location        varchar(500) UNIQUE,
  provider_request_id      varchar(191),
  provider_transaction_id  varchar(191),
  attempts                 int NOT NULL DEFAULT 0,
  next_check_at            datetime,
  expires_at               datetime NOT NULL,
  last_error               varchar(255),
  created_by               varchar(191),
  created_at               datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at             datetime
);

CREATE INDEX kopokopo_incoming_payment_due_idx
  ON kopokopo_incoming_payment_requests (status, next_check_at);
CREATE INDEX kopokopo_incoming_payment_branch_idx
  ON kopokopo_incoming_payment_requests (branch_id, created_at);

CREATE TABLE IF NOT EXISTS kopokopo_allocations (
  id                      varchar(191) PRIMARY KEY,
  transaction_id          varchar(191) NOT NULL,
  invoice_id               varchar(191) NOT NULL,
  branch_id                varchar(191) NOT NULL,
  amount_cents             bigint NOT NULL,
  cross_branch_authorized  boolean NOT NULL DEFAULT false,
  allocated_by             varchar(191),
  allocated_by_name        varchar(255),
  batch_idempotency_key    varchar(191) NOT NULL,
  local_payment_id         varchar(191),
  status                   varchar(40) NOT NULL DEFAULT 'active',
  allocated_at             datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT kopokopo_allocations_transaction_fk FOREIGN KEY (transaction_id) REFERENCES kopokopo_transactions(id),
  CONSTRAINT kopokopo_allocations_batch_invoice_unique UNIQUE (batch_idempotency_key, invoice_id),
  CONSTRAINT kopokopo_allocations_local_payment_unique UNIQUE (local_payment_id)
);

CREATE INDEX kopokopo_allocations_transaction_idx
  ON kopokopo_allocations (transaction_id, allocated_at);
CREATE INDEX kopokopo_allocations_invoice_idx
  ON kopokopo_allocations (invoice_id, allocated_at);

CREATE TABLE IF NOT EXISTS kopokopo_offset_batches (
  idempotency_key     varchar(191) PRIMARY KEY,
  transaction_id     varchar(191) NOT NULL,
  branch_id           varchar(191) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  note                varchar(500),
  offset_by           varchar(191),
  offset_by_name      varchar(255),
  created_at          datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT kopokopo_offset_batches_transaction_fk FOREIGN KEY (transaction_id) REFERENCES kopokopo_transactions(id)
);

CREATE TABLE IF NOT EXISTS kopokopo_offsets (
  id                 varchar(191) PRIMARY KEY,
  transaction_id     varchar(191) NOT NULL,
  invoice_id          varchar(191) NOT NULL,
  branch_id           varchar(191) NOT NULL,
  amount_cents        bigint NOT NULL,
  reason              varchar(80) NOT NULL DEFAULT 'cash_to_till',
  note                varchar(500),
  offset_by           varchar(191),
  offset_by_name      varchar(255),
  idempotency_key     varchar(191) NOT NULL UNIQUE,
  status              varchar(40) NOT NULL DEFAULT 'active',
  offset_at           datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT kopokopo_offsets_transaction_fk FOREIGN KEY (transaction_id) REFERENCES kopokopo_transactions(id)
);

CREATE INDEX kopokopo_offsets_transaction_idx
  ON kopokopo_offsets (transaction_id, offset_at);
CREATE INDEX kopokopo_offsets_invoice_idx
  ON kopokopo_offsets (invoice_id, offset_at);

CREATE TABLE IF NOT EXISTS cashier_wallet_batches (
  idempotency_key      varchar(191) PRIMARY KEY,
  operation            varchar(40) NOT NULL,
  cashier_id           varchar(191) NOT NULL,
  branch_id            varchar(191) NOT NULL,
  transaction_id       varchar(191),
  request_fingerprint  varchar(64) NOT NULL,
  total_cents          bigint NOT NULL,
  created_by           varchar(191),
  created_by_name      varchar(255),
  created_at           datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cashier_wallet_batches_transaction_fk FOREIGN KEY (transaction_id) REFERENCES kopokopo_transactions(id)
);

CREATE INDEX cashier_wallet_batches_cashier_idx
  ON cashier_wallet_batches (cashier_id, created_at);

CREATE TABLE IF NOT EXISTS cashier_wallet_entries (
  id                       varchar(191) PRIMARY KEY,
  batch_idempotency_key    varchar(191) NOT NULL,
  cashier_id               varchar(191) NOT NULL,
  cashier_name             varchar(255) NOT NULL,
  branch_id                varchar(191) NOT NULL,
  amount_cents             bigint NOT NULL,
  entry_type               varchar(40) NOT NULL,
  kopokopo_transaction_id  varchar(191),
  related_invoice_id       varchar(191),
  related_debt_id          varchar(191),
  related_payment_id       varchar(191),
  note                     varchar(500),
  created_by               varchar(191),
  created_by_name          varchar(255),
  created_at               datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cashier_wallet_entries_batch_fk FOREIGN KEY (batch_idempotency_key) REFERENCES cashier_wallet_batches(idempotency_key),
  CONSTRAINT cashier_wallet_entries_transaction_fk FOREIGN KEY (kopokopo_transaction_id) REFERENCES kopokopo_transactions(id)
);

CREATE INDEX cashier_wallet_entries_cashier_idx
  ON cashier_wallet_entries (cashier_id, created_at);
CREATE INDEX cashier_wallet_entries_transaction_idx
  ON cashier_wallet_entries (kopokopo_transaction_id, created_at);
