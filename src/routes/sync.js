import { Router } from "express";
import { isMySql, isPgMem, pool, q, serverNow } from "../db.js";
import { loadUserSession, requireDevice } from "../auth.js";
import { addRealtimeClient, getLatestRealtimeChange, getRealtimeVersion, publishSyncChange } from "../realtime.js";

const router = Router();

const MANAGEMENT_SYNC_ROLES = new Set(["owner", "admin", "manager", "supervisor"]);

function sessionTokenFromSyncRequest(req) {
  return String(req.get("x-session-token") || req.query?.sessionToken || req.body?.sessionToken || "").trim();
}

function syncRole(account = {}) {
  return String(account.role || account.kind || account.rights?.role || "").toLowerCase();
}

function syncActorId(req) {
  return req.deviceId || (req.account?.id ? `session:${req.account.id}` : "unknown");
}

function syncRecordDeviceId(req) {
  return req.deviceId || null;
}

async function trySessionSync(req, res) {
  const token = sessionTokenFromSyncRequest(req);
  if (!token) return "none";
  const session = await loadUserSession(token);
  if (!session) {
    res.status(401).json({ error: "invalid_or_missing_user_session" });
    return "handled";
  }
  if (!MANAGEMENT_SYNC_ROLES.has(syncRole(session.account))) {
    res.status(403).json({ error: "insufficient_role" });
    return "handled";
  }
  req.sessionId = session.sessionId;
  req.account = session.account;
  req.syncActor = "session";
  return "ok";
}

async function requireSyncRead(req, res, next) {
  try {
    const sessionResult = await trySessionSync(req, res);
    if (sessionResult === "handled") return;
    if (sessionResult === "ok") return next();
    return requireDevice(req, res, next);
  } catch (err) {
    return next(err);
  }
}

