import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { isMySql, q } from "../db.js";
import { requireAdminOrSupervisor, requireDevice } from "../auth.js";
import { signDeviceToken, verifyDeviceToken } from "../token.js";
import { generateCode, normalizeTarget, sendPasswordResetEmail, sendVerificationCode, validTarget } from "../verification.js";

const router = Router();
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);
const SESSION_DAYS = Math.max(1, Math.min(90, parseInt(process.env.AUTH_SESSION_DAYS || "14", 10)));
const SINGLE_SESSION = process.env.AUTH_SINGLE_SESSION === "1";
let authSchemaReady = null;
const FINGERPRINT_ALGO = "aes-256-gcm";
const TERMINAL_CODE_TTL_HOURS = Math.max(1, Math.min(168, parseInt(process.env.TERMINAL_CODE_TTL_HOURS || "24", 10)));
const PASSWORD_RESET_TTL_MINUTES = 30;
const PASSWORD_RESET_RATE_WINDOW_MINUTES = 30;
const PASSWORD_RESET_RATE_MAX = Math.max(1, Math.min(10, parseInt(process.env.PASSWORD_RESET_RATE_MAX || "3", 10)));
const resetRequestBuckets = new Map();
const emailVerificationBuckets = new Map();
const EMAIL_VERIFICATION_RESEND_SECONDS = 60;
const EMAIL_VERIFICATION_RATE_WINDOW_MINUTES = 10;
const EMAIL_VERIFICATION_RATE_MAX = Math.max(1, Math.min(10, parseInt(process.env.EMAIL_VERIFICATION_RATE_MAX || "5", 10)));

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function terminalSecretHash(secret) {
  return crypto.createHash("sha256").update(String(secret || ""), "utf8").digest("hex");
}

function pinLookupHash(pin) {
  const pepper = process.env.PIN_LOOKUP_SECRET || process.env.JWT_SECRET || process.env.DEVICE_TOKEN_SECRET || "visionpos-pin-lookup";
  return crypto.createHmac("sha256", String(pepper)).update(String(pin || ""), "utf8").digest("hex");
}

function safeHashEqual(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function activationCodeHash(code) {
  return crypto.createHash("sha256").update(normalizeActivationCode(code), "utf8").digest("hex");
}

function normalizeActivationCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatActivationCode(raw) {
  return raw.match(/.{1,4}/g).join("-");
}

function generateActivationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  const bytes = crypto.randomBytes(12);
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return formatActivationCode(raw);
}

function terminalStatus(value) {
  const status = String(value || "ACTIVE").toUpperCase();
  return ["ACTIVE", "DISABLED", "REVOKED"].includes(status) ? status : "ACTIVE";
}

function maskEmail(email) {
  const [name, domain] = String(email || "").trim().toLowerCase().split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}${name.length > 2 ? "***" : "*"}@${domain}`;
}

function passwordPolicyIssue(password) {
  const pw = String(password || "");
  if (pw.length < 8) return "password_too_short";
  if (!/[A-Z]/.test(pw)) return "password_missing_uppercase";
  if (!/[a-z]/.test(pw)) return "password_missing_lowercase";
  if (!/[0-9]/.test(pw)) return "password_missing_number";
  if (!/[^A-Za-z0-9]/.test(pw)) return "password_missing_special";
  return null;
}

function publicAppBaseUrl(req) {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto || "https"}://${host}`;
}

function passwordResetRateLimited(target, ipAddress) {
  const key = `${target}|${ipAddress || ""}`;
  const cutoff = Date.now() - PASSWORD_RESET_RATE_WINDOW_MINUTES * 60 * 1000;
  const recent = (resetRequestBuckets.get(key) || []).filter((ts) => ts > cutoff);
  recent.push(Date.now());
  resetRequestBuckets.set(key, recent);
  return recent.length > PASSWORD_RESET_RATE_MAX;
}

function bucketRateLimited(map, key, windowMinutes, max) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const recent = (map.get(key) || []).filter((ts) => ts > cutoff);
  recent.push(Date.now());
  map.set(key, recent);
  return recent.length > max;
}

function adminEmailCodeEnabled() {
  return process.env.ADMIN_EMAIL_CODE_REQUIRED !== "0"
    && Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function requestMeta(req) {
  return {
    deviceName: String(req.body?.deviceName || req.headers["x-device-name"] || "Web POS").slice(0, 255),
    ipAddress: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 80),
  };
}

function fingerprintKey() {
  const configured = process.env.FINGERPRINT_ENCRYPTION_KEY || process.env.JWT_SECRET || process.env.DEVICE_TOKEN_SECRET || "visionpos-local-fingerprint-key";
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, "hex");
  return crypto.createHash("sha256").update(String(configured)).digest();
}

function encryptFingerprintTemplate(template) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(FINGERPRINT_ALGO, fingerprintKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(template), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + [iv, tag, ciphertext].map((part) => part.toString("base64")).join(":");
}

function decryptFingerprintTemplate(value) {
  const raw = String(value || "");
  if (!raw.startsWith("v1:")) return raw;
  const [, iv64, tag64, data64] = raw.split(":");
  const decipher = crypto.createDecipheriv(FINGERPRINT_ALGO, fingerprintKey(), Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data64, "base64")), decipher.final()]).toString("utf8");
}

function fingerprintTemplateHash(template) {
  return crypto.createHash("sha256").update(String(template || "")).digest("hex");
}

async function verifiedTerminalFromRequest(req, options = {}) {
  const terminalUuid = String(req.get("x-terminal-uuid") || "").trim();
  const terminalSecret = String(req.get("x-terminal-secret") || "").trim();
  if (terminalUuid && terminalSecret) {
    const result = await q(
      "SELECT device_id, terminal_uuid, name, branch_id, terminal_secret_hash, revoked_at, status FROM devices WHERE terminal_uuid = $1",
      [terminalUuid]
    );
    const terminal = result.rows[0];
    if (!terminal || terminal.revoked_at || terminalStatus(terminal.status) !== "ACTIVE") return { error: "terminal_not_authorized" };
    if (!safeHashEqual(terminalSecretHash(terminalSecret), terminal.terminal_secret_hash ?? terminal.terminalSecretHash)) return { error: "terminal_not_authorized" };
    await q(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [terminal.device_id ?? terminal.deviceId]);
    return {
      deviceId: terminal.device_id ?? terminal.deviceId,
      terminalUuid,
      name: terminal.name || "",
      branchId: terminal.branch_id ?? terminal.branchId ?? null,
    };
  }
  if (options.requireRegisteredTerminal) return { error: "registered_terminal_required" };

  const hdr = req.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  const deviceId = verifyDeviceToken(token);
  if (!deviceId) return { error: "registered_terminal_required" };

  const result = await q(
    "SELECT device_id, name, branch_id, token_hash, revoked_at, status FROM devices WHERE device_id = $1",
    [deviceId]
  );
  const device = result.rows[0];
  if (!device || device.revoked_at || terminalStatus(device.status) !== "ACTIVE") {
    return { error: "terminal_not_authorized" };
  }
  const tokenOk = await bcrypt.compare(token, device.token_hash);
  if (!tokenOk) return { error: "terminal_not_authorized" };
  await q(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [deviceId]);
  return {
    deviceId: device.device_id ?? device.deviceId,
    name: device.name || "",
    branchId: device.branch_id ?? device.branchId ?? null,
  };
}

