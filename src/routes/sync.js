import { Router } from "express";
import { isMySql, pool, q, serverNow } from "../db.js";
import { requireDevice } from "../auth.js";
import { addRealtimeClient, getLatestRealtimeChange, getRealtimeVersion, publishSyncChange } from "../realtime.js";

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
  const change = getLatestRealtimeChange();
  res.json({ version: getRealtimeVersion(), ts: Date.now(), change });
});

function numberFromPayload(payload = {}, fields = [], fallback = 0) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function centsFromPayload(payload = {}, centFields = [], moneyFields = [], fallback = 0) {
  for (const field of centFields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.round(value);
  }
  for (const field of moneyFields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.round(value * 100);
  }
  return fallback;
}

function normalizeCode(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function productCatalogKey(row) {
  const payload = row.payload || {};
  const catalogId = normalizeCode(payload.barcodeCatalogId || payload.barcode_catalog_id);
  if (catalogId) return `catalog:${catalogId}`;
  const sku = normalizeCode(payload.sku);
  if (sku) return `sku:${sku}`;
  const barcode = normalizeCode(payload.barcode || (Array.isArray(payload.barcodes) ? payload.barcodes[0] : ""));
  if (barcode) return `barcode:${barcode}`;
  return `name:${normalizeCode(payload.name)}:${normalizeCode(payload.size || payload.unit)}`;
}

function productCompletenessScore(row) {
  const payload = row.payload || {};
  return (
    (centsFromPayload(payload, ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"], ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"]) > 0 ? 16 : 0) +
    (centsFromPayload(payload, ["costCents", "costPriceCents", "cost_price_cents", "buyingPriceCents"], ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"]) > 0 ? 8 : 0) +
    (payload.image || payload.imageUrl || payload.image_url || payload.photo ? 4 : 0) +
    (payload.barcode || (Array.isArray(payload.barcodes) && payload.barcodes.length) ? 2 : 0) +
    (payload.name ? 1 : 0)
  );
}

function preferCatalogRecord(current, candidate) {
  if (!current) return candidate;
  const currentScore = productCompletenessScore(current);
  const candidateScore = productCompletenessScore(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return Number(candidate.serverTs || candidate.updatedAt || 0) >= Number(current.serverTs || current.updatedAt || 0)
    ? candidate
    : current;
}

function normalizeProduct(row, branchId, stockQty) {
  const payload = row.payload || {};
  const sku = String(payload.sku || "").trim();
  const barcode = String(payload.barcode || "").trim();
  return {
    id: String(row.id),
    branchId,
    name: payload.name || "Unnamed product",
    sku,
    size: payload.size || payload.unit || "",
    barcode,
    barcodes: Array.isArray(payload.barcodes) ? payload.barcodes : [],
    barcodeCatalogId: payload.barcodeCatalogId || payload.barcode_catalog_id || null,
    category: payload.category || payload.categoryId || "Uncategorised",
    categoryId: payload.categoryId || payload.category || "",
    image: payload.image || payload.imageUrl || payload.image_url || payload.photo || "",
    priceCents: centsFromPayload(payload, ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"], ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"]),
    costCents: centsFromPayload(payload, ["costCents", "costPriceCents", "cost_price_cents", "buyingPriceCents"], ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"]),
    stockQty,
    serverTs: Number(row.serverTs || row.updatedAt || 0),
  };
}

router.get("/catalog", async (req, res) => {
  const branchId = req.deviceBranchId;
  if (!branchId) return res.status(403).json({ error: "terminal_branch_required" });

  try {
    const records = await q(
      isMySql
        ? `SELECT id, branch_id AS branchId, updated_at AS updatedAt, server_ts AS serverTs, payload
             FROM records
            WHERE type = 'product' AND deleted = false
            ORDER BY server_ts DESC, id ASC`
        : `SELECT id, branch_id AS "branchId", updated_at AS "updatedAt", server_ts AS "serverTs", payload
             FROM records
            WHERE type = 'product' AND deleted = false
            ORDER BY server_ts DESC, id ASC`
    );

    const stockEvents = await q(
      isMySql
        ? `SELECT id, branch_id AS branchId, payload
             FROM events
            WHERE type = 'stockMovement'
              AND (branch_id = $1 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branchId')) = $1 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branch_id')) = $1)`
        : `SELECT id, branch_id AS "branchId", payload
             FROM events
            WHERE type = 'stockMovement'
              AND (branch_id = $1 OR payload->>'branchId' = $1 OR payload->>'branch_id' = $1)`,
      [branchId]
    );

    const byKey = new Map();
    for (const row of records.rows) {
      const recordBranchId = row.branchId || row.payload?.branchId || row.payload?.branch_id || "";
      if (recordBranchId && recordBranchId !== branchId) continue;
      const key = productCatalogKey(row);
      byKey.set(key, preferCatalogRecord(byKey.get(key), row));
    }

    const canonicalIds = new Set([...byKey.values()].map((row) => String(row.id)));
    const stockByProduct = new Map();
    for (const row of stockEvents.rows) {
      const payload = row.payload || {};
      const productId = String(payload.productId || payload.product_id || "");
      if (!productId || !canonicalIds.has(productId)) continue;
      const qty = Number(payload.qty ?? payload.quantity ?? 0);
      if (!Number.isFinite(qty)) continue;
      stockByProduct.set(productId, (stockByProduct.get(productId) || 0) + qty);
    }

    const products = [...byKey.values()]
      .map((row) => {
        const baseStock = numberFromPayload(row.payload || {}, ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand"], 0);
        return normalizeProduct(row, branchId, baseStock + (stockByProduct.get(String(row.id)) || 0));
      })
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.sku || "").localeCompare(String(b.sku || "")));

    res.json({ branchId, products, total: products.length });
  } catch (error) {
    console.error("catalog failed:", error);
    res.status(500).json({ error: "catalog_failed" });
  }
});

const EVENT_TYPES = new Set([
  "invoice",
  "payment",
  "invoiceNote",
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
  ["expenseCategory", "expenseCategory"],
  ["expenseCategories", "expenseCategory"],
  ["expense_category", "expenseCategory"],
  ["expense_categories", "expenseCategory"],
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

const TERMINAL_FORBIDDEN_RECORD_TYPES = new Set(["branch", "setting", "user", "expenseCategory"]);
const TERMINAL_FORBIDDEN_EVENT_TYPES = new Set(["borrowing", "cashMovement", "endOfDay", "payment", "purchase"]);

function normalizeType(type) {
  return RECORD_TYPE_ALIASES.get(type) || type;
}

function hasPlainCredential(ev) {
  if (normalizeType(ev.type) !== "user") return false;
  const payload = ev.payload || {};
  return "password" in payload || "pin" in payload || "plainPassword" in payload || "plainPin" in payload;
}

function eventBranchId(ev) {
  return ev?.branchId ?? ev?.payload?.branchId ?? null;
}

function enforceTerminalBranch(req, ev, type) {
  if (!req.deviceBranchId) return { ok: true, event: ev };
  if (type === "product") return { ok: true, event: { ...ev, branchId: null } };
  const submittedBranchId = eventBranchId(ev);
  if (submittedBranchId && submittedBranchId !== req.deviceBranchId) {
    return { ok: false, reason: "terminal_branch_mismatch" };
  }
  const payload = { ...(ev.payload || {}) };
  if (req.terminalUuid && (EVENT_TYPES.has(type) || payload.branchId)) payload.branchId = req.deviceBranchId;
  if (!req.terminalUuid && payload.branchId) payload.branchId = req.deviceBranchId;
  return {
    ok: true,
    event: {
      ...ev,
      branchId: req.deviceBranchId,
      payload,
    },
  };
}

function enforceTerminalWritePolicy(req, type) {
  if (!req.terminalUuid) return { ok: true };
  if (TERMINAL_FORBIDDEN_RECORD_TYPES.has(type) || TERMINAL_FORBIDDEN_EVENT_TYPES.has(type)) {
    return { ok: false, reason: "terminal_write_not_allowed" };
  }
  return { ok: true };
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
      const writePolicy = enforceTerminalWritePolicy(req, type);
      if (!writePolicy.ok) {
        rejected.push({ id: ev.id, type, reason: writePolicy.reason });
        continue;
      }
      const branchGuard = enforceTerminalBranch(req, ev, type);
      if (!branchGuard.ok) {
        rejected.push({ id: ev.id, type, reason: branchGuard.reason });
        continue;
      }
      const guardedEvent = branchGuard.event;
      if (hasPlainCredential(ev)) {
        rejected.push({ id: ev.id, type, reason: "plain_password_or_pin_not_allowed" });
        continue;
      }

      if (EVENT_TYPES.has(type)) {
        const ts = await insertAppendOnlyEvent(client, guardedEvent, type, req.deviceId, nextServerTs());
        accepted.push(guardedEvent.id);
        serverTs[guardedEvent.id] = ts;
      } else if (RECORD_TYPE_ALIASES.has(ev.type)) {
        const ts = await upsertMutableRecord(client, guardedEvent, type, req.deviceId, nextServerTs());
        if (type === "product") await propagateProductGlobalFields(client, guardedEvent, req.deviceId, ts);
        accepted.push(guardedEvent.id);
        serverTs[guardedEvent.id] = ts;
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

function productSkuKey(payload = {}) {
  return String(payload.sku || "").trim().toLowerCase();
}

function sanitizeSharedProductPayload(payload = {}) {
  const next = { ...payload };
  delete next.branchId;
  delete next.branch_id;
  delete next.branch;
  for (const key of ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand"]) {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = 0;
  }
  return next;
}

async function upsertProductRecordBySku(client, ev, deviceId, ts) {
  const updatedAt = Number(ev.updatedAt ?? ev.clientTs ?? ts);
  const payload = sanitizeSharedProductPayload(ev.payload ?? {});
  const skuKey = productSkuKey(payload);

  if (!skuKey || ev.deleted) {
    await client.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1,'product',NULL,$2,$3,$4,$5,$6)
       ON CONFLICT (type, id) DO UPDATE SET
         branch_id = NULL,
         device_id = EXCLUDED.device_id,
         updated_at = EXCLUDED.updated_at,
         deleted = EXCLUDED.deleted,
         payload = EXCLUDED.payload,
         server_ts = EXCLUDED.server_ts
       WHERE EXCLUDED.updated_at >= records.updated_at`,
      [ev.id, deviceId, updatedAt, ts, !!ev.deleted, payload]
    );
    const existing = await client.query("SELECT server_ts FROM records WHERE type = 'product' AND id = $1", [ev.id]);
    return existing.rows[0].server_ts;
  }

  const existing = await client.query(
    `SELECT id, payload, updated_at AS "updatedAt"
     FROM records
     WHERE type = 'product'
       AND deleted = false
       AND lower(payload->>'sku') = $1
     ORDER BY updated_at DESC, server_ts DESC, id ASC
     LIMIT 1`,
    [skuKey]
  );
  const existingProduct = existing.rows[0];

  if (existingProduct && existingProduct.id === ev.id) {
    if (Number(existingProduct.updatedAt || 0) <= updatedAt) {
      const merged = sanitizeSharedProductPayload({ ...(existingProduct.payload || {}), ...payload });
      await client.query(
        `UPDATE records
         SET branch_id = NULL,
             device_id = $2,
             updated_at = $3,
             deleted = false,
             payload = $4,
             server_ts = $5
         WHERE type = 'product' AND id = $1`,
        [ev.id, deviceId, updatedAt, merged, ts]
      );
    }
    const updated = await client.query("SELECT server_ts FROM records WHERE type = 'product' AND id = $1", [ev.id]);
    return updated.rows[0].server_ts;
  }

  if (existingProduct && existingProduct.id !== ev.id) {
    const merged = sanitizeSharedProductPayload({ ...(existingProduct.payload || {}), ...payload });
    await client.query(
      `UPDATE records
       SET branch_id = NULL,
           device_id = $2,
           updated_at = GREATEST(updated_at, $3),
           deleted = false,
           payload = $4,
           server_ts = $5
       WHERE type = 'product' AND id = $1`,
      [existingProduct.id, deviceId, updatedAt, merged, ts]
    );
    await client.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1,'product',NULL,$2,$3,$4,true,$5)
       ON CONFLICT (type, id) DO UPDATE SET
         branch_id = NULL,
         device_id = EXCLUDED.device_id,
         updated_at = EXCLUDED.updated_at,
         deleted = true,
         payload = EXCLUDED.payload,
         server_ts = EXCLUDED.server_ts
       WHERE EXCLUDED.updated_at >= records.updated_at`,
      [ev.id, deviceId, updatedAt, ts, { ...payload, dedupedInto: existingProduct.id }]
    );
    const updated = await client.query("SELECT server_ts FROM records WHERE type = 'product' AND id = $1", [existingProduct.id]);
    return updated.rows[0].server_ts;
  }

  await client.query(
    `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
     VALUES ($1,'product',NULL,$2,$3,$4,false,$5)
     ON CONFLICT (type, id) DO UPDATE SET
       branch_id = NULL,
       device_id = EXCLUDED.device_id,
       updated_at = EXCLUDED.updated_at,
       deleted = false,
       payload = EXCLUDED.payload,
       server_ts = EXCLUDED.server_ts
     WHERE EXCLUDED.updated_at >= records.updated_at`,
    [ev.id, deviceId, updatedAt, ts, payload]
  );
  const inserted = await client.query("SELECT server_ts FROM records WHERE type = 'product' AND id = $1", [ev.id]);
  return inserted.rows[0].server_ts;
}

async function upsertMutableRecord(client, ev, type, deviceId, ts) {
  const updatedAt = Number(ev.updatedAt ?? ev.clientTs ?? ts);
  if (!isMySql && type === "product") return upsertProductRecordBySku(client, ev, deviceId, ts);
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
  const updatedAt = Number(ev.updatedAt ?? ev.clientTs ?? ts);

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
           server_ts = $6
       WHERE type = $1 AND id = $2`,
      ["product", row.id, { ...payload, ...patch }, deviceId, updatedAt, ts]
    );
  }
}

export default router;
