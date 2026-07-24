import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const mode = String(process.env.VISIONPOS_MODE || "").trim().toLowerCase();
const expectedConfirmation = mode === "live" ? "--confirm=RESET-LIVE" : "--confirm=RESET-TEST";
const confirmed = process.argv.includes(expectedConfirmation);
const cleanupTables = [
  "user_sessions", "password_reset_tokens", "user_fingerprints", "auth_verification_codes",
  "auth_audit_log", "terminal_activation_codes", "events",
];
const retainedRecordTypes = ["product", "branch", "barcodeCatalog", "systemReset"];
const productMapFields = [
  "branchStock", "stockByBranch", "stockQtyByBranch", "branchInventory", "branchPricing", "pricesByBranch",
  "branchCosts", "costByBranch", "movingAverageCostByBranch", "averageCostByBranch", "branchMovingAverageCosts",
];
const productZeroFields = [
  "stockQty", "stock", "_stock", "qty", "quantity", "onHand", "currentStock", "current_stock",
  "priceCents", "sellingPriceCents", "costCents", "costPriceCents", "price", "sellingPrice",
  "selling_price", "cost", "costPrice", "cost_price", "buyingPrice", "reorderLevel", "reorder_level",
];

function backupDatabase(url, databaseName) {
  const parsed = new URL(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = resolve(process.env.BACKUP_PATH || `backups/${mode}-reset`);
  const backupFile = resolve(backupDir, `${databaseName}-before-operational-reset-${stamp}.dump`);
  mkdirSync(backupDir, { recursive: true });
  const result = spawnSync("pg_dump", [
    "--host", parsed.hostname,
    "--port", parsed.port || "5432",
    "--username", decodeURIComponent(parsed.username),
    "--dbname", databaseName,
    "--format", "custom",
    "--file", backupFile,
  ], { encoding: "utf8", env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) } });
  if (result.error) throw new Error(`pg_dump could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pg_dump failed: ${String(result.stderr || result.stdout).trim()}`);
  if (!existsSync(backupFile) || statSync(backupFile).size === 0) throw new Error("pg_dump produced an empty backup");
  const restoreCheck = spawnSync("pg_restore", ["--list", backupFile], { encoding: "utf8" });
  if (restoreCheck.error) throw new Error(`pg_restore could not validate the backup: ${restoreCheck.error.message}`);
  if (restoreCheck.status !== 0) {
    throw new Error(`backup validation failed: ${String(restoreCheck.stderr || restoreCheck.stdout).trim()}`);
  }
  const entries = String(restoreCheck.stdout || "").split(/\r?\n/).filter((line) => line && !line.startsWith(";")).length;
  if (!entries) throw new Error("backup validation found no restore entries");
  return { path: backupFile, bytes: statSync(backupFile).size, restoreEntries: entries };
}

async function tableExists(client, table) {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS present",
    [table]
  );
  return result.rows[0].present;
}

async function columns(client, table) {
  const result = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
    [table]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function count(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count || 0);
}

async function snapshot(client) {
  return {
    products: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='product' AND deleted=false"),
    productRecords: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='product'"),
    deletedProducts: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='product' AND deleted=true"),
    branches: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='branch' AND deleted=false"),
    branchRecords: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='branch'"),
    barcodeRecords: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='barcodeCatalog'"),
    operationalRecords: await count(client, "SELECT count(*)::int AS count FROM records WHERE type NOT IN ('product','branch','barcodeCatalog','systemReset')"),
    events: await count(client, "SELECT count(*)::int AS count FROM events"),
    devices: await count(client, "SELECT count(*)::int AS count FROM devices"),
    credentials: await count(client, "SELECT count(*)::int AS count FROM credentials"),
    sessions: await count(client, "SELECT count(*)::int AS count FROM user_sessions"),
  };
}

async function resolveOwner(client) {
  const result = await client.query(`
    SELECT id, name, email, rights
      FROM credentials
     WHERE status='active' AND kind='admin'
     ORDER BY created_at ASC, id ASC
  `);
  const exactWaziri = result.rows.filter((row) => String(row.name || "").trim().toLowerCase() === "waziri");
  if (exactWaziri.length === 1) return exactWaziri[0];
  if (exactWaziri.length > 1) throw new Error("multiple active admin accounts are named Waziri; reset aborted");

  const markedOwners = result.rows.filter((row) => {
    const rights = row.rights && typeof row.rights === "object" ? row.rights : {};
    return rights.owner === true || String(rights.role || "").toLowerCase() === "owner";
  });
  if (markedOwners.length === 1) return markedOwners[0];
  if (markedOwners.length > 1) throw new Error("multiple active owner accounts found; reset aborted");
  if (result.rows.length === 1) return result.rows[0];
  throw new Error("Waziri owner account could not be identified unambiguously; reset aborted");
}