function matchesCredentialIdentifier(row, identifier) {
  const raw = String(identifier || "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) return false;
  return [
    row.id,
    row.name,
    row.email,
    row.phone,
  ].some((value) => {
    const current = String(value || "").trim();
    return current && (current.toLowerCase() === normalized || current === raw);
  });
}

async function pinAlreadyAssigned(pin, excludeId = null) {
  const lookup = pinLookupHash(pin);
  const direct = await q(
    `SELECT id
       FROM credentials
      WHERE pin_lookup_hash = $1
        AND status <> 'deleted'
        ${excludeId ? "AND id <> $2" : ""}
      LIMIT 1`,
    excludeId ? [lookup, excludeId] : [lookup]
  );
  if (direct.rows[0]) return direct.rows[0].id;

  const legacy = await q(
    `SELECT id, pin_hash
       FROM credentials
      WHERE pin_hash IS NOT NULL
        AND status <> 'deleted'
        ${excludeId ? "AND id <> $1" : ""}`,
    excludeId ? [excludeId] : []
  );
  for (const row of legacy.rows) {
    if (await bcrypt.compare(String(pin), row.pin_hash)) return row.id;
  }
  return null;
}

function uniqueViolation(error) {
  return ["23505", "ER_DUP_ENTRY"].includes(error?.code);
}

async function ensureAuthSchema() {
  if (authSchemaReady) return authSchemaReady;
  authSchemaReady = (async () => {
    const pgMem = process.env.PG_MEM === "1";
    const statements = isMySql
      ? [
          "ALTER TABLE devices ADD COLUMN terminal_uuid varchar(191)",
          "ALTER TABLE devices ADD COLUMN terminal_secret_hash varchar(64)",
          "ALTER TABLE devices ADD COLUMN app_version varchar(80)",
          "ALTER TABLE devices ADD COLUMN status enum('ACTIVE','DISABLED','REVOKED') NOT NULL DEFAULT 'ACTIVE'",
          "CREATE INDEX devices_status_idx ON devices (status)",
          "CREATE UNIQUE INDEX devices_terminal_uuid_idx ON devices (terminal_uuid)",
          `CREATE TABLE IF NOT EXISTS terminal_activation_codes (
             id varchar(191) PRIMARY KEY,
             code_hash varchar(64) NOT NULL UNIQUE,
             branch_id varchar(191) NOT NULL,
             terminal_name varchar(255) NOT NULL,
             created_by varchar(191),
             created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             expires_at datetime NOT NULL,
             used_at datetime,
             used_by_terminal_uuid varchar(191),
             revoked_at datetime
           )`,
          "CREATE INDEX terminal_activation_codes_active_idx ON terminal_activation_codes (expires_at, used_at, revoked_at)",
          "ALTER TABLE credentials ADD COLUMN status enum('active','inactive','deleted') NOT NULL DEFAULT 'active'",
          "ALTER TABLE credentials ADD COLUMN email_verified boolean NOT NULL DEFAULT false",
          "ALTER TABLE credentials ADD COLUMN last_login datetime",
          "ALTER TABLE credentials ADD COLUMN created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP",
          "ALTER TABLE credentials ADD COLUMN pin_lookup_hash varchar(64)",
          "CREATE INDEX credentials_status_idx ON credentials (status)",
          "CREATE UNIQUE INDEX credentials_pin_lookup_hash_unique_idx ON credentials (pin_lookup_hash)",
          `CREATE TABLE IF NOT EXISTS user_sessions (
             id varchar(191) PRIMARY KEY,
             user_id varchar(191) NOT NULL,
             token_hash varchar(255) NOT NULL UNIQUE,
             device_id varchar(191),
             terminal_uuid varchar(191),
             device_name varchar(255),
             ip_address varchar(80),
             login_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             last_seen datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             expires_at datetime NOT NULL,
             is_active boolean NOT NULL DEFAULT true
           )`,
          "ALTER TABLE user_sessions ADD COLUMN device_id varchar(191)",
          "ALTER TABLE user_sessions ADD COLUMN terminal_uuid varchar(191)",
          "CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, is_active)",
          "CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at)",
          "CREATE INDEX user_sessions_terminal_idx ON user_sessions (terminal_uuid, is_active)",
          "CREATE INDEX user_sessions_device_idx ON user_sessions (device_id, is_active)",
          `CREATE TABLE IF NOT EXISTS auth_audit_log (
             id bigint PRIMARY KEY AUTO_INCREMENT,
             user_id varchar(191),
             event varchar(80) NOT NULL,
             device_name varchar(255),
             ip_address varchar(80),
             detail json NOT NULL,
             created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
           )`,
          "CREATE INDEX auth_audit_log_user_idx ON auth_audit_log (user_id)",
          "CREATE INDEX auth_audit_log_created_idx ON auth_audit_log (created_at)",
          `CREATE TABLE IF NOT EXISTS password_reset_tokens (
             id varchar(191) PRIMARY KEY,
             user_id varchar(191),
             token_hash varchar(64) NOT NULL UNIQUE,
             requested_email varchar(255) NOT NULL,
             ip_address varchar(80),
             used_at datetime,
             expires_at datetime NOT NULL,
             created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
           )`,
          "CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id)",
          "CREATE INDEX password_reset_tokens_lookup_idx ON password_reset_tokens (token_hash, used_at, expires_at)",
          "CREATE INDEX password_reset_tokens_rate_idx ON password_reset_tokens (requested_email, ip_address, created_at)",
          `CREATE TABLE IF NOT EXISTS user_fingerprints (
             id varchar(191) PRIMARY KEY,
             user_id varchar(191) NOT NULL,
             finger_template longtext NOT NULL,
             finger_template_hash varchar(64) NOT NULL,
             device_serial varchar(191),
             created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             CONSTRAINT user_fingerprints_user_fk FOREIGN KEY (user_id) REFERENCES credentials(id) ON DELETE CASCADE
           )`,
          "CREATE UNIQUE INDEX user_fingerprints_user_idx ON user_fingerprints (user_id)",
          "CREATE INDEX user_fingerprints_hash_idx ON user_fingerprints (finger_template_hash)",
        ]
      : [
          "ALTER TABLE devices ADD COLUMN IF NOT EXISTS terminal_uuid text",
          "ALTER TABLE devices ADD COLUMN IF NOT EXISTS terminal_secret_hash text",
          "ALTER TABLE devices ADD COLUMN IF NOT EXISTS app_version text",
          "ALTER TABLE devices ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
          "CREATE INDEX IF NOT EXISTS devices_status_idx ON devices (status)",
          "CREATE UNIQUE INDEX IF NOT EXISTS devices_terminal_uuid_idx ON devices (terminal_uuid)",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS terminal_activation_codes (
               id text,
               code_hash text,
               branch_id text,
               terminal_name text,
               created_by text,
               created_at timestamptz,
               expires_at timestamptz,
               used_at timestamptz,
               used_by_terminal_uuid text,
               revoked_at timestamptz
             )`
            : `CREATE TABLE IF NOT EXISTS terminal_activation_codes (
               id text PRIMARY KEY,
               code_hash text NOT NULL UNIQUE,
               branch_id text NOT NULL,
               terminal_name text NOT NULL,
               created_by text,
               created_at timestamptz NOT NULL DEFAULT now(),
               expires_at timestamptz NOT NULL,
               used_at timestamptz,
               used_by_terminal_uuid text,
               revoked_at timestamptz
             )`,
          "CREATE INDEX IF NOT EXISTS terminal_activation_codes_active_idx ON terminal_activation_codes (expires_at, used_at, revoked_at)",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS last_login timestamptz",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS pin_lookup_hash text",
          "CREATE INDEX IF NOT EXISTS credentials_status_idx ON credentials (status)",
          "CREATE UNIQUE INDEX IF NOT EXISTS credentials_pin_lookup_hash_unique_idx ON credentials (pin_lookup_hash) WHERE pin_lookup_hash IS NOT NULL AND status <> 'deleted'",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS user_sessions (
               id text,
               user_id text,
               token_hash text,
               device_id text,
               terminal_uuid text,
               device_name text,
               ip_address text,
               login_time timestamptz,
               last_seen timestamptz,
               expires_at timestamptz,
               is_active boolean
             )`
            : `CREATE TABLE IF NOT EXISTS user_sessions (
               id text PRIMARY KEY,
               user_id text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
               token_hash text NOT NULL,
               device_id text,
               terminal_uuid text,
               device_name text,
               ip_address text,
               login_time timestamptz NOT NULL DEFAULT now(),
               last_seen timestamptz NOT NULL DEFAULT now(),
               expires_at timestamptz NOT NULL,
               is_active boolean NOT NULL DEFAULT true
             )`,
          "ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS device_id text",
          "ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS terminal_uuid text",
          "CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON user_sessions (token_hash)",
          "CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions (user_id, is_active)",
          "CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at)",
          "CREATE INDEX IF NOT EXISTS user_sessions_terminal_idx ON user_sessions (terminal_uuid, is_active)",
          "CREATE INDEX IF NOT EXISTS user_sessions_device_idx ON user_sessions (device_id, is_active)",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS auth_audit_log (
               id text,
               user_id text,
               event text,
               device_name text,
               ip_address text,
               detail jsonb,
               created_at timestamptz
             )`
            : `CREATE TABLE IF NOT EXISTS auth_audit_log (
               id bigserial PRIMARY KEY,
               user_id text,
               event text NOT NULL,
               device_name text,
               ip_address text,
               detail jsonb NOT NULL DEFAULT '{}'::jsonb,
               created_at timestamptz NOT NULL DEFAULT now()
             )`,
          "CREATE INDEX IF NOT EXISTS auth_audit_log_user_idx ON auth_audit_log (user_id)",
          "CREATE INDEX IF NOT EXISTS auth_audit_log_created_idx ON auth_audit_log (created_at)",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS password_reset_tokens (
               id text,
               user_id text,
               token_hash text,
               requested_email text,
               ip_address text,
               used_at timestamptz,
               expires_at timestamptz,
               created_at timestamptz
             )`
            : `CREATE TABLE IF NOT EXISTS password_reset_tokens (
               id text PRIMARY KEY,
               user_id text REFERENCES credentials(id) ON DELETE CASCADE,
               token_hash text NOT NULL UNIQUE,
               requested_email text NOT NULL,
               ip_address text,
               used_at timestamptz,
               expires_at timestamptz NOT NULL,
               created_at timestamptz NOT NULL DEFAULT now()
             )`,
          "CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id)",
          "CREATE INDEX IF NOT EXISTS password_reset_tokens_lookup_idx ON password_reset_tokens (token_hash, used_at, expires_at)",
          "CREATE INDEX IF NOT EXISTS password_reset_tokens_rate_idx ON password_reset_tokens (requested_email, ip_address, created_at)",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS user_fingerprints (
               id text,
               user_id text,
               finger_template text,
               finger_template_hash text,
               device_serial text,
               created_at timestamptz,
               updated_at timestamptz
             )`
            : `CREATE TABLE IF NOT EXISTS user_fingerprints (
               id text PRIMARY KEY,
               user_id text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
               finger_template text NOT NULL,
               finger_template_hash text NOT NULL,
               device_serial text,
               created_at timestamptz NOT NULL DEFAULT now(),
               updated_at timestamptz NOT NULL DEFAULT now()
             )`,
          "CREATE UNIQUE INDEX IF NOT EXISTS user_fingerprints_user_idx ON user_fingerprints (user_id)",
          "CREATE INDEX IF NOT EXISTS user_fingerprints_hash_idx ON user_fingerprints (finger_template_hash)",
        ];
    for (const sql of statements) {
      try {
        await q(sql, []);
      } catch (error) {
        if (!["42701", "42P07", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) throw error;
      }
    }
  })();
  return authSchemaReady;
}

async function audit(event, req, userId = null, detail = {}) {
  await ensureAuthSchema();
  const { deviceName, ipAddress } = requestMeta(req);
  try {
    await q(
      `INSERT INTO auth_audit_log (user_id, event, device_name, ip_address, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, event, deviceName, ipAddress, detail]
    );
  } catch (error) {
    console.error("auth audit failed:", error);
  }
}

async function issueSession(req, account, terminal = null) {
  await ensureAuthSchema();
  const { deviceName, ipAddress } = requestMeta(req);
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const token = "vps_" + crypto.randomBytes(32).toString("hex");
  if (SINGLE_SESSION) {
    await q(
      `UPDATE user_sessions SET is_active = false WHERE user_id = $1 AND is_active = true`,
      [account.id]
    );
  }
  await q(
    isMySql
      ? `INSERT INTO user_sessions (id, user_id, token_hash, device_id, terminal_uuid, device_name, ip_address, login_time, last_seen, expires_at, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),DATE_ADD(NOW(), INTERVAL $8 DAY),true)`
      : `INSERT INTO user_sessions (id, user_id, token_hash, device_id, terminal_uuid, device_name, ip_address, login_time, last_seen, expires_at, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),now() + ($8 || ' days')::interval,true)`,
    [id, account.id, tokenHash(token), terminal?.deviceId || req.deviceId || null, terminal?.terminalUuid || req.terminalUuid || null, deviceName, ipAddress, SESSION_DAYS]
  );
  await q(`UPDATE credentials SET last_login = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [account.id]);
  await audit("login_success", req, account.id, { sessionId: id, deviceId: terminal?.deviceId || req.deviceId || null, terminalUuid: terminal?.terminalUuid || req.terminalUuid || null });
  return { id, token, expiresInDays: SESSION_DAYS };
}

async function accountForSessionToken(token) {
  await ensureAuthSchema();
  const result = await q(
    `SELECT s.id AS session_id, s.expires_at, s.is_active, s.device_id, s.terminal_uuid,
            c.id, c.kind, c.name, c.email, c.phone, c.branch_id, c.rights, c.status, c.email_verified
       FROM user_sessions s
       JOIN credentials c ON c.id = s.user_id
      WHERE s.token_hash = $1
        AND s.is_active = true
        AND s.expires_at > ${isMySql ? "NOW()" : "now()"}
        AND c.status = 'active'
      LIMIT 1`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  if (!row) return null;
  const sessionTerminalUuid = row.terminal_uuid ?? row.terminalUuid ?? null;
  const sessionDeviceId = row.device_id ?? row.deviceId ?? null;
  if (sessionTerminalUuid || sessionDeviceId) {
    const terminalResult = await q(
      `SELECT device_id, terminal_uuid, status, revoked_at
         FROM devices
        WHERE ${sessionTerminalUuid ? "terminal_uuid = $1" : "device_id = $1"}
        LIMIT 1`,
      [sessionTerminalUuid || sessionDeviceId]
    );
    const terminal = terminalResult.rows[0];
    if (!terminal || terminal.revoked_at || terminalStatus(terminal.status) !== "ACTIVE") {
      await q("UPDATE user_sessions SET is_active = false WHERE id = $1", [row.session_id ?? row.sessionId]);
      return null;
    }
  }
  await q(`UPDATE user_sessions SET last_seen = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [row.session_id ?? row.sessionId]);
  return { sessionId: row.session_id ?? row.sessionId, account: publicAccount(row) };
}

router.post("/device", async (req, res) => {
  const { deviceId, name, branchId = null, setupKey } = req.body || {};
  if (!deviceId || !name) return res.status(400).json({ error: "deviceId_and_name_required" });
  if (process.env.NODE_ENV === "production" && !process.env.DEVICE_SETUP_KEY) {
    console.error("DEVICE_SETUP_KEY is required in production before registering devices.");
    return res.status(503).json({ error: "device_registration_not_configured" });
  }
  if (process.env.DEVICE_SETUP_KEY && setupKey !== process.env.DEVICE_SETUP_KEY) {
    return res.status(401).json({ error: "invalid_setup_key" });
  }

  const token = signDeviceToken(deviceId);
  const tokenHash = await bcrypt.hash(token, ROUNDS);
  if (isMySql) {
    await q(
      `INSERT INTO devices (device_id, name, branch_id, token_hash, status, revoked_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'active',NULL,NOW())
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         branch_id = VALUES(branch_id),
         token_hash = VALUES(token_hash),
         status = 'active',
         revoked_at = NULL,
         last_seen_at = NOW()`,
      [deviceId, name, branchId, tokenHash]
    );
  } else {
    await q(
      `INSERT INTO devices (device_id, name, branch_id, token_hash, status, revoked_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'active',NULL, now())
       ON CONFLICT (device_id) DO UPDATE SET
         name = EXCLUDED.name,
         branch_id = EXCLUDED.branch_id,
         token_hash = EXCLUDED.token_hash,
         status = 'active',
         revoked_at = NULL,
         last_seen_at = now()`,
      [deviceId, name, branchId, tokenHash]
    );
  }
  res.json({ deviceId, token });
});

router.post("/terminal-activations", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const sessionBranchId = String(req.account?.branchId || "").trim();
  const requestedBranchId = String(req.body?.branchId || "").trim();
  const branchId = sessionBranchId || requestedBranchId;
  const terminalName = String(req.body?.terminalName || req.body?.name || "").trim().slice(0, 255);
  const ttlHours = Math.max(1, Math.min(168, parseInt(req.body?.ttlHours || TERMINAL_CODE_TTL_HOURS, 10)));
  if (!branchId) return res.status(400).json({ error: "current_branch_required" });
  if (!terminalName) return res.status(400).json({ error: "terminal_name_required" });
  if (sessionBranchId && requestedBranchId && requestedBranchId !== sessionBranchId) {
    return res.status(403).json({ error: "branch_not_authorized" });
  }

  const code = generateActivationCode();
  const id = "tac_" + (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
  await q(
    isMySql
      ? `INSERT INTO terminal_activation_codes (id, code_hash, branch_id, terminal_name, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),DATE_ADD(NOW(), INTERVAL $6 HOUR))`
      : `INSERT INTO terminal_activation_codes (id, code_hash, branch_id, terminal_name, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,now(),now() + ($6 || ' hours')::interval)`,
    [id, activationCodeHash(code), branchId, terminalName, req.account?.id || null, ttlHours]
  );
  await audit("terminal_activation_created", req, req.account?.id || null, { activationId: id, branchId, terminalName, expiresInHours: ttlHours });
  res.json({ ok: true, id, code, branchId, terminalName, expiresInHours: ttlHours });
});

router.post("/terminals/activate", async (req, res) => {
  await ensureAuthSchema();
  const activationCode = normalizeActivationCode(req.body?.activationCode || req.body?.code);
  const appVersion = String(req.body?.appVersion || "").trim().slice(0, 80);
  const requestedName = String(req.body?.terminalName || req.body?.name || "").trim().slice(0, 255);
  if (!activationCode || activationCode.length < 8) return res.status(400).json({ error: "activation_code_required" });

  try {
    const codeHash = activationCodeHash(activationCode);
    const result = await q(
      `SELECT id, branch_id, terminal_name, expires_at, used_at, revoked_at
         FROM terminal_activation_codes
        WHERE code_hash = $1
        LIMIT 1`,
      [codeHash]
    );
    const activation = result.rows[0];
    if (!activation || activation.used_at || activation.usedAt || activation.revoked_at || activation.revokedAt) {
      await audit("terminal_activation_failed", req, null, { reason: "invalid_or_used_code" });
      return res.status(401).json({ error: "invalid_activation_code" });
    }
    if (new Date(activation.expires_at ?? activation.expiresAt).getTime() <= Date.now()) {
      await audit("terminal_activation_failed", req, null, { activationId: activation.id, reason: "expired_code" });
      return res.status(401).json({ error: "activation_code_expired" });
    }

    const uuid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const id = "term_" + uuid;
    const secret = crypto.randomBytes(32).toString("hex");
    const token = signDeviceToken(id);
    const tokenHash = await bcrypt.hash(token, ROUNDS);
    const terminalName = requestedName || activation.terminal_name || activation.terminalName;
    const branchId = activation.branch_id ?? activation.branchId;
    if (isMySql) {
      await q(
        `INSERT INTO devices (device_id, terminal_uuid, name, branch_id, token_hash, terminal_secret_hash, app_version, status, revoked_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',NULL,NOW())`,
        [id, uuid, terminalName, branchId, tokenHash, terminalSecretHash(secret), appVersion]
      );
      await q(
        `UPDATE terminal_activation_codes SET used_at = NOW(), used_by_terminal_uuid = $1 WHERE id = $2`,
        [uuid, activation.id]
      );
    } else {
      await q(
        `INSERT INTO devices (device_id, terminal_uuid, name, branch_id, token_hash, terminal_secret_hash, app_version, status, revoked_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',NULL,now())`,
        [id, uuid, terminalName, branchId, tokenHash, terminalSecretHash(secret), appVersion]
      );
      await q(
        `UPDATE terminal_activation_codes SET used_at = now(), used_by_terminal_uuid = $1 WHERE id = $2`,
        [uuid, activation.id]
      );
    }
    await audit("terminal_activated", req, null, { terminalId: id, terminalUuid: uuid, branchId, terminalName, appVersion });
    res.json({ ok: true, terminal: { id, uuid, branchId, terminalName, status: "ACTIVE", appVersion }, terminalSecret: secret });
  } catch (error) {
    console.error("terminal activation failed:", error);
    res.status(500).json({ error: "terminal_activation_failed" });
  }
});

router.get("/terminals", requireAdminOrSupervisor, async (_req, res) => {
  await ensureAuthSchema();
  const result = await q(
    isMySql
      ? `SELECT device_id AS id, terminal_uuid AS uuid, branch_id AS branchId, name AS terminalName,
                status, last_seen_at AS lastSeen, app_version AS appVersion, created_at AS createdAt, revoked_at AS revokedAt
           FROM devices
          WHERE terminal_uuid IS NOT NULL
          ORDER BY created_at DESC`
      : `SELECT device_id AS "id", terminal_uuid AS "uuid", branch_id AS "branchId", name AS "terminalName",
                status, last_seen_at AS "lastSeen", app_version AS "appVersion", created_at AS "createdAt", revoked_at AS "revokedAt"
           FROM devices
          WHERE terminal_uuid IS NOT NULL
          ORDER BY created_at DESC`,
    []
  );
  res.json({ terminals: result.rows.map((row) => ({ ...row, status: terminalStatus(row.status) })) });
});

router.post("/terminals/:uuid", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const uuid = String(req.params.uuid || "").trim();
  const action = String(req.body?.action || "update").toLowerCase();
  const terminalName = req.body?.terminalName == null ? null : String(req.body.terminalName).trim().slice(0, 255);
  if (!uuid) return res.status(400).json({ error: "terminal_uuid_required" });

  let status = null;
  if (action === "disable") status = "DISABLED";
  if (action === "revoke") status = "REVOKED";
  if (action === "activate") status = "ACTIVE";

  const fields = [];
  const values = [];
  const add = (sql, value) => { values.push(value); fields.push(sql.replace("?", "$" + values.length)); };
  if (terminalName) add("name = ?", terminalName);
  if (status) add("status = ?", status);
  if (status === "REVOKED") fields.push(`revoked_at = ${isMySql ? "NOW()" : "now()"}`);
  if (status === "ACTIVE") fields.push("revoked_at = NULL");
  if (!fields.length) return res.status(400).json({ error: "no_terminal_changes" });
  values.push(uuid);
  const before = await q("SELECT device_id, branch_id, status FROM devices WHERE terminal_uuid = $1 LIMIT 1", [uuid]);
  const terminal = before.rows[0];
  if (!terminal) return res.status(404).json({ error: "terminal_not_found" });
  await q(`UPDATE devices SET ${fields.join(", ")} WHERE terminal_uuid = $${values.length}`, values);
  if (status === "DISABLED" || status === "REVOKED") {
    await q(
      `UPDATE user_sessions
          SET is_active = false
        WHERE is_active = true
          AND (terminal_uuid = $1 OR device_id = $2)`,
      [uuid, terminal.device_id ?? terminal.deviceId]
    );
  }
  await audit("terminal_updated", req, req.account?.id || null, { terminalUuid: uuid, action, status, terminalName, branchId: terminal.branch_id ?? terminal.branchId ?? null });
  res.json({ ok: true });
});

router.post("/send-code", async (req, res) => {
  const channel = req.body?.channel === "phone" ? "phone" : "email";
  const target = normalizeTarget(channel, req.body?.target);
  if (!validTarget(channel, target)) return res.status(400).json({ error: "invalid_target" });

  try {
    const ttl = await sendAndStoreCode({ channel, target, purpose: "owner_signup" });
    res.json({ ok: true, channel, target, expiresInMinutes: ttl });
  } catch (error) {
    console.error("send-code failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "send_code_failed" });
  }
});

router.post("/verify-code", async (req, res) => {
  const channel = req.body?.channel === "phone" ? "phone" : "email";
  const target = normalizeTarget(channel, req.body?.target);
  const code = String(req.body?.code || "").trim();
  if (!validTarget(channel, target) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "invalid_code_request" });

  try {
    const verified = await verifyOwnerCode({ channel, target, code });
    res.json({ ok: verified });
  } catch (error) {
    console.error("verify-code failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "verify_code_failed" });
  }
});

router.post("/request-password-reset", async (req, res) => {
  await ensureAuthSchema();
  const target = normalizeTarget("email", req.body?.email || req.body?.identifier);
  if (!validTarget("email", target)) return res.status(400).json({ error: "invalid_email" });
  const { ipAddress } = requestMeta(req);
  const generic = { ok: true, message: "If that admin email exists, a reset link has been sent." };

  try {
    if (passwordResetRateLimited(target, ipAddress)) {
      await audit("password_reset_rate_limited", req, null, { target: maskEmail(target), ipAddress });
      return res.json(generic);
    }
    const result = await q(
      `SELECT id, kind, status, password_hash
         FROM credentials
        WHERE LOWER(email) = $1
          AND password_hash IS NOT NULL
          AND status = 'active'
        LIMIT 1`,
      [target]
    );
    const account = result.rows[0];
    if (!account || account.kind !== "admin") {
      await audit("password_reset_requested", req, null, { target: maskEmail(target), accepted: false });
      return res.json(generic);
    }

    const rateResult = await q(
      `SELECT ${isMySql ? "COUNT(*)" : "COUNT(*)::int"} AS n
         FROM password_reset_tokens
        WHERE requested_email = $1
          AND COALESCE(ip_address, '') = COALESCE($2, '')
          AND created_at > ${isMySql ? "DATE_SUB(NOW(), INTERVAL " + PASSWORD_RESET_RATE_WINDOW_MINUTES + " MINUTE)" : "now() - ($3::int * interval '1 minute')"}`,
      isMySql ? [target, ipAddress] : [target, ipAddress, PASSWORD_RESET_RATE_WINDOW_MINUTES]
    );
    const recentRequests = Number(rateResult.rows[0]?.n || 0);
    if (recentRequests >= PASSWORD_RESET_RATE_MAX) {
      await audit("password_reset_rate_limited", req, account.id, { target: maskEmail(target), ipAddress });
      return res.json(generic);
    }

    await q("UPDATE password_reset_tokens SET used_at = " + (isMySql ? "NOW()" : "now()") + " WHERE user_id = $1 AND used_at IS NULL", [account.id]);
    const token = crypto.randomBytes(32).toString("base64url");
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const hashedToken = tokenHash(token);
    await q(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, requested_email, ip_address, expires_at)
       VALUES ($1,$2,$3,$4,$5,${isMySql ? "DATE_ADD(NOW(), INTERVAL " + PASSWORD_RESET_TTL_MINUTES + " MINUTE)" : "now() + ($6::int * interval '1 minute')"})`,
      isMySql ? [id, account.id, hashedToken, target, ipAddress] : [id, account.id, hashedToken, target, ipAddress, PASSWORD_RESET_TTL_MINUTES]
    );
    const resetUrl = `${publicAppBaseUrl(req)}/?resetToken=${encodeURIComponent(token)}`;
    await sendPasswordResetEmail({ target, resetUrl, expiresInMinutes: PASSWORD_RESET_TTL_MINUTES });
    await audit("password_reset_link_sent", req, account.id, { target: maskEmail(target), expiresInMinutes: PASSWORD_RESET_TTL_MINUTES });
    res.json(generic);
  } catch (error) {
    console.error("request-password-reset failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "password_reset_request_failed" });
  }
});

router.post("/validate-password-reset", async (req, res) => {
  await ensureAuthSchema();
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "reset_token_required" });
  try {
    const result = await q(
      `SELECT prt.id, prt.expires_at, prt.used_at, c.email, c.status
         FROM password_reset_tokens prt
         JOIN credentials c ON c.id = prt.user_id
        WHERE prt.token_hash = $1
        LIMIT 1`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.status !== "active") {
      return res.status(400).json({ error: "reset_token_invalid_or_expired" });
    }
    res.json({ ok: true, target: maskEmail(row.email) });
  } catch (error) {
    console.error("validate-password-reset failed:", error);
    res.status(500).json({ error: "password_reset_validate_failed" });
  }
});

router.post("/reset-password", async (req, res) => {
  await ensureAuthSchema();
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");
  const confirmPassword = String(req.body?.confirmPassword || req.body?.passwordConfirm || password);
  if (!token) return res.status(400).json({ error: "reset_token_required" });
  if (password !== confirmPassword) return res.status(400).json({ error: "passwords_do_not_match" });
  const policyIssue = passwordPolicyIssue(password);
  if (policyIssue) return res.status(400).json({ error: policyIssue });

  try {
    const result = await q(
      `SELECT prt.id AS reset_id, prt.expires_at, prt.used_at, prt.requested_email, c.id, c.kind, c.status, c.password_hash
         FROM password_reset_tokens prt
         JOIN credentials c ON c.id = prt.user_id
        WHERE prt.token_hash = $1
        LIMIT 1`,
      [tokenHash(token)]
    );
    const account = result.rows[0];
    if (!account || account.kind !== "admin" || account.status !== "active" || account.used_at || new Date(account.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: "reset_token_invalid_or_expired" });
    }
    const samePassword = await bcrypt.compare(password, account.password_hash);
    if (samePassword) return res.status(400).json({ error: "password_reused" });

    const passwordHash = await bcrypt.hash(password, ROUNDS);
    await q(`UPDATE credentials SET password_hash = $1, updated_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $2`, [passwordHash, account.id]);
    await q(`UPDATE password_reset_tokens SET used_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [account.reset_id]);
    await q("UPDATE user_sessions SET is_active = false WHERE user_id = $1", [account.id]);
    await audit("password_reset_completed", req, account.id, { target: maskEmail(account.requested_email), resetId: account.reset_id });
    res.json({ ok: true });
  } catch (error) {
    console.error("reset-password failed:", error);
    const status = error.statusCode || 500;
    res.status(status).json({ error: status >= 500 ? "password_reset_failed" : error.message });
  }
});

router.post("/resend-email-verification", async (req, res) => {
  await ensureAuthSchema();
  const target = normalizeTarget("email", req.body?.email || req.body?.identifier);
  if (!validTarget("email", target)) return res.status(400).json({ error: "invalid_email" });
  const { ipAddress } = requestMeta(req);
  try {
    const result = await q(
      `SELECT id, kind, status, email_verified
         FROM credentials
        WHERE LOWER(email) = $1
          AND password_hash IS NOT NULL
          AND status = 'active'
        LIMIT 1`,
      [target]
    );
    const account = result.rows[0];
    if (!account || account.kind !== "admin") {
      await audit("email_verification_resend_requested", req, null, { target: maskEmail(target), accepted: false });
      return res.json({ ok: true, target: maskEmail(target), resendAfterSeconds: EMAIL_VERIFICATION_RESEND_SECONDS });
    }
    if (account.email_verified ?? account.emailVerified) {
      await audit("email_verification_resend_skipped", req, account.id, { target: maskEmail(target), reason: "already_verified" });
      return res.json({ ok: true, alreadyVerified: true, target: maskEmail(target) });
    }
    if (bucketRateLimited(emailVerificationBuckets, `${target}|${ipAddress || ""}`, EMAIL_VERIFICATION_RATE_WINDOW_MINUTES, EMAIL_VERIFICATION_RATE_MAX)) {
      await audit("email_verification_resend_rate_limited", req, account.id, { target: maskEmail(target), ipAddress });
      return res.status(429).json({ error: "too_many_attempts", resendAfterSeconds: EMAIL_VERIFICATION_RESEND_SECONDS });
    }
    const expiresInMinutes = await sendAndStoreCode({ channel: "email", target, purpose: "email_verification" });
    await audit("email_verification_code_sent", req, account.id, { target: maskEmail(target), expiresInMinutes });
    res.json({ ok: true, target: maskEmail(target), expiresInMinutes, resendAfterSeconds: EMAIL_VERIFICATION_RESEND_SECONDS });
  } catch (error) {
    console.error("resend email verification failed:", error);
    await audit("email_verification_resend_failed", req, null, { target: maskEmail(target), reason: error.message });
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "email_verification_send_failed" });
  }
});

