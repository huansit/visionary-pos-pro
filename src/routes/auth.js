import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { isMySql, q } from "../db.js";
import { requireDevice } from "../auth.js";
import { signDeviceToken } from "../token.js";
import { generateCode, normalizeTarget, sendVerificationCode, validTarget } from "../verification.js";

const router = Router();
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);
const SESSION_DAYS = Math.max(1, Math.min(90, parseInt(process.env.AUTH_SESSION_DAYS || "14", 10)));
const SINGLE_SESSION = process.env.AUTH_SINGLE_SESSION === "1";
let authSchemaReady = null;

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function requestMeta(req) {
  return {
    deviceName: String(req.body?.deviceName || req.headers["x-device-name"] || "Web POS").slice(0, 255),
    ipAddress: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 80),
  };
}

async function ensureAuthSchema() {
  if (authSchemaReady) return authSchemaReady;
  authSchemaReady = (async () => {
    const pgMem = process.env.PG_MEM === "1";
    const statements = isMySql
      ? [
          "ALTER TABLE credentials ADD COLUMN status enum('active','inactive','deleted') NOT NULL DEFAULT 'active'",
          "ALTER TABLE credentials ADD COLUMN last_login datetime",
          "ALTER TABLE credentials ADD COLUMN created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP",
          "CREATE INDEX credentials_status_idx ON credentials (status)",
          `CREATE TABLE IF NOT EXISTS user_sessions (
             id varchar(191) PRIMARY KEY,
             user_id varchar(191) NOT NULL,
             token_hash varchar(255) NOT NULL UNIQUE,
             device_name varchar(255),
             ip_address varchar(80),
             login_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             last_seen datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
             expires_at datetime NOT NULL,
             is_active boolean NOT NULL DEFAULT true
           )`,
          "CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, is_active)",
          "CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at)",
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
        ]
      : [
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS last_login timestamptz",
          "ALTER TABLE credentials ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()",
          "CREATE INDEX IF NOT EXISTS credentials_status_idx ON credentials (status)",
          pgMem
            ? `CREATE TABLE IF NOT EXISTS user_sessions (
               id text,
               user_id text,
               token_hash text,
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
               device_name text,
               ip_address text,
               login_time timestamptz NOT NULL DEFAULT now(),
               last_seen timestamptz NOT NULL DEFAULT now(),
               expires_at timestamptz NOT NULL,
               is_active boolean NOT NULL DEFAULT true
             )`,
          "CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_idx ON user_sessions (token_hash)",
          "CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx ON user_sessions (user_id, is_active)",
          "CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at)",
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

async function issueSession(req, account) {
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
      ? `INSERT INTO user_sessions (id, user_id, token_hash, device_name, ip_address, login_time, last_seen, expires_at, is_active)
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),DATE_ADD(NOW(), INTERVAL $6 DAY),true)`
      : `INSERT INTO user_sessions (id, user_id, token_hash, device_name, ip_address, login_time, last_seen, expires_at, is_active)
         VALUES ($1,$2,$3,$4,$5,now(),now(),now() + ($6 || ' days')::interval,true)`,
    [id, account.id, tokenHash(token), deviceName, ipAddress, SESSION_DAYS]
  );
  await q(`UPDATE credentials SET last_login = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [account.id]);
  await audit("login_success", req, account.id, { sessionId: id });
  return { id, token, expiresInDays: SESSION_DAYS };
}

async function accountForSessionToken(token) {
  await ensureAuthSchema();
  const result = await q(
    `SELECT s.id AS session_id, s.expires_at, s.is_active,
            c.id, c.kind, c.name, c.email, c.phone, c.branch_id, c.rights, c.status
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
  await q(`UPDATE user_sessions SET last_seen = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [row.session_id ?? row.sessionId]);
  return { sessionId: row.session_id ?? row.sessionId, account: publicAccount(row) };
}

router.post("/device", async (req, res) => {
  const { deviceId, name, branchId = null, setupKey } = req.body || {};
  if (!deviceId || !name) return res.status(400).json({ error: "deviceId_and_name_required" });
  if (process.env.DEVICE_SETUP_KEY && setupKey !== process.env.DEVICE_SETUP_KEY) {
    return res.status(401).json({ error: "invalid_setup_key" });
  }

  const token = signDeviceToken(deviceId);
  const tokenHash = await bcrypt.hash(token, ROUNDS);
  if (isMySql) {
    await q(
      `INSERT INTO devices (device_id, name, branch_id, token_hash, revoked_at, last_seen_at)
       VALUES ($1,$2,$3,$4,NULL,NOW())
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         branch_id = VALUES(branch_id),
         token_hash = VALUES(token_hash),
         revoked_at = NULL,
         last_seen_at = NOW()`,
      [deviceId, name, branchId, tokenHash]
    );
  } else {
    await q(
      `INSERT INTO devices (device_id, name, branch_id, token_hash, revoked_at, last_seen_at)
       VALUES ($1,$2,$3,$4,NULL, now())
       ON CONFLICT (device_id) DO UPDATE SET
         name = EXCLUDED.name,
         branch_id = EXCLUDED.branch_id,
         token_hash = EXCLUDED.token_hash,
         revoked_at = NULL,
         last_seen_at = now()`,
      [deviceId, name, branchId, tokenHash]
    );
  }
  res.json({ deviceId, token });
});

router.post("/send-code", async (req, res) => {
  const channel = req.body?.channel === "phone" ? "phone" : "email";
  const target = normalizeTarget(channel, req.body?.target);
  if (!validTarget(channel, target)) return res.status(400).json({ error: "invalid_target" });

  try {
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, ROUNDS);
    const ttl = Math.max(1, Math.min(30, parseInt(process.env.OTP_TTL_MINUTES || "10", 10)));
    await q(
      isMySql
        ? `INSERT INTO auth_verification_codes (channel, target, code_hash, purpose, expires_at)
           VALUES ($1, $2, $3, 'owner_signup', DATE_ADD(NOW(), INTERVAL $4 MINUTE))`
        : `INSERT INTO auth_verification_codes (channel, target, code_hash, purpose, expires_at)
           VALUES ($1, $2, $3, 'owner_signup', now() + ($4 || ' minutes')::interval)`,
      [channel, target, codeHash, ttl]
    );
    await sendVerificationCode({ channel, target, code });
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
        `INSERT INTO credentials (id, kind, name, email, phone, password_hash, branch_id, rights)
         VALUES ($1, 'admin', $2, $3, $4, $5, NULL, $6)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           email = VALUES(email),
           phone = VALUES(phone),
           password_hash = VALUES(password_hash),
           rights = VALUES(rights),
           updated_at = NOW()`,
        [id, String(name).trim(), email, phone, passwordHash, { admin: true }]
      );
    } else {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, password_hash, branch_id, rights)
         VALUES ($1, 'admin', $2, $3, $4, $5, NULL, '{"admin":true}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           password_hash = EXCLUDED.password_hash,
           rights = EXCLUDED.rights,
           updated_at = now()`,
        [id, String(name).trim(), email, phone, passwordHash]
      );
    }
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights, status FROM credentials WHERE id = $1", [id]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    console.error("register-owner failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "register_owner_failed" });
  }
});