async function countNonZeroColumns(client, table, names) {
  if (!(await tableExists(client, table))) return 0;
  const available = await columns(client, table);
  const selected = names.filter((name) => available.has(name));
  if (!selected.length) return 0;
  return count(client, `SELECT count(*)::int AS count FROM ${table} WHERE ${selected.map((name) => `coalesce(${name},0)<>0`).join(" OR ")}`);
}

async function verifyReset(client, before, ownerId, resetEpoch) {
  const after = await snapshot(client);
  const ownerResult = await client.query(
    "SELECT count(*)::int AS count FROM credentials WHERE id=$1 AND status='active' AND kind='admin'",
    [ownerId]
  );
  const cleanupCounts = {};
  for (const table of cleanupTables) {
    cleanupCounts[table] = await tableExists(client, table)
      ? await count(client, `SELECT count(*)::int AS count FROM ${table}`)
      : 0;
  }
  const invalidRecords = await count(
    client,
    `SELECT count(*)::int AS count FROM records WHERE NOT (type=ANY($1::text[]))`,
    [retainedRecordTypes]
  );
  const attachedRecords = await count(client, "SELECT count(*)::int AS count FROM records WHERE device_id IS NOT NULL");
  const resetMarker = await client.query(
    "SELECT payload FROM records WHERE id='operational-reset' AND type='systemReset' AND deleted=false"
  );
  const dirtyProducts = await count(client, `
    SELECT count(*)::int AS count
      FROM records r
     WHERE r.type='product' AND r.deleted=false
       AND (
         r.payload ?| $1::text[]
         OR EXISTS (
           SELECT 1
             FROM jsonb_each_text(r.payload) AS field(key,value)
            WHERE field.key=ANY($2::text[])
              AND field.value !~ '^[+-]?0+([.]0+)?$'
         )
       )
  `, [productMapFields, productZeroFields]);
  const relationalNonZero = {
    branchProducts: await countNonZeroColumns(client, "branch_products", [
      "stock", "quantity", "selling_price", "price", "reorder_level", "moving_average_cost", "average_cost", "cost_price",
    ]),
    products: await countNonZeroColumns(client, "products", [
      "cost_price", "selling_price", "price", "stock", "quantity", "reorder_level",
    ]),
  };
  const marker = resetMarker.rows[0]?.payload || {};
  const catalogueChanged = ["products", "productRecords", "deletedProducts", "branches", "branchRecords", "barcodeRecords"]
    .some((key) => after[key] !== before[key]);
  const failures = [];
  if (catalogueChanged) failures.push("catalogue/branch/tombstone counts changed");
  if (after.operationalRecords !== 0 || invalidRecords !== 0) failures.push("operational records remain");
  if (after.events !== 0 || after.devices !== 0 || after.sessions !== 0) failures.push("events, terminals, or sessions remain");
  if (after.credentials !== 1 || Number(ownerResult.rows[0]?.count || 0) !== 1) failures.push("owner-only credential invariant failed");
  if (Object.values(cleanupCounts).some(Boolean)) failures.push("one or more cleanup tables are not empty");
  if (attachedRecords !== 0) failures.push("retained records still reference deleted terminals");
  if (dirtyProducts !== 0 || relationalNonZero.branchProducts !== 0 || relationalNonZero.products !== 0) {
    failures.push("stock, price, cost, or reorder values were not fully zeroed");
  }
  if (String(marker.resetEpoch || "") !== String(resetEpoch) || marker.mode !== mode) failures.push("reset marker was not written correctly");
  if (failures.length) {
    throw new Error(`reset verification failed before commit: ${failures.join("; ")}`);
  }
  return { after, cleanupCounts, relationalNonZero, dirtyProducts, attachedRecords };
}

async function zeroRelationalCatalog(client) {
  if (await tableExists(client, "branch_products")) {
    const cols = await columns(client, "branch_products");
    const assignments = [];
    for (const name of ["stock", "quantity", "selling_price", "price", "reorder_level", "moving_average_cost", "average_cost", "cost_price"]) {
      if (cols.has(name)) assignments.push(`${name}=0`);
    }
    if (cols.has("updated_at")) {
      const type = await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='branch_products' AND column_name='updated_at'");
      assignments.push(type.rows[0]?.data_type === "bigint" ? "updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint" : "updated_at=clock_timestamp()");
    }
    if (assignments.length) await client.query(`UPDATE branch_products SET ${assignments.join(", ")}`);
  }
  if (await tableExists(client, "products")) {
    const cols = await columns(client, "products");
    const assignments = ["cost_price", "selling_price", "price", "stock", "quantity", "reorder_level"]
      .filter((name) => cols.has(name)).map((name) => `${name}=0`);
    if (assignments.length) await client.query(`UPDATE products SET ${assignments.join(", ")}`);
  }
}