router.post("/verify-email", async (req, res) => {
  await ensureAuthSchema();
  const target = normalizeTarget("email", req.body?.email || req.body?.identifier);
  const code = String(req.body?.code || "").trim();
  if (!validTarget("email", target) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "invalid_code_request" });
  try {
    const result = await q(
      `SELECT id, kind, status, email_verified
         FROM credentials
        WHERE LOWER(email) = $1
          AND password_hash IS NOT NULL
          AND status = 'active'
        LIMIT 1`,
      [target]
    );
    const account = result.rows[0];
    if (!account || account.kind !== "admin") {
      await audit("email_verification_failed", req, null, { target: maskEmail(target), reason: "account_not_found" });
      return res.status(401).json({ error: "invalid_code" });
    }
    if (account.email_verified ?? account.emailVerified) {
      await audit("email_verification_already_verified", req, account.id, { target: maskEmail(target) });
      return res.json({ ok: true, alreadyVerified: true });
    }
    await verifyAuthCode({ channel: "email", target, code, purpose: "email_verification", consume: true });
    await q(`UPDATE credentials SET email_verified = ${isMySql ? "true" : "true"}, updated_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [account.id]);
    await audit("email_verification_completed", req, account.id, { target: maskEmail(target) });
    res.json({ ok: true });
  } catch (error) {
    console.error("verify email failed:", error);
    await audit("email_verification_failed", req, null, { target: maskEmail(target), reason: error.message });
    const status = error.statusCode || 500;
    res.status(status).json({ error: status >= 500 ? "email_verification_failed" : error.message });
  }
});

router.post("/register-owner", async (req, res) => {
  await ensureAuthSchema();
  const { name, password } = req.body || {};
  const channel = req.body?.channel === "phone" ? "phone" : "email";
  const target = normalizeTarget(channel, req.body?.target);
  const code = String(req.body?.code || "").trim();
  if (!name || !password) return res.status(400).json({ error: "name_and_password_required" });
  if (!validTarget(channel, target) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "invalid_code_request" });

  try {
    await verifyOwnerCode({ channel, target, code, consume: true });
    const passwordHash = await bcrypt.hash(password, ROUNDS);
    const id = "admin";
    const email = channel === "email" ? target : null;
    const phone = channel === "phone" ? target : null;
    if (isMySql) {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, password_hash, branch_id, rights, email_verified)
         VALUES ($1, 'admin', $2, $3, $4, $5, NULL, $6, $7)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           email = VALUES(email),
           phone = VALUES(phone),
           password_hash = VALUES(password_hash),
           rights = VALUES(rights),
           email_verified = VALUES(email_verified),
           updated_at = NOW()`,
        [id, String(name).trim(), email, phone, passwordHash, { admin: true }, channel === "email"]
      );
    } else {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, password_hash, branch_id, rights, email_verified)
         VALUES ($1, 'admin', $2, $3, $4, $5, NULL, '{"admin":true}'::jsonb, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           password_hash = EXCLUDED.password_hash,
           rights = EXCLUDED.rights,
           email_verified = EXCLUDED.email_verified,
           updated_at = now()`,
        [id, String(name).trim(), email, phone, passwordHash, channel === "email"]
      );
    }
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights, status, email_verified FROM credentials WHERE id = $1", [id]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    console.error("register-owner failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "register_owner_failed" });
  }
});

router.post("/users", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const { id, name, role, email, phone, password, pin, branchId, rights = [] } = req.body || {};
  if (!id || !name || !role) return res.status(400).json({ error: "id_name_role_required" });
  const allowedRoles = new Set(["Cashier", "Supervisor", "Manager", "Admin"]);
  if (!allowedRoles.has(role)) return res.status(400).json({ error: "invalid_role" });
  const isAdmin = role === "Admin" || id === "admin";
  const isCashier = role === "Cashier" && !isAdmin;
  if (isCashier && !/^\d{4}$/.test(String(pin || ""))) return res.status(400).json({ error: "cashier_pin_required" });
  if (!isCashier && (!email || !password)) return res.status(400).json({ error: "email_password_required" });

  try {
    const credentialId = isAdmin ? "admin" : id;
    const kind = isAdmin ? "admin" : isCashier ? "cashier" : "user";
    if (isCashier) {
      const duplicatePinOwner = await pinAlreadyAssigned(pin, credentialId);
      if (duplicatePinOwner) return res.status(409).json({ error: "duplicate_pin", ownerId: duplicatePinOwner });
    }
    const pinHash = isCashier ? await bcrypt.hash(String(pin), ROUNDS) : null;
    const pinLookup = isCashier ? pinLookupHash(pin) : null;
    const passwordHash = !isCashier ? await bcrypt.hash(String(password), ROUNDS) : null;
    const normalizedEmail = !isCashier ? String(email).trim().toLowerCase() : null;
    const normalizedPhone = !isCashier && phone ? String(phone).trim() : null;
    const rightsPayload = isAdmin ? { admin: true, role: "Admin" } : Array.isArray(rights) ? { role, rights } : { ...(rights || {}), role };
    const credentialBranchId = isAdmin ? null : branchId || null;

    if (isMySql) {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, pin_lookup_hash, password_hash, branch_id, rights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON DUPLICATE KEY UPDATE
           kind = VALUES(kind),
           name = VALUES(name),
           email = VALUES(email),
           phone = VALUES(phone),
           pin_hash = VALUES(pin_hash),
           pin_lookup_hash = VALUES(pin_lookup_hash),
           password_hash = VALUES(password_hash),
           branch_id = VALUES(branch_id),
           rights = VALUES(rights),
           updated_at = NOW()`,
        [credentialId, kind, String(name).trim(), normalizedEmail, normalizedPhone, pinHash, pinLookup, passwordHash, credentialBranchId, rightsPayload]
      );
    } else {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, pin_lookup_hash, password_hash, branch_id, rights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           pin_hash = EXCLUDED.pin_hash,
           pin_lookup_hash = EXCLUDED.pin_lookup_hash,
           password_hash = EXCLUDED.password_hash,
           branch_id = EXCLUDED.branch_id,
           rights = EXCLUDED.rights,
           updated_at = now()`,
        [credentialId, kind, String(name).trim(), normalizedEmail, normalizedPhone, pinHash, pinLookup, passwordHash, credentialBranchId, rightsPayload]
      );
    }
    await q("UPDATE user_sessions SET is_active = false WHERE user_id = $1", [credentialId]);
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights, status FROM credentials WHERE id = $1", [credentialId]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    if (uniqueViolation(error)) return res.status(409).json({ error: "duplicate_pin" });
    console.error("upsert user credential failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "upsert_user_failed" });
  }
});

router.post("/users/:id/delete", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const id = String(req.params.id || "").trim();
  if (!id || id === "admin") return res.status(400).json({ error: "invalid_user_id" });
  try {
    await q(
      `UPDATE credentials
          SET status = 'deleted',
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [id]
    );
    await q("UPDATE user_sessions SET is_active = false WHERE user_id = $1", [id]);
    await audit("user_deleted", req, id, { byUser: req.account?.id || null });
    res.json({ ok: true });
  } catch (error) {
    console.error("delete user failed:", error);
    res.status(500).json({ error: "delete_user_failed" });
  }
});

