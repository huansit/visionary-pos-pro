import { Router } from "express";
import bcrypt from "bcryptjs";
import { q } from "../db.js";
import { signDeviceToken } from "../token.js";

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
  res.json({ deviceId, token });
});

router.post("/login", async (req, res) => {
  const { identifier, password, pin, branchId } = req.body || {};
  try {
    if (pin) {
      const result = await q(
        `SELECT id, kind, name, branch_id, rights, pin_hash
           FROM credentials
          WHERE pin_hash IS NOT NULL
            AND ($1::text IS NULL OR branch_id = $1 OR branch_id IS NULL)`,
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

export default router;
