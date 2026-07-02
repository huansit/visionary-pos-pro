import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool, ready, serverNow } from "../src/db.js";

const args = new Set(process.argv.slice(2));
const confirm = args.has("--confirm");
const dryRun = args.has("--dry-run") || !confirm;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function usage() {
  return [
    "Usage:",
    "  npm run products:go-live -- --dry-run",
    "  npm run products:go-live -- --confirm",
    "",
    "Default mode is diagnostic/dry-run. Destructive changes require --confirm.",
  ].join("\n");
}

function normalizeSku(value) {
  return String(value || "").trim().toLowerCase();
}

function safePart(value) {
  return String(value || "x").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function hasMoney(payload, keys) {
  return keys.some((key) => asNumber(payload?.[key], 0) > 0);
}

function productScore(row) {
  const p = row.payload || {};
  return [
    hasMoney(p, ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents", "price", "sellingPrice", "selling_price"]) ? 1000 : 0,
    hasMoney(p, ["costCents", "costPriceCents", "cost_price_cents", "costPrice", "cost_price", "cost"]) ? 900 : 0,
    hasValue(p.image || p.imageUrl || p.image_url || p.photo) ? 600 : 0,
    hasValue(p.name) ? 300 : 0,
    hasValue(p.barcode || (Array.isArray(p.barcodes) && p.barcodes[0])) ? 160 : 0,
    hasValue(p.category || p.categoryId) ? 90 : 0,
    hasValue(p.brand) ? 40 : 0,
    hasValue(p.unit || p.size) ? 30 : 0,
    String(p.status || "active").toLowerCase() === "active" ? 10 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function canonicalSort(a, b) {
  const score = productScore(b) - productScore(a);
  if (score) return score;
  const time = asNumber(b.server_ts ?? b.serverTs ?? b.updated_at ?? b.updatedAt) - asNumber(a.server_ts ?? a.serverTs ?? a.updated_at ?? a.updatedAt);
  if (time) return time;
  return String(a.id).localeCompare(String(b.id));
}

function stripBranchAndStock(payload = {}) {
  const next = { ...payload };
  delete next.branchId;
  delete next.branch_id;
  delete next.branch;
  for (const key of ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand"]) {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = 0;
  }
  return next;
}

function mergeProductPayload(canonical, candidates) {
  const merged = { ...(canonical || {}) };
  const fillKeys = [
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
    "image_url",
    "photo",
    "description",
    "status",
    "priceCents",
    "sellingPriceCents",
    "selling_price_cents",
    "sellPriceCents",
    "price",
    "sellingPrice",
    "selling_price",
    "costCents",
    "costPriceCents",
    "cost_price_cents",
    "costPrice",
    "cost_price",
    "cost",
  ];
  for (const row of candidates) {
    const payload = row.payload || {};
    for (const key of fillKeys) {
      if (!hasValue(merged[key]) && hasValue(payload[key])) merged[key] = payload[key];
    }
  }
  return stripBranchAndStock(merged);
}

function rewriteProductRefs(value, idMap) {
  if (Array.isArray(value)) return value.map((item) => rewriteProductRefs(item, idMap));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === "productId" || key === "product_id") && idMap.has(String(child))) {
      out[key] = idMap.get(String(child));
    } else {
      out[key] = rewriteProductRefs(child, idMap);
    }
  }
  return out;
}

function jsonChanged(a, b) {
  return JSON.stringify(a || {}) !== JSON.stringify(b || {});
}

function buildDedupePlan(products) {
  const bySku = new Map();
  for (const row of products) {
    const key = normalizeSku(row.payload?.sku);
    if (!key) continue;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(row);
  }
  const groups = [];
  const idMap = new Map();
  for (const [sku, rows] of bySku.entries()) {
    const sorted = [...rows].sort(canonicalSort);
    const keep = sorted[0];
    const remove = sorted.slice(1);
    groups.push({ sku, keep, remove, rows: sorted });
    for (const row of remove) idMap.set(row.id, keep.id);
  }
  return { groups, idMap };
}

async function diagnose(client) {
  const counts = await client.query(
    `SELECT
       count(*)::int AS total,
       count(DISTINCT lower(trim(payload->>'sku'))) FILTER (WHERE payload->>'sku' IS NOT NULL AND trim(payload->>'sku') <> '')::int AS skus,
       count(*) FILTER (WHERE payload->>'sku' IS NULL OR trim(payload->>'sku') = '')::int AS missing_sku
     FROM records
     WHERE type = 'product' AND deleted = false`
  );
  const duplicates = await client.query(
    `SELECT lower(trim(payload->>'sku')) AS sku, count(*)::int AS rows
     FROM records
     WHERE type = 'product' AND deleted = false AND payload->>'sku' IS NOT NULL AND trim(payload->>'sku') <> ''
     GROUP BY lower(trim(payload->>'sku'))
     HAVING count(*) > 1
     ORDER BY rows DESC, sku
     LIMIT 20`
  );
  const duplicateCount = await client.query(
    `SELECT count(*)::int AS dupes
     FROM (
       SELECT lower(trim(payload->>'sku')) AS sku
       FROM records
       WHERE type = 'product' AND deleted = false AND payload->>'sku' IS NOT NULL AND trim(payload->>'sku') <> ''
       GROUP BY lower(trim(payload->>'sku'))
       HAVING count(*) > 1
     ) d`
  );
  const branches = await client.query(
    `SELECT id, payload->>'name' AS name
     FROM records
     WHERE type = 'branch' AND deleted = false
     ORDER BY id`
  );
  const stock = await client.query(
    "SELECT count(*)::int AS total FROM events WHERE type = 'stockMovement'"
  );
  return {
    source: "sync records table",
    productRecords: {
      total: counts.rows[0].total,
      distinctSkus: counts.rows[0].skus,
      missingSkuRows: counts.rows[0].missing_sku,
      duplicateSkuCount: duplicateCount.rows[0].dupes,
    },
    duplicateExamples: duplicates.rows,
    branches: branches.rows,
    stockMovementEvents: stock.rows[0].total,
  };
}

async function backupDatabase() {
  mkdirSync(join(repoRoot, "backups"), { recursive: true });
  const file = join(repoRoot, "backups", `visionpos-record-products-go-live-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for pg_dump backup.");
  const result = spawnSync("pg_dump", [url, "-f", file], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("pg_dump backup failed; no changes were made.");
  return file;
}

async function loadProducts(client) {
  const result = await client.query(
    `SELECT id, branch_id, device_id, updated_at, server_ts, deleted, payload
     FROM records
     WHERE type = 'product' AND deleted = false
     ORDER BY lower(trim(payload->>'sku')), server_ts DESC, id ASC`
  );
  return result.rows;
}

function currentStockSums(stockEvents, idMap) {
  const sums = new Map();
  for (const row of stockEvents) {
    const payload = row.payload || {};
    const rawProductId = String(payload.productId || payload.product_id || "");
    const productId = idMap.get(rawProductId) || rawProductId;
    const branchId = String(payload.branchId || payload.branch_id || row.branch_id || "");
    if (!productId || !branchId) continue;
    const qty = asNumber(payload.qty ?? payload.quantity, 0);
    if (!qty) continue;
    const key = `${branchId}::${productId}`;
    sums.set(key, (sums.get(key) || 0) + qty);
  }
  return sums;
}

async function executeGoLive(client, before) {
  if (before.productRecords.missingSkuRows) {
    throw new Error(`Cannot continue: ${before.productRecords.missingSkuRows} active product record(s) have no SKU.`);
  }

  const products = await loadProducts(client);
  const plan = buildDedupePlan(products);
  const branchIds = before.branches.map((branch) => branch.id);
  let ts = Math.max(serverNow(), ...products.map((row) => asNumber(row.server_ts, 0))) + 1;
  const nextTs = () => ts++;
  const stats = {
    canonicalUpdated: 0,
    tombstonedDuplicates: 0,
    recordPayloadRefsRepointed: 0,
    eventPayloadRefsRepointed: 0,
    stockZeroingEventsInserted: 0,
  };

  for (const group of plan.groups) {
    const payload = mergeProductPayload(group.keep.payload, group.rows);
    const changed = group.keep.branch_id || jsonChanged(payload, group.keep.payload);
    if (changed) {
      await client.query(
        `UPDATE records
         SET branch_id = NULL, payload = $3, updated_at = $4, server_ts = $4
         WHERE type = 'product' AND id = $1`,
        [group.keep.id, "product", payload, nextTs()]
      );
      stats.canonicalUpdated++;
    }

    for (const duplicate of group.remove) {
      await client.query(
        `UPDATE records
         SET branch_id = NULL,
             deleted = true,
             payload = $3,
             updated_at = $4,
             server_ts = $4
         WHERE type = 'product' AND id = $1`,
        [
          duplicate.id,
          "product",
          { ...stripBranchAndStock(duplicate.payload || {}), dedupedInto: group.keep.id },
          nextTs(),
        ]
      );
      stats.tombstonedDuplicates++;
    }
  }

  const records = await client.query("SELECT id, type, payload FROM records");
  for (const row of records.rows) {
    if (row.type === "product") continue;
    const rewritten = rewriteProductRefs(row.payload || {}, plan.idMap);
    if (!jsonChanged(rewritten, row.payload)) continue;
    await client.query(
      `UPDATE records SET payload = $3, updated_at = $4, server_ts = $4 WHERE type = $1 AND id = $2`,
      [row.type, row.id, rewritten, nextTs()]
    );
    stats.recordPayloadRefsRepointed++;
  }

  const events = await client.query("SELECT id, type, branch_id, payload FROM events");
  for (const row of events.rows) {
    const rewritten = rewriteProductRefs(row.payload || {}, plan.idMap);
    if (!jsonChanged(rewritten, row.payload)) continue;
    await client.query("UPDATE events SET payload = $2, server_ts = $3 WHERE id = $1", [row.id, rewritten, nextTs()]);
    stats.eventPayloadRefsRepointed++;
  }

  const updatedEvents = await client.query("SELECT id, type, branch_id, payload FROM events WHERE type = 'stockMovement'");
  const stockSums = currentStockSums(updatedEvents.rows, plan.idMap);
  const canonicalIds = plan.groups.map((group) => group.keep.id);
  for (const branchId of branchIds) {
    for (const productId of canonicalIds) {
      const key = `${branchId}::${productId}`;
      const current = stockSums.get(key) || 0;
      if (!current) continue;
      const eventTs = nextTs();
      await client.query(
        `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, 'stockMovement', $2, NULL, $3, $4, $5)`,
        [
          `gl_zero_${safePart(branchId)}_${safePart(productId)}_${eventTs}`,
          branchId,
          eventTs,
          eventTs,
          {
            productId,
            branchId,
            qty: -current,
            reason: "Go-live stock reset",
            mode: "goLiveZero",
            ts: Date.now(),
          },
        ]
      );
      stats.stockZeroingEventsInserted++;
    }
  }

  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS records_product_sku_unique_idx
     ON records (lower((payload->>'sku')))
     WHERE type = 'product'
       AND deleted = false
       AND payload->>'sku' IS NOT NULL
       AND trim(payload->>'sku') <> ''`
  );

  return stats;
}

