import { Router } from "express";
import { isMySql, pool, q, serverNow } from "../db.js";
import { requireDevice } from "../auth.js";
import { addRealtimeClient, getRealtimeVersion, publishSyncChange } from "../realtime.js";

const router = Router();
router.use(requireDevice);
router.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[sync] ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs.toFixed(1)}ms device=${req.deviceId || "-"} branch=${req.deviceBranchId || "-"}`);
  });
  next();
});

router.get("/stream", (req, res) => {
  addRealtimeClient(req, res);
});

router.get("/version", (_req, res) => {
  res.json({ version: getRealtimeVersion(), ts: Date.now() });
});

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
  ["barcodeCatalog", "barcodeCatalog"],
  ["barcode_catalog", "barcodeCatalog"],
  ["barcodes", "barcodeCatalog"],
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
        if (type === "product") await propagateProductGlobalFields(client, ev, req.deviceId, ts);
        accepted.push(ev.id);
        serverTs[ev.id] = ts;
      } else {
        rejected.push({ id: ev.id, type: ev.type, reason: "unknown_type" });
      }
    }

    await client.query(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [req.deviceId]);
    await client.query("COMMIT");
    const cursor = Object.values(serverTs).reduce((max, ts) => Math.max(max, ts), Number(req.body?.cursor || 0));
    if (accepted.length) {
      const changedTypes = [...new Set(events.filter((ev) => accepted.includes(ev.id)).map((ev) => normalizeType(ev.type)))];
      publishSyncChange({
        sourceDeviceId: req.deviceId,
        branchId: req.deviceBranchId || null,
        cursor,
        accepted: accepted.length,
        types: changedTypes,
      });
    }
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

const PRODUCT_GLOBAL_FIELDS = [
  "name",
  "sku",
  "barcode",
  "barcodes",
  "barcodeCatalogId",
  "barcodeCatalogIds",
  "category",
  "categoryId",
  "brand",
  "unit",
  "size",
  "image",
  "imageUrl",
  "description",
  "status",
  "costCents",
  "costPrice",
  "costPriceCents",
  "cost_price",
  "cost_price_cents",
];

function productGlobalKey(payload = {}) {
  const catalogId = String(payload.barcodeCatalogId || payload.barcode_catalog_id || "").trim().toLowerCase();
  if (catalogId) return `catalog:${catalogId}`;
  const code = String(payload.barcode || payload.sku || "").trim().replace(/\s+/g, "").toLowerCase();
  return code ? `code:${code}` : "";
}

function productGlobalPatch(payload = {}) {
  const patch = {};
  for (const field of PRODUCT_GLOBAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== undefined) {
      patch[field] = payload[field];
    }
  }
  return patch;
}

async function propagateProductGlobalFields(client, ev, deviceId, ts) {
  const incomingPayload = ev.payload || {};
  const key = productGlobalKey(incomingPayload);
  if (!key) return;
  const patch = productGlobalPatch(incomingPayload);
  if (!Object.keys(patch).length) return;

  const existing = await client.query(
    "SELECT id, payload FROM records WHERE type = $1 AND deleted = $2",
    ["product", false]
  );
  for (const row of existing.rows) {
    const payload = row.payload || {};
    if (row.id === ev.id) continue;
    if (productGlobalKey(payload) !== key) continue;
    await client.query(
      `UPDATE records
       SET payload = $3,
           device_id = $4,
           updated_at = $5,
           server_ts = $5
       WHERE type = $1 AND id = $2`,
      ["product", row.id, { ...payload, ...patch }, deviceId, ts]
    );
  }
}

export default router;