router.post("/fingerprints/enroll", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const userId = String(req.body?.userId || "").trim();
  const template = String(req.body?.template || "").trim();
  const deviceSerial = String(req.body?.deviceSerial || "").trim().slice(0, 191) || null;
  if (!userId || !template) return res.status(400).json({ error: "user_and_template_required" });

  try {
    const user = await q("SELECT id, status FROM credentials WHERE id = $1 AND status = 'active'", [userId]);
    if (!user.rows[0]) return res.status(404).json({ error: "active_user_not_found" });
    const id = "fp_" + (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
    const encrypted = encryptFingerprintTemplate(template);
    const hash = fingerprintTemplateHash(template);
    if (isMySql) {
      await q(
        `INSERT INTO user_fingerprints (id, user_id, finger_template, finger_template_hash, device_serial, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
         ON DUPLICATE KEY UPDATE
           finger_template = VALUES(finger_template),
           finger_template_hash = VALUES(finger_template_hash),
           device_serial = VALUES(device_serial),
           updated_at = NOW()`,
        [id, userId, encrypted, hash, deviceSerial]
      );
    } else if (process.env.PG_MEM === "1") {
      await q("DELETE FROM user_fingerprints WHERE user_id = $1", [userId]);
      await q(
        `INSERT INTO user_fingerprints (id, user_id, finger_template, finger_template_hash, device_serial, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [id, userId, encrypted, hash, deviceSerial]
      );
    } else {
      await q(
        `INSERT INTO user_fingerprints (id, user_id, finger_template, finger_template_hash, device_serial, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())
         ON CONFLICT (user_id) DO UPDATE SET
           finger_template = EXCLUDED.finger_template,
           finger_template_hash = EXCLUDED.finger_template_hash,
           device_serial = EXCLUDED.device_serial,
           updated_at = now()`,
        [id, userId, encrypted, hash, deviceSerial]
      );
    }
    await audit("fingerprint_enrollment", req, userId, { deviceSerial });
    res.json({ ok: true, userId, deviceSerial });
  } catch (error) {
    console.error("fingerprint enroll failed:", error);
    res.status(500).json({ error: "fingerprint_enroll_failed" });
  }
});

router.post("/fingerprints/remove", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const userId = String(req.body?.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "user_required" });
  try {
    await q("DELETE FROM user_fingerprints WHERE user_id = $1", [userId]);
    await audit("fingerprint_removed", req, userId, { byUser: req.account?.id || null });
    res.json({ ok: true });
  } catch (error) {
    console.error("fingerprint remove failed:", error);
    res.status(500).json({ error: "fingerprint_remove_failed" });
  }
});

router.post("/fingerprints/templates", requireDevice, async (req, res) => {
  await ensureAuthSchema();
  try {
    const result = await q(
      isMySql
        ? `SELECT f.user_id AS userId, f.finger_template AS fingerTemplate, f.device_serial AS deviceSerial,
                  c.kind, c.name, c.email, c.phone, c.branch_id AS branchId, c.rights, c.status
             FROM user_fingerprints f
             JOIN credentials c ON c.id = f.user_id
            WHERE c.status = 'active'`
        : `SELECT f.user_id AS "userId", f.finger_template AS "fingerTemplate", f.device_serial AS "deviceSerial",
                  c.kind, c.name, c.email, c.phone, c.branch_id AS "branchId", c.rights, c.status
             FROM user_fingerprints f
             JOIN credentials c ON c.id = f.user_id
            WHERE c.status = 'active'`,
      []
    );
    const branchId = req.deviceBranchId || null;
    const visibleRows = branchId
      ? result.rows.filter((row) => row.kind === "admin" || (row.branchId || row.branch_id || null) === branchId)
      : result.rows;
    const templates = visibleRows.map((row) => ({
      userId: row.userId,
      template: decryptFingerprintTemplate(row.fingerTemplate),
      deviceSerial: row.deviceSerial || "",
      account: publicAccount({ ...row, id: row.userId, branch_id: row.branchId }),
    }));
    res.json({ ok: true, templates });
  } catch (error) {
    console.error("fingerprint template list failed:", error);
    res.status(500).json({ error: "fingerprint_templates_failed" });
  }
});

router.post("/fingerprints/login", async (req, res) => {
  await ensureAuthSchema();
  const userId = String(req.body?.userId || "").trim();
  const requestedBranchId = req.body?.branchId || null;
  const deviceSerial = String(req.body?.deviceSerial || "").trim().slice(0, 191) || null;
  if (!userId) return res.status(400).json({ error: "user_required" });
  try {
    const result = await q(
      `SELECT c.id, c.kind, c.name, c.email, c.phone, c.branch_id, c.rights, c.status
         FROM credentials c
         JOIN user_fingerprints f ON f.user_id = c.id
        WHERE c.id = $1 AND c.status = 'active'
        LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) {
      await audit("fingerprint_failed", req, userId || null, { reason: "user_or_template_not_found", deviceSerial });
      return res.status(401).json({ error: "fingerprint_not_recognized" });
    }
    let terminal = null;
    if (row.kind !== "admin") {
      terminal = await verifiedTerminalFromRequest(req, { requireRegisteredTerminal: true });
      if (terminal.error) {
        await audit("fingerprint_failed", req, userId, { reason: terminal.error, deviceSerial });
        return res.status(401).json({ error: terminal.error });
      }
      const rowBranchId = row.branch_id ?? row.branchId ?? null;
      if (!terminal.branchId || rowBranchId !== terminal.branchId || (requestedBranchId && requestedBranchId !== terminal.branchId)) {
        await audit("fingerprint_failed", req, userId, { reason: "terminal_branch_mismatch", deviceSerial, branchId: requestedBranchId || rowBranchId, terminalId: terminal.deviceId });
        return res.status(403).json({ error: "terminal_branch_mismatch" });
      }
    }
    const account = publicAccount(row);
    const session = await issueSession(req, account, terminal);
    await audit("fingerprint_login", req, account.id, { deviceSerial, sessionId: session.id });
    res.json({ ok: true, account, sessionToken: session.token, sessionId: session.id, expiresInDays: session.expiresInDays });
  } catch (error) {
    console.error("fingerprint login failed:", error);
    res.status(500).json({ error: "fingerprint_login_failed" });
  }
});

router.post("/fingerprints/checkout", async (req, res) => {
  await ensureAuthSchema();
  const token = req.body?.sessionToken || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const userId = String(req.body?.userId || "").trim();
  const branchId = req.body?.branchId || null;
  const deviceSerial = String(req.body?.deviceSerial || "").trim().slice(0, 191) || null;
  if (!token || !userId) return res.status(401).json({ error: "session_and_user_required" });
  try {
    const active = await accountForSessionToken(token);
    if (!active || active.account.id !== userId || active.account.status !== "active") {
      await audit("fingerprint_failed", req, userId || null, { reason: "invalid_session", deviceSerial, branchId });
      return res.status(401).json({ error: "invalid_session" });
    }
    const fp = await q("SELECT user_id FROM user_fingerprints WHERE user_id = $1", [userId]);
    if (!fp.rows[0]) {
      await audit("fingerprint_failed", req, userId, { reason: "template_missing", deviceSerial, branchId });
      return res.status(403).json({ error: "fingerprint_template_missing" });
    }
    await audit("fingerprint_checkout", req, userId, { deviceSerial, branchId });
    res.json({ ok: true });
  } catch (error) {
    console.error("fingerprint checkout failed:", error);
    res.status(500).json({ error: "fingerprint_checkout_failed" });
  }
});

router.post("/fingerprints/failed", async (req, res) => {
  await ensureAuthSchema();
  const userId = String(req.body?.userId || "").trim() || null;
  const reason = String(req.body?.reason || "not_recognized").slice(0, 120);
  const branchId = req.body?.branchId || null;
  const deviceSerial = String(req.body?.deviceSerial || "").trim().slice(0, 191) || null;
  await audit("fingerprint_failed", req, userId, { reason, branchId, deviceSerial });
  res.json({ ok: true });
});

router.post("/login", async (req, res) => {
  await ensureAuthSchema();
  const { identifier, password, pin, branchId } = req.body || {};
  const loginCode = String(req.body?.code || req.body?.otpCode || "").trim();
  try {
    if (pin) {
      const terminal = await verifiedTerminalFromRequest(req, { requireRegisteredTerminal: true });
      if (terminal.error) {
        await audit("login_failed", req, null, { mode: "pin", reason: terminal.error, branchId: branchId || null });
        return res.status(401).json({ error: terminal.error });
      }
      const effectiveBranchId = terminal.branchId || null;
      if (!effectiveBranchId) {
        await audit("login_failed", req, null, { mode: "pin", reason: "terminal_branch_required", terminalId: terminal.deviceId });
        return res.status(403).json({ error: "terminal_branch_required" });
      }
      if (branchId && terminal.branchId !== branchId) {
        await audit("login_failed", req, null, { mode: "pin", reason: "terminal_branch_mismatch", branchId, terminalId: terminal.deviceId });
        return res.status(403).json({ error: "terminal_branch_mismatch" });
      }
      if (!String(identifier || "").trim()) {
        await audit("login_failed", req, null, { mode: "pin", reason: "employee_identifier_required", branchId: effectiveBranchId, terminalId: terminal.deviceId });
        return res.status(400).json({ error: "employee_identifier_required" });
      }
      const result = await q(
        `SELECT id, kind, name, email, phone, branch_id, rights, status, email_verified, pin_hash
           FROM credentials
          WHERE pin_hash IS NOT NULL
            AND status = 'active'`,
        []
      );
      for (const row of result.rows) {
        const rowBranchId = row.branch_id ?? row.branchId ?? null;
        if (row.kind === "admin") continue;
        if (rowBranchId !== effectiveBranchId) continue;
        if (!matchesCredentialIdentifier(row, identifier)) continue;
        if (await bcrypt.compare(pin, row.pin_hash)) {
          const account = publicAccount(row);
          const session = await issueSession(req, account, terminal);
          return res.json({ ok: true, account, sessionToken: session.token, sessionId: session.id, expiresInDays: session.expiresInDays });
        }
      }
      await audit("login_failed", req, null, { mode: "pin", branchId: effectiveBranchId, terminalId: terminal.deviceId, identifier: String(identifier).trim().toLowerCase() });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    if (!identifier || !password) {
      return res.status(400).json({ error: "identifier_password_or_pin_required" });
    }

    const normalized = String(identifier).trim().toLowerCase();
    const result = await q(
      `SELECT id, kind, name, email, phone, branch_id, rights, status, email_verified, password_hash
         FROM credentials
        WHERE password_hash IS NOT NULL
          AND status = 'active'`,
      []
    );
    for (const row of result.rows) {
      const rowEmail = String(row.email || "").trim().toLowerCase();
      const rowPhone = String(row.phone || "").trim();
      if (rowEmail !== normalized && rowPhone !== String(identifier).trim()) continue;
      if (await bcrypt.compare(password, row.password_hash)) {
        const emailVerified = Boolean(row.email_verified ?? row.emailVerified);
        if (row.kind === "admin" && rowEmail && validTarget("email", rowEmail) && !emailVerified) {
          try {
            const expiresInMinutes = await sendAndStoreCode({ channel: "email", target: rowEmail, purpose: "email_verification" });
            await audit("email_verification_required", req, row.id, { target: maskEmail(rowEmail), expiresInMinutes });
            return res.json({
              ok: true,
              emailVerificationRequired: true,
              channel: "email",
              target: rowEmail,
              maskedTarget: maskEmail(rowEmail),
              expiresInMinutes,
              resendAfterSeconds: EMAIL_VERIFICATION_RESEND_SECONDS,
            });
          } catch (error) {
            console.error("email verification send during login failed:", error);
            await audit("email_verification_send_failed", req, row.id, { target: maskEmail(rowEmail), reason: error.message });
            return res.status(error.statusCode || 503).json({ error: "email_verification_send_failed" });
          }
        }
        if (row.kind === "admin" && adminEmailCodeEnabled()) {
          const target = normalizeTarget("email", rowEmail);
          if (!validTarget("email", target)) {
            await audit("login_failed", req, row.id, { mode: "password", reason: "admin_email_required" });
            return res.status(400).json({ error: "admin_email_required" });
          }
          if (!loginCode) {
            const expiresInMinutes = await sendAndStoreCode({ channel: "email", target, purpose: "admin_login" });
            await audit("admin_login_code_sent", req, row.id, { target: maskEmail(target), expiresInMinutes });
            return res.json({ ok: true, verificationRequired: true, channel: "email", target: maskEmail(target), expiresInMinutes });
          }
          await verifyAuthCode({ channel: "email", target, code: loginCode, purpose: "admin_login", consume: true });
        }
        const account = publicAccount(row);
        const session = await issueSession(req, account);
        return res.json({ ok: true, account, sessionToken: session.token, sessionId: session.id, expiresInDays: session.expiresInDays });
      }
    }
    await audit("login_failed", req, null, { mode: "password", identifier: normalized });
    return res.status(401).json({ error: "invalid_credentials" });
  } catch (error) {
    console.error("login failed:", error);
    const status = error.statusCode || 500;
    return res.status(status).json({ error: status >= 500 ? "login_failed" : error.message });
  }
});

router.post("/verify-pin", async (req, res) => {
  await ensureAuthSchema();
  const accountId = String(req.body?.accountId || "").trim();
  const pin = String(req.body?.pin || "").trim();
  try {
    const terminal = await verifiedTerminalFromRequest(req, { requireRegisteredTerminal: true });
    if (terminal.error) {
      await audit("checkout_pin_failed", req, accountId || null, { reason: terminal.error });
      return res.status(401).json({ error: terminal.error });
    }
    if (!accountId || !pin) {
      await audit("checkout_pin_failed", req, accountId || null, { reason: "missing_account_or_pin", terminalId: terminal.deviceId });
      return res.status(400).json({ error: "account_and_pin_required" });
    }
    const result = await q(
      `SELECT id, kind, name, branch_id, status, pin_hash
         FROM credentials
        WHERE id = $1
          AND pin_hash IS NOT NULL
        LIMIT 1`,
      [accountId]
    );
    const row = result.rows[0];
    const rowBranchId = row?.branch_id ?? row?.branchId ?? null;
    if (!row || row.status !== "active" || row.kind === "admin" || rowBranchId !== terminal.branchId) {
      await audit("checkout_pin_failed", req, accountId, { reason: "cashier_not_authorized", terminalId: terminal.deviceId, branchId: terminal.branchId });
      return res.status(403).json({ error: "cashier_not_authorized" });
    }
    const ok = await bcrypt.compare(pin, row.pin_hash);
    if (!ok) {
      await audit("checkout_pin_failed", req, accountId, { reason: "invalid_pin", terminalId: terminal.deviceId, branchId: terminal.branchId });
      return res.status(401).json({ error: "invalid_pin" });
    }
    await audit("checkout_pin_verified", req, accountId, { terminalId: terminal.deviceId, branchId: terminal.branchId });
    return res.json({ ok: true });
  } catch (error) {
    console.error("checkout pin verification failed:", error);
    return res.status(500).json({ error: "pin_verification_failed" });
  }
});

router.post("/session", async (req, res) => {
  const token = req.body?.sessionToken || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "session_required" });
  try {
    const session = await accountForSessionToken(token);
    if (!session) return res.status(401).json({ error: "invalid_session" });
    res.json({ ok: true, ...session });
  } catch (error) {
    console.error("session check failed:", error);
    res.status(500).json({ error: "session_check_failed" });
  }
});