async function reset(client, before, ownerId, resetEpoch) {
  await client.query("BEGIN");
  try {
    for (const table of cleanupTables) {
      if (await tableExists(client, table)) await client.query(`DELETE FROM ${table}`);
    }

    await client.query("UPDATE records SET device_id=NULL WHERE type IN ('product','branch','barcodeCatalog')");
    await client.query("DELETE FROM records WHERE type NOT IN ('product','branch','barcodeCatalog')");
    await client.query(`
      UPDATE records
         SET payload =
           (payload - ARRAY[
             'branchStock','stockByBranch','stockQtyByBranch','branchInventory','branchPricing','pricesByBranch',
             'branchCosts','costByBranch','movingAverageCostByBranch','averageCostByBranch','branchMovingAverageCosts'
           ]::text[])
           || jsonb_build_object(
             'stockQty',0,'stock',0,'_stock',0,'qty',0,'quantity',0,'onHand',0,'currentStock',0,'current_stock',0,
             'priceCents',0,'sellingPriceCents',0,'costCents',0,'costPriceCents',0,'price',0,'sellingPrice',0,
             'selling_price',0,'cost',0,'costPrice',0,'cost_price',0,'buyingPrice',0,'reorderLevel',0,'reorder_level',0
           ),
           updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint,
           server_ts=(extract(epoch FROM clock_timestamp())*1000)::bigint
       WHERE type='product' AND deleted=false
    `);
    await zeroRelationalCatalog(client);

    await client.query("UPDATE records SET device_id=NULL WHERE device_id IS NOT NULL");
    await client.query("DELETE FROM devices");
    await client.query("DELETE FROM credentials WHERE id<>$1", [ownerId]);
    await client.query(`
      INSERT INTO records (id,type,branch_id,device_id,updated_at,server_ts,deleted,payload)
      VALUES ('operational-reset','systemReset',NULL,NULL,$1,$1,false,$2::jsonb)
      ON CONFLICT (id,type) DO UPDATE SET
        branch_id=NULL, device_id=NULL, updated_at=EXCLUDED.updated_at,
        server_ts=EXCLUDED.server_ts, deleted=false, payload=EXCLUDED.payload
    `, [resetEpoch, JSON.stringify({ resetEpoch: String(resetEpoch), mode, reason: "fresh_start" })]);
    const verification = await verifyReset(client, before, ownerId, resetEpoch);
    await client.query("COMMIT");
    return verification;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");
  if (!new Set(["live", "test"]).has(mode)) throw new Error("VISIONPOS_MODE must be live or test");

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query("SELECT current_database() AS database, current_user AS username");
    const databaseName = identity.rows[0].database;
    const expectedDatabase = mode === "live" ? "visionary_live" : "visionary_test";
    if (databaseName !== expectedDatabase) throw new Error(`refusing reset: ${mode} must use ${expectedDatabase}, connected to ${databaseName}`);

    for (const required of ["records", "events", "devices", "credentials", "user_sessions"]) {
      if (!(await tableExists(client, required))) throw new Error(`required table ${required} is missing; reset aborted`);
    }
    const owner = await resolveOwner(client);
    const before = await snapshot(client);
    console.log("RESET TARGET", { mode, database: databaseName, owner: { id: owner.id, name: owner.name, email: owner.email }, confirmed });
    console.log("BEFORE", JSON.stringify(before, null, 2));
    if (!confirmed) {
      console.log(`DRY RUN ONLY. Re-run with ${expectedConfirmation} to create a backup and reset this database.`);
      return;
    }

    const backup = backupDatabase(databaseUrl, databaseName);
    console.log("BACKUP VERIFIED", backup);
    const resetEpoch = Date.now();
    const verification = await reset(client, before, owner.id, resetEpoch);
    console.log("AFTER", JSON.stringify(verification.after, null, 2));
    console.log("VERIFICATION", JSON.stringify(verification, null, 2));
    console.log("RESET COMPLETE", { resetEpoch, preserved: ["products", "branches", "barcode catalog", "Waziri owner account"] });
    console.log("BACKUP FOR RECOVERY", backup.path);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("OPERATIONAL RESET FAILED:", error);
  process.exitCode = 1;
});
