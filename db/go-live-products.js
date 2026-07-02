import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { pool, ready } from "../src/db.js";

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

function normalizeSku(sku) {
  return String(sku || "").trim().toLowerCase();
}

function safeIdPart(value) {
  return String(value || "branch").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function bpId(branchId, productId) {
  return `bp_${safeIdPart(branchId)}_${safeIdPart(productId)}`.slice(0, 180);
}

function rowCompleteness(row) {
  return [
    Number(row.cost_price || 0) > 0 ? 1000 : 0,
    Number(row.max_selling_price || 0) > 0 ? 800 : 0,
    String(row.image || "").trim() ? 500 : 0,
    String(row.name || "").trim() ? 200 : 0,
    String(row.category_id || "").trim() ? 80 : 0,
    String(row.brand || "").trim() ? 40 : 0,
    String(row.unit || "").trim() ? 20 : 0,
    String(row.status || "active").toLowerCase() === "active" ? 10 : 0,
  ].reduce((sum, n) => sum + n, 0);
}

function sortCanonical(a, b) {
  const complete = rowCompleteness(b) - rowCompleteness(a);
  if (complete) return complete;
  const updated = new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
  if (updated) return updated;
  return String(a.id).localeCompare(String(b.id));
}

async function tableExists(client, tableName) {
  const result = await client.query("SELECT to_regclass($1) AS name", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.name);
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(result.rows[0]);
}

async function listBranches(client) {
  const branches = new Map();
  if (await tableExists(client, "products") && await columnExists(client, "products", "branch_id")) {
    const result = await client.query("SELECT branch_id, count(*)::int AS productRows FROM products WHERE branch_id IS NOT NULL GROUP BY branch_id ORDER BY branch_id");
    result.rows.forEach((row) => branches.set(row.branch_id, { ...(branches.get(row.branch_id) || { id: row.branch_id }), productRows: row.productrows ?? row.productRows }));
  }
  if (await tableExists(client, "branch_products")) {
    const result = await client.query("SELECT branch_id, count(*)::int AS rows FROM branch_products WHERE branch_id IS NOT NULL GROUP BY branch_id ORDER BY branch_id");
    result.rows.forEach((row) => branches.set(row.branch_id, { id: row.branch_id, branchProductRows: row.rows }));
  }
  if (await tableExists(client, "devices")) {
    const result = await client.query("SELECT branch_id, count(*)::int AS devices FROM devices WHERE branch_id IS NOT NULL GROUP BY branch_id");
    result.rows.forEach((row) => branches.set(row.branch_id, { ...(branches.get(row.branch_id) || { id: row.branch_id }), devices: row.devices }));
  }
  if (await tableExists(client, "records")) {
    const result = await client.query("SELECT id, payload->>'name' AS name FROM records WHERE type = 'branch' AND deleted = false ORDER BY id");
    result.rows.forEach((row) => branches.set(row.id, { ...(branches.get(row.id) || { id: row.id }), name: row.name || row.id }));
  }
  return [...branches.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function diagnose(client) {
  const hasProducts = await tableExists(client, "products");
  const hasBranchProducts = await tableExists(client, "branch_products");
  if (!hasProducts) throw new Error("products table does not exist");

  const columns = {
    productsBranchId: await columnExists(client, "products", "branch_id"),
    productsStock: await columnExists(client, "products", "stock"),
    productsQuantity: await columnExists(client, "products", "quantity"),
    productsSellingPrice: await columnExists(client, "products", "selling_price"),
    branchProducts: hasBranchProducts,
  };

  const counts = await client.query(
    `SELECT
       count(*)::int AS total_rows,
       count(DISTINCT lower(trim(sku))) FILTER (WHERE sku IS NOT NULL AND trim(sku) <> '')::int AS distinct_skus,
       count(*) FILTER (WHERE sku IS NULL OR trim(sku) = '')::int AS missing_sku_rows
     FROM products`
  );
  const duplicateSkuCount = await client.query(
    `SELECT count(*)::int AS n
       FROM (
         SELECT lower(trim(sku)) AS sku_key
         FROM products
         WHERE sku IS NOT NULL AND trim(sku) <> ''
         GROUP BY lower(trim(sku))
         HAVING count(*) > 1
       ) d`
  );
  const duplicateRows = await client.query(
    `SELECT lower(trim(sku)) AS sku_key, count(*)::int AS rows
       FROM products
      WHERE sku IS NOT NULL AND trim(sku) <> ''
      GROUP BY lower(trim(sku))
     HAVING count(*) > 1
      ORDER BY rows DESC, sku_key
      LIMIT 20`
  );
  const branches = await listBranches(client);
  const stockCounts = hasBranchProducts
    ? await client.query(
        `SELECT
           count(*)::int AS rows,
           count(*) FILTER (WHERE stock = 0)::int AS zero_stock_rows,
           count(DISTINCT branch_id)::int AS branches,
           count(DISTINCT product_id)::int AS products
         FROM branch_products`
      )
    : { rows: [{ rows: 0, zero_stock_rows: 0, branches: 0, products: 0 }] };

  return {
    columns,
    productCounts: {
      totalRows: counts.rows[0].total_rows,
      distinctSkus: counts.rows[0].distinct_skus,
      missingSkuRows: counts.rows[0].missing_sku_rows,
      duplicateSkuCount: duplicateSkuCount.rows[0].n,
    },
    duplicateExamples: duplicateRows.rows,
    branches,
    stockCounts: stockCounts.rows[0],
  };
}

async function productRows(client) {
  const result = await client.query(
    `SELECT
       p.*,
       COALESCE((SELECT max(bp.selling_price) FROM branch_products bp WHERE bp.product_id = p.id), 0) AS max_selling_price,
       COALESCE((SELECT sum(bp.stock) FROM branch_products bp WHERE bp.product_id = p.id), 0) AS branch_stock_total
     FROM products p
     ORDER BY lower(trim(p.sku)), p.id`
  );
  return result.rows;
}

function buildCanonicalPlan(rows) {
  const bySku = new Map();
  for (const row of rows) {
    const key = normalizeSku(row.sku);
    if (!key) continue;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(row);
  }
  const groups = [];
  const remap = new Map();
  for (const [skuKey, skuRows] of bySku.entries()) {
    const sorted = [...skuRows].sort(sortCanonical);
    const keep = sorted[0];
    const remove = sorted.slice(1);
    if (!remove.length) continue;
    groups.push({ skuKey, keep, remove });
    remove.forEach((row) => remap.set(row.id, keep.id));
  }
  return { groups, remap };
}

async function mergeBranchProducts(client, duplicateId, keepId) {
  const rows = await client.query("SELECT * FROM branch_products WHERE product_id = $1", [duplicateId]);
  for (const row of rows.rows) {
    await client.query(
      `INSERT INTO branch_products (
         id, product_id, branch_id, selling_price, stock, reorder_level, shelf_location, availability, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,0,$5,$6,$7,COALESCE($8, now()), now())
       ON CONFLICT (branch_id, product_id) DO UPDATE SET
         selling_price = CASE
           WHEN EXCLUDED.selling_price > 0 THEN EXCLUDED.selling_price
           ELSE branch_products.selling_price
         END,
         stock = 0,
         reorder_level = GREATEST(branch_products.reorder_level, EXCLUDED.reorder_level),
         shelf_location = COALESCE(branch_products.shelf_location, EXCLUDED.shelf_location),
         availability = branch_products.availability OR EXCLUDED.availability,
         updated_at = now()`,
      [
        bpId(row.branch_id, keepId),
        keepId,
        row.branch_id,
        row.selling_price || 0,
        row.reorder_level || 0,
        row.shelf_location || null,
        row.availability !== false,
        row.created_at || null,
      ]
    );
  }
  await client.query("DELETE FROM branch_products WHERE product_id = $1", [duplicateId]);
}

async function splitLegacyProductStock(client, columns) {
  if (!columns.productsBranchId) return { movedRows: 0, droppedColumns: [] };

  const selectStock = columns.productsStock
    ? "COALESCE(stock, 0)"
    : columns.productsQuantity
      ? "COALESCE(quantity, 0)"
      : "0";
  const selectSellingPrice = columns.productsSellingPrice ? "COALESCE(selling_price, 0)" : "0";
  const hasReorderLevel = await columnExists(client, "products", "reorder_level");
  const selectReorderLevel = hasReorderLevel ? "COALESCE(reorder_level, 0)" : "0";

  const legacyRows = await client.query(
    `SELECT id, branch_id, ${selectStock} AS stock, ${selectSellingPrice} AS selling_price, ${selectReorderLevel} AS reorder_level
       FROM products
      WHERE branch_id IS NOT NULL`
  );

  for (const row of legacyRows.rows) {
    await client.query(
      `INSERT INTO branch_products (id, product_id, branch_id, selling_price, stock, reorder_level, availability)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (branch_id, product_id) DO UPDATE SET
         selling_price = CASE
           WHEN EXCLUDED.selling_price > 0 THEN EXCLUDED.selling_price
           ELSE branch_products.selling_price
         END,
         stock = EXCLUDED.stock,
         reorder_level = GREATEST(branch_products.reorder_level, EXCLUDED.reorder_level),
         updated_at = now()`,
      [bpId(row.branch_id, row.id), row.id, row.branch_id, row.selling_price || 0, row.stock || 0, row.reorder_level || 0]
    );
  }

  const columnsToDrop = [
    "branch_id",
    columns.productsStock ? "stock" : null,
    columns.productsQuantity ? "quantity" : null,
    columns.productsSellingPrice ? "selling_price" : null,
    hasReorderLevel ? "reorder_level" : null,
  ].filter(Boolean);

  for (const column of columnsToDrop) {
    await client.query(`ALTER TABLE products DROP COLUMN IF EXISTS ${column}`);
  }

  return { movedRows: legacyRows.rowCount || 0, droppedColumns: columnsToDrop };
}

async function updateJsonProductRefs(client, fromId, toId) {
  let changed = 0;
  const topLevelEvents = await client.query(
    `UPDATE events
        SET payload = jsonb_set(payload, '{productId}', to_jsonb($2::text), false)
      WHERE payload->>'productId' = $1`,
    [fromId, toId]
  );
  changed += topLevelEvents.rowCount || 0;

  const topLevelRecords = await client.query(
    `UPDATE records
        SET payload = jsonb_set(payload, '{productId}', to_jsonb($2::text), false)
      WHERE payload->>'productId' = $1`,
    [fromId, toId]
  );
  changed += topLevelRecords.rowCount || 0;

  for (const table of ["events", "records"]) {
    for (const field of ["items", "lines"]) {
      const result = await client.query(
        `UPDATE ${table}
            SET payload = jsonb_set(
              payload,
              $3::text[],
              (
                SELECT jsonb_agg(
                  CASE
                    WHEN item->>'productId' = $1 THEN jsonb_set(item, '{productId}', to_jsonb($2::text), false)
                    ELSE item
                  END
                  ORDER BY ordinality
                )
                FROM jsonb_array_elements(payload->$4) WITH ORDINALITY AS arr(item, ordinality)
              ),
              false
            )
          WHERE jsonb_typeof(payload->$4) = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(payload->$4) item WHERE item->>'productId' = $1
            )`,
        [fromId, toId, [field], field]
      );
      changed += result.rowCount || 0;
    }
  }
  return changed;
}

async function updateForeignKeys(client, fromId, toId) {
  const fks = await client.query(
    `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'products'
        AND ccu.column_name = 'id'
        AND kcu.table_schema = current_schema()`
  );
  const changed = [];
  for (const fk of fks.rows) {
    if (fk.table_name === "branch_products") continue;
    const result = await client.query(
      `UPDATE ${fk.table_name} SET ${fk.column_name} = $2 WHERE ${fk.column_name} = $1`,
      [fromId, toId]
    );
    if (result.rowCount) changed.push({ table: fk.table_name, column: fk.column_name, rows: result.rowCount });
  }
  return changed;
}

async function ensureBranchStockRows(client, branches) {
  for (const branch of branches) {
    const products = await client.query("SELECT id FROM products ORDER BY id");
    for (const product of products.rows) {
      await client.query(
        `INSERT INTO branch_products (id, product_id, branch_id, selling_price, stock, reorder_level, availability)
         VALUES ($1,$2,$3,0,0,0,true)
         ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = 0, updated_at = now()`,
        [bpId(branch.id, product.id), product.id, branch.id]
      );
    }
  }
}

async function takeBackup() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for backup");
  const backupDir = join(repoRoot, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(backupDir, `visionpos-products-go-live-${stamp}.sql`);
  const result = spawnSync("pg_dump", ["--dbname", process.env.DATABASE_URL, "--file", file, "--format", "plain", "--no-owner"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`pg_dump failed. Install PostgreSQL client tools or run on the VPS.\n${result.stderr || result.stdout}`);
  }
  return file;
}

async function run() {
  console.log(usage());
  if (args.has("--confirm") && args.has("--dry-run")) throw new Error("Use either --dry-run or --confirm, not both.");
  await ready;

  const client = await pool.connect();
  try {
    const before = await diagnose(client);
    console.log("\nSTEP 1 - DIAGNOSE");
    console.log(JSON.stringify(before, null, 2));

    const schemaSituation = before.columns.productsBranchId || before.columns.productsStock || before.columns.productsQuantity
      ? "legacy: products table still carries branch/stock fields and must be split"
      : "current: products is shared; branch_products carries per-branch stock/pricing";
    console.log(`\nSchema situation: ${schemaSituation}`);

    if (!before.columns.branchProducts) throw new Error("branch_products table is required before cleanup.");
    if (before.productCounts.missingSkuRows > 0) throw new Error(`Cannot safely dedupe: ${before.productCounts.missingSkuRows} product rows have no SKU.`);

    const rows = await productRows(client);
    const { groups, remap } = buildCanonicalPlan(rows);
    console.log("\nSTEP 3 - DEDUPE PLAN");
    console.log(`Duplicate SKU groups: ${groups.length}`);
    console.log(`Product rows to remove: ${remap.size}`);
    console.log("Examples:");
    console.log(groups.slice(0, 12).map((group) => ({
      sku: group.skuKey,
      keep: group.keep.id,
      remove: group.remove.map((row) => row.id),
    })));

    if (dryRun) {
      console.log("\nDRY RUN ONLY - no database changes made. Re-run with --confirm to back up and execute.");
      return;
    }

    console.log("\nSTEP 0 - BACKUP");
    const backupFile = await takeBackup();
    console.log(`Backup complete: ${backupFile}`);

    await client.query("BEGIN");
    const legacySplit = await splitLegacyProductStock(client, before.columns);
    const fkChanges = [];
    let jsonRefChanges = 0;
    for (const group of groups) {
      for (const duplicate of group.remove) {
        await mergeBranchProducts(client, duplicate.id, group.keep.id);
        fkChanges.push(...await updateForeignKeys(client, duplicate.id, group.keep.id));
        jsonRefChanges += await updateJsonProductRefs(client, duplicate.id, group.keep.id);
        await client.query("DELETE FROM products WHERE id = $1", [duplicate.id]);
      }
    }

    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique_idx ON products (lower(sku)) WHERE sku IS NOT NULL AND sku <> ''");
    await ensureBranchStockRows(client, before.branches);
    await client.query("COMMIT");

    const after = await diagnose(client);
    const duplicateCheck = await client.query(
      `SELECT lower(trim(sku)) AS sku_key, count(*)::int AS rows
         FROM products
        WHERE sku IS NOT NULL AND trim(sku) <> ''
        GROUP BY lower(trim(sku))
       HAVING count(*) > 1
        ORDER BY sku_key`
    );
    const stockVerification = await client.query(
      `SELECT branch_id, count(*)::int AS rows, count(*) FILTER (WHERE stock = 0)::int AS zero_rows
         FROM branch_products
        GROUP BY branch_id
        ORDER BY branch_id`
    );

    console.log("\nSTEP 7 - VERIFY & REPORT");
    console.log("Before:", before.productCounts);
    console.log("After:", after.productCounts);
    console.log("Remaining duplicate SKU groups:", duplicateCheck.rows);
    console.log("Branch stock rows:", stockVerification.rows);
    console.log("JSON product references repointed:", jsonRefChanges);
    console.log("FK repoints:", fkChanges);
    console.log("Legacy product stock split:", legacySplit);
    console.log("Backup:", backupFile);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("\nproducts go-live failed:");
  console.error(error);
  process.exit(1);
});