router.post("/logout", async (req, res) => {
  const token = req.body?.sessionToken || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.json({ ok: true });
  try {
    await ensureAuthSchema();
    const active = await accountForSessionToken(token);
    await q("UPDATE user_sessions SET is_active = false WHERE token_hash = $1", [tokenHash(token)]);
    await audit("logout", req, active?.account?.id || null, { sessionId: active?.sessionId || null });
    res.json({ ok: true });
  } catch (error) {
    console.error("logout failed:", error);
    res.status(500).json({ error: "logout_failed" });
  }
});

router.get("/sessions", requireAdminOrSupervisor, async (_req, res) => {
  await ensureAuthSchema();
  const result = await q(
    isMySql
      ? `SELECT s.id, s.user_id AS userId, c.name, c.kind, c.branch_id AS branchId, s.device_name AS deviceName,
                s.ip_address AS ipAddress, s.login_time AS loginTime, s.last_seen AS lastSeen,
                s.expires_at AS expiresAt, s.is_active AS isActive
           FROM user_sessions s JOIN credentials c ON c.id = s.user_id
          ORDER BY s.last_seen DESC`
      : `SELECT s.id, s.user_id AS "userId", c.name, c.kind, c.branch_id AS "branchId", s.device_name AS "deviceName",
                s.ip_address AS "ipAddress", s.login_time AS "loginTime", s.last_seen AS "lastSeen",
                s.expires_at AS "expiresAt", s.is_active AS "isActive"
           FROM user_sessions s JOIN credentials c ON c.id = s.user_id
          ORDER BY s.last_seen DESC`,
    []
  );
  res.json({ sessions: result.rows });
});

