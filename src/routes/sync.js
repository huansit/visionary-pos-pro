import { Router } from "express";
import { isMySql, pool, q, serverNow } from "../db.js";
import { requireDevice } from "../auth.js";

const router = Router();
router.use(requireDevice);

const EVENT_TYPES = new Set([
  "invoice",
  "payment",
  "stockMovement",
  "expense",
  "borrowing",
  "endOfDay",
  "cashMovement",
  "order",
  "purchase",
  "countLog",
]);

const RECORD_TYPE_ALIASES = new Map([
  ["product", "product"],
  ["products", "product"],
  ["customer", "customer"],
  ["customers", "customer"],
  ["user", "user"],
  ["users", "user"],
  ["branch", "branch"],
  ["branches", "branch"],
  ["setting", "setting"],
  ["settings", "setting"],
  ["supplier", "supplier"],
  ["suppliers", "supplier"],
  ["supplierPrice", "supplierPrice"],
  ["supplierPrices", "supplierPrice"],
]);

function normalizeType(type) {
  return RECORD_TYPE_ALIASES.get(type) || type;
}

function hasPlainCredential(ev) {
  if (normalizeType(ev.type) !== "user") return false;
  const payload = ev.payload || {};
  return "password" in payload || "pin" in payload || "plainPassword" in payload || "plainPin" in payload;
}

router.post("/push", async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!events) return res.status(400).json({ error: "events_array_required" });

  const accepted = [];
  const serverTs = {};
  const rejected = [];
  const client = await pool.connect();
  let lastIssuedTs = serverNow();

  try {
    await client.query("BEGIN");
    for (const ev of events) {
      if (!ev || !ev.id || !ev.type) {
        rejected.push({ id: ev?.id, reason: "missing_id_or_type" });
        continue;
      }

      const type = normalizeType(ev.type);
      if (hasPlainCredential(ev)) {
        rejected.push({ id: ev.id, type, reason: "plain_password_or_pin_not_allowed" });
        continue;
      }

      if (EVENT_TYPES.has(type)) {
        const ts = await insertAppendOnlyEvent(client, ev, type, req.deviceId, nextServerTs());
        accepted.push(ev.id);
        serverTs[ev.id] = ts;
      } else if (RECORD_TYPE_ALIASES.has(ev.type)) {
        const ts = await upsertMutableRecord(client, ev, type, req.deviceId, nextServerTs());
        accepted.push(ev.id);
        serverTs[ev.id] = ts;
      } else {
        rejected.push({ id: ev.id, type: ev.type, reason: "unknown_type" });
      }
    }

    await client.query(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [req.deviceId]);
    await client.query("COMMIT");
    const cursor = Object.values(serverTs).reduce((max, ts) => Math.max(max, ts), Number(req.body?.cursor || 0));
    return res.json({ accepted, serverTs, rejected, cursor });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("push failed:", error);
    return res.status(500).json({ error: "push_failed" });
  } finally {
    client.release();
  }

  function nextServerTs() {
    lastIssuedTs = Math.max(serverNow(), lastIssuedTs + 1);
    return lastIssuedTs;
  }
});

router.get("/pull", async (req, res) => {
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 500), 2000);
  if (!Number.isFinite(since) || since < 0) return res.status(400).json({ error: "invalid_since_cursor" });
  if (!Number.isFinite(limit) || limit < 1) return res.status(400).json({ error: "invalid_limit" });

  try {
    const evs = await q(
      isMySql
        ? `SELECT id, type, branch_id AS branchId, device_id AS deviceId,
                  client_ts AS clientTs, server_ts AS serverTs, payload
             FROM events
            WHERE server_ts > $1
            ORDER BY server_ts ASC, id ASC
            LIMIT $2`
        : `SELECT id, type, branch_id AS "branchId", device_id AS "deviceId",
                  client_ts AS "clientTs", server_ts AS "serverTs", payload
             FROM events
            WHERE server_ts > $1
            ORDER BY server_ts ASC, id ASC
            LIMIT $2`,
      [since, limit]
    );
    const recs = await q(
      isMySql
        ? `SELECT id, type, branch_id AS branchId, device_id AS deviceId,
                  updated_at AS updatedAt, server_ts AS serverTs, deleted, payload
             FROM records
            WHERE server_ts > $1
            ORDER BY server_ts ASC, type ASC, id ASC
            LIMIT $2`
        : `SELECT id, type, branch_id AS "branchId", device_id AS "deviceId",
                  updated_at AS "updatedAt", server_ts AS "serverTs", deleted, payload
             FROM records
            WHERE server_ts > $1
            ORDER BY server_ts ASC, type ASC, id ASC
            LIMIT $2`,
      [since, limit]
    );
    const all = [...evs.rows, ...recs.rows].sort((a, b) => a.serverTs - b.serverTs || String(a.id).localeCompare(String(b.id)));
    const page = all.slice(0, limit);
    const cursor = page.length ? page[page.length - 1].serverTs : since;
    const hasMore = all.length > limit || evs.rows.length === limit || recs.rows.length === limit;
    res.json({ events: page, cursor, hasMore });
  } catch (error) {
    console.error("pull failed:", error);
    res.status(500).json({ error: "pull_failed" });
  }
});

async function insertAppendOnlyEvent(client, ev, type, deviceId, ts) {
  if (isMySql) {
    await client.query(
      `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ev.id, type, ev.branchId ?? null, deviceId, ev.clientTs ?? null, ts, ev.payload ?? {}]
    );
  } else {
    await client.query(
      `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [ev.id, type, ev.branchId ?? null, deviceId, ev.clientTs ?? null, ts, ev.payload ?? {}]
    );
  }

  const existing = await client.query("SELECT server_ts FROM events WHERE id = $1", [ev.id]);
  return existing.rows[0].server_ts;
}

async function upsertMutableRecord(client, ev, type, deviceId, ts) {
  const updatedAt = Number(ev.updatedAt ?? ev.clientTs ?? ts);
  if (isMySql) {
    await client.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON DUPLICATE KEY UPDATE
         branch_id = IF(VALUES(updated_at) >= updated_at, VALUES(branch_id), branch_id),
         device_id = IF(VALUES(updated_at) >= updated_at, VALUES(device_id), device_id),
         updated_at = IF(VALUES(updated_at) >= updated_at, VALUES(updated_at), updated_at),
         deleted = IF(VALUES(updated_at) >= updated_at, VALUES(deleted), deleted),
         payload = IF(VALUES(updated_at) >= updated_at, VALUES(payload), payload),
         server_ts = IF(VALUES(updated_at) >= updated_at, VALUES(server_ts), server_ts)`,
      [ev.id, type, ev.branchId ?? null, deviceId, updatedAt, ts, !!ev.deleted, ev.payload ?? {}]
    );
  } else {
    await client.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (type, id) DO UPDATE SET
         branch_id = EXCLUDED.branch_id,
         device_id = EXCLUDED.device_id,
         updated_at = EXCLUDED.updated_at,
         deleted = EXCLUDED.deleted,
         payload = EXCLUDED.payload,
         server_ts = EXCLUDED.server_ts
       WHERE EXCLUDED.updated_at >= records.updated_at`,
      [ev.id, type, ev.branchId ?? null, deviceId, updatedAt, ts, !!ev.deleted, ev.payload ?? {}]
    );
  }

  const existing = await client.query(
    "SELECT server_ts FROM records WHERE type = $1 AND id = $2",
    [type, ev.id]
  );
  return existing.rows[0].server_ts;
}

export default router;
