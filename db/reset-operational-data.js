import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const mode = String(process.env.VISIONPOS_MODE || "").trim().toLowerCase();
const expectedConfirmation = mode === "live" ? "--confirm=RESET-LIVE" : "--confirm=RESET-TEST";
const confirmed = process.argv.includes(expectedConfirmation);

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
  return { path: backupFile, bytes: statSync(backupFile).size };
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

async function count(client, sql) {
  const result = await client.query(sql);
  return Number(result.rows[0].count || 0);
}

async function snapshot(client) {
  return {
    products: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='product' AND deleted=false"),
    branches: await count(client, "SELECT count(*)::int AS count FROM records WHERE type='branch' AND deleted=false"),
    operationalRecords: await count(client, "SELECT count(*)::int AS count FROM records WHERE type NOT IN ('product','branch','barcodeCatalog','systemReset')"),
    events: await count(client, "SELECT count(*)::int AS count FROM events"),
    devices: await count(client, "SELECT count(*)::int AS count FROM devices"),
    credentials: await count(client, "SELECT count(*)::int AS count FROM credentials"),
    sessions: await count(client, "SELECT count(*)::int AS count FROM user_sessions"),
  };
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

async function reset(client, ownerId, resetEpoch) {
  await client.query("BEGIN");
  try {
    for (const table of [
      "user_sessions", "password_reset_tokens", "user_fingerprints", "auth_verification_codes",
      "auth_audit_log", "terminal_activation_codes", "events",
    ]) {
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
    await client.query("COMMIT");
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

    const owner = await client.query(`
      SELECT id, name, email
        FROM credentials
       WHERE status='active' AND kind='admin'
       ORDER BY
         CASE WHEN lower(coalesce(name,''))='waziri' THEN 0
              WHEN lower(coalesce(name,'')) LIKE '%waziri%' THEN 1
              WHEN coalesce(rights->>'owner','false')='true' OR lower(coalesce(rights->>'role',''))='owner' THEN 2
              ELSE 3 END,
         created_at ASC
       LIMIT 1
    `);
    if (!owner.rows.length) throw new Error("no active owner/admin account found; reset aborted");
    const before = await snapshot(client);
    console.log("RESET TARGET", { mode, database: databaseName, owner: owner.rows[0], confirmed });
    console.log("BEFORE", JSON.stringify(before, null, 2));
    if (!confirmed) {
      console.log(`DRY RUN ONLY. Re-run with ${expectedConfirmation} to create a backup and reset this database.`);
      return;
    }

    const backup = backupDatabase(databaseUrl, databaseName);
    console.log("BACKUP VERIFIED", backup);
    const resetEpoch = Date.now();
    await reset(client, owner.rows[0].id, resetEpoch);
    const after = await snapshot(client);
    const activeOwnerCount = await count(client, `SELECT count(*)::int AS count FROM credentials WHERE id='${String(owner.rows[0].id).replaceAll("'", "''")}' AND status='active'`);
    if (after.events || after.devices || after.sessions || after.operationalRecords || after.credentials !== 1 || activeOwnerCount !== 1) {
      throw new Error(`verification failed: ${JSON.stringify(after)}`);
    }
    if (after.products !== before.products || after.branches !== before.branches) throw new Error("product or branch count changed");
    console.log("AFTER", JSON.stringify(after, null, 2));
    console.log("RESET COMPLETE", { resetEpoch, preserved: ["products", "branches", "barcode catalog", "Waziri owner account"] });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("OPERATIONAL RESET FAILED:", error);
  process.exitCode = 1;
});