router.post("/sessions/:id/revoke", requireAdminOrSupervisor, async (req, res) => {
  await ensureAuthSchema();
  const id = req.params.id;
  await q("UPDATE user_sessions SET is_active = false WHERE id = $1", [id]);
  await audit("session_revoked", req, req.account?.id || null, { sessionId: id });
  res.json({ ok: true });
});

function publicAccount(row) {
  const rightsPayload = row.rights && typeof row.rights === "object" ? row.rights : {};
  const rights = rightsPayload.rights || rightsPayload || {};
  const storedRole = rightsPayload.role || rightsPayload.name || rightsPayload.accountRole;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: storedRole || (row.kind === "admin" ? "Admin" : row.kind === "cashier" ? "Cashier" : "Supervisor"),
    branchId: row.branch_id ?? row.branchId ?? null,
    rights,
    status: row.status || "active",
    emailVerified: Boolean(row.email_verified ?? row.emailVerified)
  };
}

async function sendAndStoreCode({ channel, target, purpose }) {
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, ROUNDS);
  const ttl = Math.max(1, Math.min(30, parseInt(process.env.OTP_TTL_MINUTES || "10", 10)));
  await q(
    `UPDATE auth_verification_codes
        SET consumed_at = ${isMySql ? "NOW()" : "now()"}
      WHERE channel = $1
        AND target = $2
        AND purpose = $3
        AND consumed_at IS NULL`,
    [channel, target, purpose]
  );
  await q(
    isMySql
      ? `INSERT INTO auth_verification_codes (channel, target, code_hash, purpose, expires_at)
         VALUES ($1, $2, $3, $4, DATE_ADD(NOW(), INTERVAL $5 MINUTE))`
      : `INSERT INTO auth_verification_codes (channel, target, code_hash, purpose, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
    [channel, target, codeHash, purpose, ttl]
  );
  await sendVerificationCode({ channel, target, code });
  return ttl;
}

async function verifyAuthCode({ channel, target, code, purpose = "owner_signup", consume = false }) {
  const result = await q(
    `SELECT id, code_hash, attempts
       FROM auth_verification_codes
      WHERE channel = $1
        AND target = $2
        AND purpose = $3
        AND consumed_at IS NULL
        AND expires_at > ${isMySql ? "NOW()" : "now()"}
      ORDER BY created_at DESC
      LIMIT 1`,
    [channel, target, purpose]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("code_not_found_or_expired"), { statusCode: 401 });
  if (row.attempts >= 5) throw Object.assign(new Error("too_many_attempts"), { statusCode: 429 });

  const ok = await bcrypt.compare(code, row.code_hash);
  if (!ok) {
    await q("UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    throw Object.assign(new Error("invalid_code"), { statusCode: 401 });
  }
  if (consume) await q(`UPDATE auth_verification_codes SET consumed_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [row.id]);
  return true;
}

async function verifyOwnerCode(args) {
  return verifyAuthCode({ ...args, purpose: "owner_signup" });
}

export default router;