async function main() {
  console.log(usage());
  await ready;
  const client = await pool.connect();
  try {
    const before = await diagnose(client);
    console.log("\nSTEP 1 - DIAGNOSE");
    console.log(JSON.stringify(before, null, 2));
    console.log("\nSchema situation: sync-record catalogue; SQL products table is not the live source.");

    const products = await loadProducts(client);
    const plan = buildDedupePlan(products);
    console.log("\nSTEP 3 - DEDUPE PLAN");
    console.log(JSON.stringify({
      activeProductRecords: products.length,
      uniqueSkus: plan.groups.length,
      duplicateSkuGroups: plan.groups.filter((group) => group.remove.length).length,
      productRecordsToTombstone: plan.idMap.size,
      examples: plan.groups
        .filter((group) => group.remove.length)
        .slice(0, 12)
        .map((group) => ({
          sku: group.sku,
          keep: group.keep.id,
          remove: group.remove.map((row) => row.id),
          score: productScore(group.keep),
        })),
    }, null, 2));

    if (dryRun) {
      console.log("\nDRY RUN ONLY - no database changes made. Re-run with --confirm to back up and execute.");
      return;
    }

    console.log("\nSTEP 0 - BACKUP");
    const backup = await backupDatabase();
    console.log(`Backup complete: ${backup}`);

    await client.query("BEGIN");
    const stats = await executeGoLive(client, before);
    await client.query("COMMIT");

    const after = await diagnose(client);
    console.log("\nSTEP 7 - VERIFY & REPORT");
    console.log(JSON.stringify({ before, after, stats, backup }, null, 2));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // no open transaction
    }
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
