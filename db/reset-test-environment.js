import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;
const confirmed = process.argv.includes("--confirm");
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const mode = String(process.env.VISIONPOS_MODE || "").trim().toLowerCase();

function fail(message) {
  console.error(`RESET REFUSED: ${message}`);
  process.exitCode = 1;
}

function groupedRows(rows) {
  return Object.fromEntries(rows.map((row) => [row.type || `${row.kind}:${row.status}`, Number(row.count)]));
}

function backupDatabase(url, databaseName) {
  const parsed = new URL(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = resolve(process.env.BACKUP_PATH || "backups/test-reset");
  const backupFile = resolve(backupDir, `${databaseName}-before-reset-${stamp}.dump`);
  mkdirSync(backupDir, { recursive: true });

  const result = spawnSync("pg_dump", [
    "--host", parsed.hostname,
    "--port", parsed.port || "5432",
    "--username", decodeURIComponent(parsed.username),
    "--dbname", databaseName,
    "--format", "custom",
    "--file", backupFile,
  ], {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
  });

  if (result.error) throw new Error(`pg_dump could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pg_dump failed: ${String(result.stderr || result.stdout).trim()}`);
  if (!existsSync(backupFile) || statSync(backupFile).size === 0) throw new Error("pg_dump produced an empty backup");
  return { path: backupFile, bytes: statSync(backupFile).size };
}

async function snapshot(client) {
  const [records, events, credentials, devices, activationCodes, sessions, branchProducts] = await Promise.all([
    client.query(`SELECT type, count(*)::int AS count FROM records WHERE deleted = false GROUP BY type ORDER BY type`),
    client.query(`SELECT type, count(*)::int AS count FROM events GROUP BY type ORDER BY type`),
    client.query(`SELECT kind, status, count(*)::int AS count FROM credentials GROUP BY kind, status ORDER BY kind, status`),
    client.query(`SELECT count(*)::int AS count FROM devices`),
    client.query(`SELECT count(*)::int AS count FROM terminal_activation_codes`),
    client.query(`SELECT count(*)::int AS count FROM user_sessions`),
    client.query(`SELECT count(*)::int AS rows, COALESCE(sum(stock), 0)::int AS stock FROM branch_products`),
  ]);

  return {
    records: groupedRows(records.rows),
    events: groupedRows(events.rows),
    credentials: groupedRows(credentials.rows),
    devices: Number(devices.rows[0].count),
    activationCodes: Number(activationCodes.rows[0].count),
    sessions: Number(sessions.rows[0].count),
    branchProducts: { rows: Number(branchProducts.rows[0].rows), stock: Number(branchProducts.rows[0].stock) },
  };
}

async function reset(client) {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM user_sessions");
    await client.query("DELETE FROM password_reset_tokens");
    await client.query("DELETE FROM user_fingerprints");
    await client.query("DELETE FROM auth_verification_codes");
    await client.query("DELETE FROM auth_audit_log");
    await client.query("DELETE FROM terminal_activation_codes");
    await client.query("DELETE FROM events");

    // Preserve catalog setup and branch prices, but begin testing with zero stock.
    await client.query("UPDATE branch_products SET stock = 0, updated_at = now() WHERE stock <> 0");

    // Products and branches are the only business records retained. Barcode catalog
    // records are supporting product identity and must remain with the products.
    await client.query(`
      UPDATE records
      SET device_id = NULL
      WHERE type IN ('product', 'branch', 'barcodeCatalog')
        AND device_id IS NOT NULL
    `);
    await client.query(`
      DELETE FROM records
      WHERE type NOT IN ('product', 'branch', 'barcodeCatalog')
    `);

    // Clear per-branch quantities and purchase-derived moving-average costs from
    // retained product payloads. Selling-price maps and catalog fields are preserved.
    await client.query(`
      UPDATE records
      SET payload =
        (payload - ARRAY[
          'branchStock', 'stockByBranch', 'stockQtyByBranch', 'branchInventory',
          'branchCosts', 'costByBranch', 'movingAverageCostByBranch',
          'averageCostByBranch', 'branchMovingAverageCosts'
        ]::text[])
        || jsonb_build_object(
          'stockQty', 0,
          'stock', 0,
          '_stock', 0,
          'qty', 0,
          'quantity', 0,
          'onHand', 0,
          'currentStock', 0,
          'current_stock', 0
        ),
        updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        server_ts = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
      WHERE type = 'product' AND deleted = false
    `);

    await client.query("DELETE FROM devices");
    await client.query(`
      DELETE FROM credentials
      WHERE NOT (kind = 'admin' AND status = 'active')
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function verify(client, before) {
  const after = await snapshot(client);
  const failures = [];
  if (after.devices !== 0) failures.push("devices remain");
  if (after.activationCodes !== 0) failures.push("terminal activation codes remain");
  if (after.sessions !== 0) failures.push("user sessions remain");
  if (Object.keys(after.events).length !== 0) failures.push("transaction/report events remain");
  if (after.branchProducts.stock !== 0) failures.push("branch stock is not zero");
  if ((after.records.product || 0) !== (before.records.product || 0)) failures.push("product count changed");
  if ((after.records.branch || 0) !== (before.records.branch || 0)) failures.push("branch count changed");
  const unexpectedRecords = Object.keys(after.records).filter((type) => !["product", "branch", "barcodeCatalog"].includes(type));
  if (unexpectedRecords.length) failures.push(`unexpected records remain: ${unexpectedRecords.join(", ")}`);
  const nonAdminCredentials = Object.keys(after.credentials).filter((key) => key !== "admin:active");
  if (nonAdminCredentials.length) failures.push(`non-admin credentials remain: ${nonAdminCredentials.join(", ")}`);
  if (!(after.credentials["admin:active"] > 0)) failures.push("no active admin account remains");
  if (failures.length) throw new Error(`reset verification failed: ${failures.join("; ")}`);
  return after;
}

async function main() {
  if (!databaseUrl) return fail("DATABASE_URL is missing. Run with node --env-file=.env.test ...");
  if (mode !== "test") return fail(`VISIONPOS_MODE must be test; received ${mode || "empty"}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query("SELECT current_database() AS database, current_user AS username");
    const databaseName = identity.rows[0].database;
    if (databaseName !== "visionary_test") return fail(`database must be visionary_test; connected to ${databaseName}`);

    const before = await snapshot(client);
    console.log("TEST RESET TARGET", { mode, database: databaseName, user: identity.rows[0].username });
    console.log("BEFORE", JSON.stringify(before, null, 2));

    if (!confirmed) {
      console.log("DRY RUN ONLY - no rows changed and no backup created.");
      console.log("Re-run with --confirm to back up visionary_test and execute the reset.");
      return;
    }

    const backup = backupDatabase(databaseUrl, databaseName);
    console.log("BACKUP VERIFIED", backup);
    await reset(client);
    const after = await verify(client, before);
    console.log("AFTER", JSON.stringify(after, null, 2));
    console.log("TEST RESET COMPLETE - products, barcode catalog, branches, branch prices, and active admin login preserved.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("TEST RESET FAILED - transaction rolled back:", error);
  process.exitCode = 1;
});
