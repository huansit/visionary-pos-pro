CREATE TABLE IF NOT EXISTS devices (
  device_id    varchar(191) PRIMARY KEY,
  name         varchar(255) NOT NULL,
  branch_id    varchar(191),
  token_hash   varchar(255) NOT NULL,
  revoked_at   datetime,
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at datetime
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
  updated_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX credentials_email_idx ON credentials (email);
CREATE INDEX credentials_phone_idx ON credentials (phone);

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
