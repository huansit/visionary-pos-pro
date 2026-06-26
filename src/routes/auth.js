import { Router } from "express";
import bcrypt from "bcryptjs";
import { isMySql, q } from "../db.js";
import { requireDevice } from "../auth.js";
import { signDeviceToken } from "../token.js";
import { generateCode, normalizeTarget, sendVerificationCode, validTarget } from "../verification.js";

const router = Router();
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

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
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights FROM credentials WHERE id = $1", [id]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    console.error("register-owner failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "register_owner_failed" });
  }
});

router.post("/users", requireDevice, async (req, res) => {
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
    const result = await q("SELECT id, kind, name, email, phone, branch_id, rights FROM credentials WHERE id = $1", [id]);
    res.json({ ok: true, account: publicAccount(result.rows[0]) });
  } catch (error) {
    console.error("upsert user credential failed:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "upsert_user_failed" });
  }
});

router.post("/login", async (req, res) => {
  const { identifier, password, pin, branchId } = req.body || {};
  try {
    if (pin) {
      const result = await q(
        `SELECT id, kind, name, branch_id, rights, pin_hash
           FROM credentials
          WHERE pin_hash IS NOT NULL
            AND ($1 IS NULL OR branch_id = $1 OR branch_id IS NULL)`,
        [branchId ?? null]
      );
      for (const row of result.rows) {
        if (await bcrypt.compare(pin, row.pin_hash)) {
          return res.json({ ok: true, account: publicAccount(row) });
        }
      }
      return res.status(401).json({ error: "invalid_credentials" });
    }

    if (!identifier || !password) {
      return res.status(400).json({ error: "identifier_password_or_pin_required" });
    }

    const normalized = String(identifier).trim().toLowerCase();
    const result = await q(
      `SELECT id, kind, name, branch_id, rights, password_hash
         FROM credentials
        WHERE password_hash IS NOT NULL
          AND (lower(email) = $1 OR phone = $2)`,
      [normalized, String(identifier).trim()]
    );
    for (const row of result.rows) {
      if (await bcrypt.compare(password, row.password_hash)) {
        return res.json({ ok: true, account: publicAccount(row) });
      }
    }
    return res.status(401).json({ error: "invalid_credentials" });
  } catch (error) {
    console.error("login failed:", error);
    return res.status(500).json({ error: "login_failed" });
  }
});

function publicAccount(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    branchId: row.branch_id,
    rights: row.rights ?? {}
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