router.post("/users", requireDevice, async (req, res) => {
  await ensureAuthSchema();
  const { id, name, role, email, password, pin, branchId, rights = [] } = req.body || {};
  if (!id || !name || !role) return res.status(400).json({ error: "id_name_role_required" });
  const isCashier = role === "Cashier";
  if (isCashier && !/^\d{4}$/.test(String(pin || ""))) return res.status(400).json({ error: "cashier_pin_required" });
  if (!isCashier && (!email || !password)) return res.status(400).json({ error: "email_password_required" });

  try {
    const kind = isCashier ? "cashier" : "user";
    const pinHash = isCashier ? await bcrypt.hash(String(pin), ROUNDS) : null;
    const passwordHash = !isCashier ? await bcrypt.hash(String(password), ROUNDS) : null;
    const normalizedEmail = !isCashier ? String(email).trim().toLowerCase() : null;
    const rightsPayload = Array.isArray(rights) ? { rights } : rights;

    if (isMySql) {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)
         ON DUPLICATE KEY UPDATE
           kind = VALUES(kind),
           name = VALUES(name),
           email = VALUES(email),
           pin_hash = VALUES(pin_hash),
           password_hash = VALUES(password_hash),
           branch_id = VALUES(branch_id),
           rights = VALUES(rights),
           updated_at = NOW()`,
        [id, kind, String(name).trim(), normalizedEmail, pinHash, passwordHash, branchId || null, rightsPayload]
      );
    } else {
      await q(
        `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           pin_hash = EXCLUDED.pin_hash,
           password_hash = EXCLUDED.password_hash,
           branch_id = EXCLUDED.branch_id,
           rights = EXCLUDED.rights,
           updated_at = now()`,
        [id, kind, String(name).trim(), normalizedEmail, pinHash, passwordHash, branchId || null, rightsPayload]
      );
    }
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights, status FROM credentials WHERE id = $1", [id]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    console.error("upsert user credential failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "upsert_user_failed" });
  }
});

router.post("/login", async (req, res) => {
  await ensureAuthSchema();
  const { identifier, password, pin, branchId } = req.body || {};
  try {
    if (pin) {
      const result = await q(
        `SELECT id, kind, name, branch_id, rights, status, pin_hash
           FROM credentials
          WHERE pin_hash IS NOT NULL
            AND status = 'active'`,
        []
      );
      for (const row of result.rows) {
        const rowBranchId = row.branch_id ?? row.branchId ?? null;
        if (branchId && rowBranchId && rowBranchId !== branchId) continue;
        if (await bcrypt.compare(pin, row.pin_hash)) {
          const account = publicAccount(row);
          const session = await issueSession(req, account);
          return res.json({ ok: true, account, sessionToken: session.token, sessionId: session.id, expiresInDays: session.expiresInDays });
        }
      }
      await audit("login_failed", req, null, { mode: "pin", branchId: branchId || null });
      return res.status(401).json({ error: "invalid_credentials" });
    }

    if (!identifier || !password) {
      return res.status(400).json({ error: "identifier_password_or_pin_required" });
    }

    const normalized = String(identifier).trim().toLowerCase();
    const result = await q(
      `SELECT id, kind, name, email, phone, branch_id, rights, status, password_hash
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
        const account = publicAccount(row);
        const session = await issueSession(req, account);
        return res.json({ ok: true, account, sessionToken: session.token, sessionId: session.id, expiresInDays: session.expiresInDays });
      }
    }
    await audit("login_failed", req, null, { mode: "password", identifier: normalized });
    return res.status(401).json({ error: "invalid_credentials" });
  } catch (error) {
    console.error("login failed:", error);
    return res.status(500).json({ error: "login_failed" });
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

router.get("/sessions", requireDevice, async (_req, res) => {
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

router.post("/sessions/:id/revoke", requireDevice, async (req, res) => {
  await ensureAuthSchema();
  const id = req.params.id;
  await q("UPDATE user_sessions SET is_active = false WHERE id = $1", [id]);
  await audit("session_revoked", req, null, { sessionId: id, byDevice: req.deviceId });
  res.json({ ok: true });
});

function publicAccount(row) {
  const rights = row.rights?.rights || row.rights || {};
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: row.kind === "admin" ? "Admin" : row.kind === "cashier" ? "Cashier" : "Supervisor",
    branchId: row.branch_id ?? row.branchId ?? null,
    rights,
    status: row.status || "active"
  };
}

async function verifyOwnerCode({ channel, target, code, consume = false }) {
  const result = await q(
    `SELECT id, code_hash, attempts
       FROM auth_verification_codes
      WHERE channel = $1
        AND target = $2
        AND purpose = 'owner_signup'
        AND consumed_at IS NULL
        AND expires_at > ${isMySql ? "NOW()" : "now()"}
      ORDER BY created_at DESC
      LIMIT 1`,
    [channel, target]
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

export default router;