async function requireSyncWrite(req, res, next) {
  try {
    const sessionResult = await trySessionSync(req, res);
    if (sessionResult === "handled") return;
    if (sessionResult === "ok") return next();
    return requireDevice(req, res, next);
  } catch (err) {
    return next(err);
  }
}
router.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[sync] ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs.toFixed(1)}ms actor=${req.deviceId || req.account?.id || "-"} branch=${req.deviceBranchId || req.account?.branchId || "-"}`);
  });
  next();
});

router.get("/stream", requireSyncRead, (req, res) => {
  addRealtimeClient(req, res);
});

router.get("/version", requireSyncRead, (_req, res) => {
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

const PRODUCT_PRICE_CENT_FIELDS = ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"];
const PRODUCT_PRICE_MONEY_FIELDS = ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"];
const PRODUCT_COST_CENT_FIELDS = [
  "costCents",
  "costPriceCents",
  "cost_price_cents",
  "buyingPriceCents",
  "movingAverageCostCents",
  "averageCostCents",
];
const PRODUCT_COST_MONEY_FIELDS = ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"];
const PRODUCT_STOCK_FIELDS = ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand", "currentStock", "current_stock"];

function fieldCentsFromPayload(payload = {}, centFields = [], moneyFields = []) {
  for (const field of centFields) {
    const raw = payload[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.round(value);
  }
  for (const field of moneyFields) {
    const raw = payload[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.round(value * 100);
  }
  return null;
}

function mapValueForBranch(map, branchId) {
  if (!map || typeof map !== "object" || !branchId) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, branchId)) return map[branchId];
  const wanted = String(branchId).toLowerCase();
  const match = Object.entries(map).find(([key]) => String(key).toLowerCase() === wanted);
  return match ? match[1] : undefined;
}

function branchValueFromMap(payload = {}, mapNames = [], branchId = "") {
  for (const name of mapNames) {
    const value = mapValueForBranch(payload[name], branchId);
    if (value !== undefined) return value;
  }
  return undefined;
}

function centsFromBranchValue(
  value,
  centFields = PRODUCT_PRICE_CENT_FIELDS,
  moneyFields = PRODUCT_PRICE_MONEY_FIELDS,
) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    return fieldCentsFromPayload(value, centFields, moneyFields);
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function stockFromBranchValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return numberFromPayload(value, PRODUCT_STOCK_FIELDS, null);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function productOverlayFromPayload(payload = {}, branchId = "") {
  const overlay = {};
  const priceFromMap = centsFromBranchValue(branchValueFromMap(payload, ["branchPrices", "priceByBranch", "sellingPrices", "sellingPriceByBranch", "branchSellingPrices"], branchId));
  const costFromMap = centsFromBranchValue(
    branchValueFromMap(payload, ["branchCosts", "costByBranch", "movingAverageCostByBranch", "averageCostByBranch", "branchMovingAverageCosts"], branchId),
    PRODUCT_COST_CENT_FIELDS,
    PRODUCT_COST_MONEY_FIELDS,
  );
  const stockFromMap = stockFromBranchValue(branchValueFromMap(payload, ["branchStock", "stockByBranch", "stockQtyByBranch", "branchInventory"], branchId));
  const directPrice = fieldCentsFromPayload(payload, PRODUCT_PRICE_CENT_FIELDS, PRODUCT_PRICE_MONEY_FIELDS);
  const directCost = fieldCentsFromPayload(payload, PRODUCT_COST_CENT_FIELDS, PRODUCT_COST_MONEY_FIELDS);
  const directStock = numberFromPayload(payload, PRODUCT_STOCK_FIELDS, null);

  if (priceFromMap !== null) overlay.priceCents = priceFromMap;
  else if (directPrice !== null) overlay.priceCents = directPrice;
  if (costFromMap !== null) overlay.costCents = costFromMap;
  else if (directCost !== null) overlay.costCents = directCost;
  if (stockFromMap !== null && Number.isFinite(stockFromMap)) overlay.stockQty = stockFromMap;
  else if (directStock !== null && Number.isFinite(directStock)) overlay.stockQty = directStock;
  for (const key of ["reorderLevel", "shelfLocation", "availability"]) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") overlay[key] = payload[key];
  }
  return overlay;
}

function mergeOverlay(base = {}, next = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function addProductIndexes(indexes, row, canonicalId) {
  const payload = row.payload || {};
  const id = String(canonicalId || row.id || "");
  if (!id) return;
  indexes.byId.set(String(row.id), id);
  for (const value of [payload.sku, payload.SKU]) {
    const code = normalizeCode(value);
    if (code) indexes.bySku.set(code, id);
  }
  for (const value of [payload.barcode, payload.barcodeValue, payload.barcode_value]) {
    const code = normalizeCode(value);
    if (code) indexes.byBarcode.set(code, id);
  }
  if (Array.isArray(payload.barcodes)) {
    for (const value of payload.barcodes) {
      const code = normalizeCode(typeof value === "object" ? value?.barcode || value?.value : value);
      if (code) indexes.byBarcode.set(code, id);
    }
  }
  for (const value of [payload.barcodeCatalogId, payload.barcode_catalog_id, payload.catalogBarcodeId]) {
    const code = normalizeCode(value);
    if (code) indexes.byCatalog.set(code, id);
  }
}

function buildCanonicalProductIndexes(allRows, canonicalRows, aliasById) {
  const indexes = { byId: new Map(), bySku: new Map(), byBarcode: new Map(), byCatalog: new Map() };
  for (const row of canonicalRows) addProductIndexes(indexes, row, String(row.id));
  for (const row of allRows) {
    const canonicalId = canonicalProductId(row.id, aliasById);
    if (canonicalId && indexes.byId.has(String(canonicalId))) addProductIndexes(indexes, row, String(canonicalId));
  }
  return indexes;
}

function overlayProductId(payload = {}, indexes, aliasById) {
  const direct = canonicalProductId(payload.productId || payload.product_id || payload.productID || payload.productRecordId, aliasById);
  if (direct && indexes.byId.has(String(direct))) return String(direct);
  for (const value of [payload.productSku, payload.product_sku, payload.sku, payload.SKU]) {
    const code = normalizeCode(value);
    if (code && indexes.bySku.has(code)) return indexes.bySku.get(code);
  }
  for (const value of [payload.barcode, payload.productBarcode, payload.product_barcode]) {
    const code = normalizeCode(value);
    if (code && indexes.byBarcode.has(code)) return indexes.byBarcode.get(code);
  }
  for (const value of [payload.barcodeCatalogId, payload.barcode_catalog_id, payload.catalogBarcodeId]) {
    const code = normalizeCode(value);
    if (code && indexes.byCatalog.has(code)) return indexes.byCatalog.get(code);
  }
  return "";
}

function purchaseLinesFromPayload(payload = {}) {
  for (const value of [payload.items, payload.lines, payload.products, payload.purchaseItems, payload.purchase_items, payload.stockItems]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function quantityFromPayload(payload = {}) {
  for (const value of [payload.qty, payload.quantity, payload.receivedQty, payload.received_qty, payload.units, payload.count]) {
    const qty = Number(value);
    if (Number.isFinite(qty)) return qty;
  }
  return 0;
}

function addCatalogStock(stockByProduct, productId, qty) {
  if (!productId) return;
  const quantity = Number(qty);
  if (!Number.isFinite(quantity) || quantity === 0) return;
  stockByProduct.set(productId, (stockByProduct.get(productId) || 0) + quantity);
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

export function preferCatalogRecord(current, candidate) {
  if (!current) return candidate;
  const currentTs = Number(current.serverTs || current.updatedAt || 0);
  const candidateTs = Number(candidate.serverTs || candidate.updatedAt || 0);
  if (candidateTs !== currentTs) return candidateTs > currentTs ? candidate : current;
  const currentScore = productCompletenessScore(current);
  const candidateScore = productCompletenessScore(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return String(candidate.id || "").localeCompare(String(current.id || "")) >= 0 ? candidate : current;
}

function buildProductAliasMap(rows = []) {
  const rowsByKey = new Map();
  const canonicalByKey = new Map();

  for (const row of rows) {
    const key = productCatalogKey(row);
    if (!key || key === "name::") continue;
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(row);
    if (!row.deleted) canonicalByKey.set(key, preferCatalogRecord(canonicalByKey.get(key), row));
  }

  const aliasById = new Map();
  for (const [key, keyedRows] of rowsByKey.entries()) {
    const canonical = canonicalByKey.get(key);
    if (!canonical) continue;
    for (const row of keyedRows) aliasById.set(String(row.id), String(canonical.id));
  }
  return aliasById;
}

function canonicalProductId(productId, aliasById) {
  const id = String(productId || "");
  if (!id) return "";
  return aliasById.get(id) || id;
}

function remapProductReferencesInPayload(payload, aliasById) {
  if (!payload || typeof payload !== "object") return payload;
  let changed = false;
  const next = { ...payload };

  for (const key of ["productId", "product_id"]) {
    if (!next[key]) continue;
    const mapped = canonicalProductId(next[key], aliasById);
    if (mapped && mapped !== String(next[key])) {
      next[key] = mapped;
      changed = true;
    }
  }

  for (const key of ["items", "lines", "products"]) {
    if (!Array.isArray(next[key])) continue;
    const mappedItems = next[key].map((item) => {
      if (!item || typeof item !== "object") return item;
      let itemChanged = false;
      const mappedItem = { ...item };
      for (const productKey of ["productId", "product_id"]) {
        if (!mappedItem[productKey]) continue;
        const mapped = canonicalProductId(mappedItem[productKey], aliasById);
        if (mapped && mapped !== String(mappedItem[productKey])) {
          mappedItem[productKey] = mapped;
          itemChanged = true;
        }
      }
      if (itemChanged) changed = true;
      return itemChanged ? mappedItem : item;
    });
    if (mappedItems !== next[key]) next[key] = mappedItems;
  }

  return changed ? next : payload;
}

function remapEventProductReferences(event, aliasById) {
  const payload = remapProductReferencesInPayload(event.payload || {}, aliasById);
  return payload === event.payload ? event : { ...event, payload };
}

function normalizeProduct(row, branchId, stockQty, overlay = {}) {
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
    priceCents: overlay.priceCents ?? centsFromPayload(payload, PRODUCT_PRICE_CENT_FIELDS, PRODUCT_PRICE_MONEY_FIELDS),
    costCents: overlay.costCents ?? centsFromPayload(payload, PRODUCT_COST_CENT_FIELDS, PRODUCT_COST_MONEY_FIELDS),
    stockQty: Number.isFinite(Number(stockQty)) ? Number(stockQty) : 0,
    serverTs: Number(row.serverTs || row.updatedAt || 0),
  };
}

router.get("/catalog", requireDevice, async (req, res) => {
  const branchId = req.deviceBranchId;
  if (!branchId) return res.status(403).json({ error: "terminal_branch_required" });

  try {
    const records = await q(
      isMySql
        ? `SELECT id, branch_id AS branchId, updated_at AS updatedAt, server_ts AS serverTs, deleted, payload
             FROM records
            WHERE type = 'product'
            ORDER BY server_ts DESC, id ASC`
        : `SELECT id, branch_id AS "branchId", updated_at AS "updatedAt", server_ts AS "serverTs", deleted, payload
             FROM records
            WHERE type = 'product'
            ORDER BY server_ts DESC, id ASC`
    );
    const productAliases = buildProductAliasMap(records.rows);

    const overlayRows = await q(
      `SELECT id, branch_id AS "branchId", updated_at AS "updatedAt", server_ts AS "serverTs", deleted, type, payload
       FROM records
       WHERE type IN ('branchProduct', 'branchProducts', 'branch_product', 'branch_products',
                      'branchInventory', 'branchInventories', 'branch_inventory', 'branch_inventories')
       ORDER BY server_ts ASC, id ASC`
    );

    const stockEvents = await q(
      isMySql
        ? `SELECT id, type, branch_id AS branchId, payload
             FROM events
            WHERE type IN ('stockMovement', 'purchase')
              AND (branch_id = $1 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branchId')) = $1 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branch_id')) = $1)`
        : `SELECT id, type, branch_id AS "branchId", payload
             FROM events
            WHERE type IN ('stockMovement', 'purchase')
              AND (branch_id = $1 OR payload->>'branchId' = $1 OR payload->>'branch_id' = $1)`,
      [branchId]
    );

    const byKey = new Map();
    for (const row of records.rows) {
      if (row.deleted) continue;
      // Product records are the shared catalogue. Legacy imports may still
      // carry branch_id, but branch scoping belongs to branchProduct overlays
      // and stock movement events below. Filtering here hides valid catalogue
      // rows from terminals in the other branch.
      const key = productCatalogKey(row);
      byKey.set(key, preferCatalogRecord(byKey.get(key), row));
    }

    const canonicalRows = [...byKey.values()];
    const productIndexes = buildCanonicalProductIndexes(records.rows, canonicalRows, productAliases);
    const overlaysByProduct = new Map();
    for (const row of overlayRows.rows || []) {
      if (row.deleted) continue;
      const payload = row.payload || {};
      const recordBranchId = String(row.branchId || payload.branchId || payload.branch_id || "");
      if (recordBranchId && recordBranchId !== branchId) continue;
      const productId = overlayProductId(payload, productIndexes, productAliases);
      if (!productId) continue;
      overlaysByProduct.set(productId, mergeOverlay(overlaysByProduct.get(productId), productOverlayFromPayload(payload, branchId)));
    }

    const canonicalIds = new Set(canonicalRows.map((row) => String(row.id)));
    const stockByProduct = new Map();
    for (const row of stockEvents.rows) {
      const payload = row.payload || {};
      const status = String(payload.status || "").toLowerCase();
      if (["cancelled", "canceled", "void", "rejected"].includes(status)) continue;
      if (row.type === "purchase") {
        const lines = purchaseLinesFromPayload(payload);
        if (lines.length) {
          for (const line of lines) {
            let lineProductId = canonicalProductId(line.productId || line.product_id || line.productID || line.productRecordId, productAliases);
            if (!lineProductId || !canonicalIds.has(lineProductId)) lineProductId = overlayProductId(line, productIndexes, productAliases);
            if (!lineProductId || !canonicalIds.has(lineProductId)) continue;
            addCatalogStock(stockByProduct, lineProductId, quantityFromPayload(line));
          }
          continue;
        }
      }
      let productId = canonicalProductId(payload.productId || payload.product_id, productAliases);
      if (!productId || !canonicalIds.has(productId)) productId = overlayProductId(payload, productIndexes, productAliases);
      if (!productId || !canonicalIds.has(productId)) continue;
      addCatalogStock(stockByProduct, productId, quantityFromPayload(payload));
    }

    const products = canonicalRows
      .map((row) => {
        const productId = String(row.id);
        const overlay = mergeOverlay(productOverlayFromPayload(row.payload || {}, branchId), overlaysByProduct.get(productId));
        const baseStock = overlay.stockQty ?? numberFromPayload(row.payload || {}, PRODUCT_STOCK_FIELDS, 0);
        return normalizeProduct(row, branchId, baseStock + (stockByProduct.get(productId) || 0), overlay);
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
  ["branchProduct", "branchProduct"],
  ["branchProducts", "branchProduct"],
  ["branch_product", "branchProduct"],
  ["branch_products", "branchProduct"],
  ["branchInventory", "branchProduct"],
  ["branchInventories", "branchProduct"],
  ["branch_inventory", "branchProduct"],
  ["branch_inventories", "branchProduct"],
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
  ["stockCountSession", "stockCountSession"],
  ["stockCountSessions", "stockCountSession"],
  ["stock_count_session", "stockCountSession"],
  ["stock_count_sessions", "stockCountSession"],
]);

const TERMINAL_FORBIDDEN_RECORD_TYPES = new Set(["branch", "setting", "user", "expenseCategory", "stockCountSession", "branchProduct"]);
const TERMINAL_FORBIDDEN_EVENT_TYPES = new Set(["borrowing", "cashMovement", "endOfDay", "payment", "purchase"]);
const AUTH_SYNC_RECORD_TYPES = new Set(["user", "users", "credential", "credentials", "staffLogin", "staff_login"]);

function normalizeType(type) {
  return RECORD_TYPE_ALIASES.get(type) || type;
}

function isAuthSyncRecordType(type) {
  return AUTH_SYNC_RECORD_TYPES.has(String(type || ""));
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

async function validateStockCountSessionWrite(client, ev) {
  const payload = ev.payload || {};
  const branchId = ev.branchId || payload.branchId;
  const status = String(payload.status || "").toLowerCase();
  if (!branchId) return { ok: false, reason: "stock_count_branch_required" };
  if (!["open", "paused", "committed", "cancelled"].includes(status)) {
    return { ok: false, reason: "stock_count_status_invalid" };
  }
  if (["open", "paused"].includes(status) && !ev.deleted) {
    const existing = await client.query(
      `SELECT id, payload
         FROM records
        WHERE type = 'stockCountSession'
          AND deleted = false
          AND id <> $1
          AND COALESCE(branch_id, payload->>'branchId') = $2
          AND payload->>'status' IN ('open', 'paused')
        LIMIT 1`,
      [ev.id, branchId]
    );
    if (existing.rows.length) {
      return { ok: false, reason: "stock_count_session_locked", sessionId: existing.rows[0].id };
    }
  }
  return { ok: true };
}

router.post("/push", requireSyncWrite, async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : null;
  if (!events) return res.status(400).json({ error: "events_array_required" });

  const accepted = [];
  const serverTs = {};
  const rejected = [];
  const client = await pool.connect();
  let lastIssuedTs = serverNow();
  const actorId = syncActorId(req);
  const recordDeviceId = syncRecordDeviceId(req);
  let productAliases = null;

  async function getProductAliases() {
    if (productAliases) return productAliases;
    const records = await client.query(
      isMySql
        ? `SELECT id, branch_id AS branchId, updated_at AS updatedAt, server_ts AS serverTs, deleted, payload
             FROM records
            WHERE type = 'product'`
        : `SELECT id, branch_id AS "branchId", updated_at AS "updatedAt", server_ts AS "serverTs", deleted, payload
             FROM records
            WHERE type = 'product'`
    );
    productAliases = buildProductAliasMap(records.rows);
    return productAliases;
  }

  try {
    await client.query("BEGIN");
    for (const [eventIndex, ev] of events.entries()) {
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
      if (isAuthSyncRecordType(ev.type) || isAuthSyncRecordType(type)) {
        rejected.push({ id: ev.id, type: ev.type, reason: "auth_records_do_not_sync" });
        continue;
      }
      if (hasPlainCredential(ev)) {
        rejected.push({ id: ev.id, type, reason: "plain_password_or_pin_not_allowed" });
        continue;
      }

      const isAppendOnlyEvent = EVENT_TYPES.has(type);
      const isMutableRecord = RECORD_TYPE_ALIASES.has(ev.type);
      if (!isAppendOnlyEvent && !isMutableRecord) {
        rejected.push({ id: ev.id, type: ev.type, reason: "unknown_type" });
        continue;
      }

      const savepoint = `sync_event_${eventIndex}`;
      if (!isPgMem) await client.query(`SAVEPOINT ${savepoint}`);
      try {
        let acceptedId = null;
        let acceptedTs = null;

        if (isAppendOnlyEvent) {
          const eventToStore = ["stockMovement", "invoice", "purchase", "countLog"].includes(type)
            ? remapEventProductReferences(guardedEvent, await getProductAliases())
            : guardedEvent;
          acceptedTs = await insertAppendOnlyEvent(client, eventToStore, type, recordDeviceId, nextServerTs());
          acceptedId = eventToStore.id;
        } else {
          if (type === "stockCountSession") {
            const stockCountValidation = await validateStockCountSessionWrite(client, guardedEvent);
            if (!stockCountValidation.ok) {
            if (!isPgMem) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              rejected.push({ id: ev.id, type, reason: stockCountValidation.reason, sessionId: stockCountValidation.sessionId });
              continue;
            }
          }
          acceptedTs = await upsertMutableRecord(client, guardedEvent, type, recordDeviceId, nextServerTs());
          if (type === "product") {
            await propagateProductGlobalFields(client, guardedEvent, recordDeviceId, acceptedTs);
            productAliases = null;
          }
          acceptedId = guardedEvent.id;
        }

        if (!isPgMem) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        accepted.push(acceptedId);
        serverTs[acceptedId] = acceptedTs;
      } catch (eventError) {
        if (!isPgMem) {
          try {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (savepointError) {
            console.error("sync savepoint recovery failed:", {
              id: ev.id,
              type,
              reason: savepointError?.message || "savepoint_recovery_failed",
            });
            throw savepointError;
          }
        }
        console.error("sync event rejected:", {
          id: ev.id,
          type,
          reason: eventError?.message || "event_failed",
        });
        rejected.push({ id: ev.id, type, reason: "event_failed" });
      }
    }

    if (req.deviceId) {
      await client.query(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [req.deviceId]);
    }
    await client.query("COMMIT");
    const cursor = Object.values(serverTs).reduce((max, ts) => Math.max(max, ts), Number(req.body?.cursor || 0));
    if (accepted.length) {
      const changedTypes = [...new Set(events.filter((ev) => accepted.includes(ev.id)).map((ev) => normalizeType(ev.type)))];
      publishSyncChange({
        sourceDeviceId: actorId,
        branchId: req.deviceBranchId || req.account?.branchId || null,
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

router.get("/pull", requireSyncRead, async (req, res) => {
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


