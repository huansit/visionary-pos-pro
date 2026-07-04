import crypto from "node:crypto";
import { isMySql, q } from "./db.js";

const ENVIRONMENTS = new Set(["test", "live"]);

export function normalizeEnvironmentMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ENVIRONMENTS.has(mode) ? mode : "test";
}

export function environmentLabel(mode) {
  return normalizeEnvironmentMode(mode) === "live" ? "LIVE MODE" : "TEST MODE";
}

export function configuredEnvironmentMode() {
  return normalizeEnvironmentMode(process.env.VISIONPOS_ENVIRONMENT || process.env.APP_ENVIRONMENT || "test");
}

function redactDatabaseUrl(value) {
  if (!value) return "not configured";
  try {
    const url = new URL(value);
    if (url.username) url.username = `${url.username.slice(0, 2)}***`;
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "configured";
  }
}

export function environmentConfig(mode = configuredEnvironmentMode()) {
  const normalized = normalizeEnvironmentMode(mode);
  const suffix = normalized.toUpperCase();
  return {
    mode: normalized,
    label: environmentLabel(normalized),
    database: redactDatabaseUrl(process.env[`DATABASE_URL_${suffix}`] || process.env.DATABASE_URL),
    api: process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://visionarypos.cloud",
    version: process.env.npm_package_version || "0.1.0"
  };
}

function ignoredSchemaError(error) {
  return ["42701", "42P07", "42P01", "ER_DUP_FIELDNAME", "ER_TABLE_EXISTS_ERROR", "ER_NO_SUCH_TABLE"].includes(error?.code);
}

async function optionalSchema(statement) {
  try {
    await q(statement);
  } catch (error) {
    if (!ignoredSchemaError(error)) throw error;
  }
}

let schemaReady = false;

export async function ensureEnvironmentSchema() {
  if (schemaReady) return;
  const initialMode = configuredEnvironmentMode();

  if (isMySql) {
    await q(`
      CREATE TABLE IF NOT EXISTS system_environment (
        id VARCHAR(32) PRIMARY KEY,
        mode VARCHAR(16) NOT NULL,
        previous_mode VARCHAR(16),
        last_switch_at DATETIME,
        switched_by VARCHAR(128),
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS environment_audit_log (
        id VARCHAR(64) PRIMARY KEY,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id VARCHAR(128),
        user_name VARCHAR(255),
        previous_environment VARCHAR(16),
        new_environment VARCHAR(16),
        ip_address VARCHAR(255),
        device VARCHAR(255),
        detail TEXT NOT NULL DEFAULT '{}'
      )
    `);
    await q(
      "INSERT IGNORE INTO system_environment (id, mode, metadata) VALUES ('active', $1, $2)",
      [initialMode, JSON.stringify(environmentConfig(initialMode))]
    );
    await optionalSchema(`ALTER TABLE devices ADD COLUMN environment VARCHAR(16) NOT NULL DEFAULT '${initialMode}'`);
    await optionalSchema(`ALTER TABLE terminal_activation_codes ADD COLUMN environment VARCHAR(16) NOT NULL DEFAULT '${initialMode}'`);
    await optionalSchema(`ALTER TABLE user_sessions ADD COLUMN environment VARCHAR(16) NOT NULL DEFAULT '${initialMode}'`);
  } else {
    await q(`
      CREATE TABLE IF NOT EXISTS system_environment (
        id text PRIMARY KEY,
        mode text NOT NULL,
        previous_mode text,
        last_switch_at timestamptz,
        switched_by text,
        metadata text NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS environment_audit_log (
        id text PRIMARY KEY,
        changed_at timestamptz NOT NULL DEFAULT now(),
        user_id text,
        user_name text,
        previous_environment text,
        new_environment text,
        ip_address text,
        device text,
        detail text NOT NULL DEFAULT '{}'
      )
    `);
    await q(
      `INSERT INTO system_environment (id, mode, metadata)
       VALUES ('active', $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [initialMode, JSON.stringify(environmentConfig(initialMode))]
    );
    await optionalSchema(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT '${initialMode}'`);
    await optionalSchema(`ALTER TABLE terminal_activation_codes ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT '${initialMode}'`);
    await optionalSchema(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT '${initialMode}'`);
    await optionalSchema("CREATE INDEX IF NOT EXISTS idx_devices_environment ON devices(environment)");
    await optionalSchema("CREATE INDEX IF NOT EXISTS idx_terminal_activation_environment ON terminal_activation_codes(environment)");
    await optionalSchema("CREATE INDEX IF NOT EXISTS idx_user_sessions_environment ON user_sessions(environment)");
  }

  schemaReady = true;
}

export function sameEnvironment(left, right) {
  return normalizeEnvironmentMode(left) === normalizeEnvironmentMode(right);
}

export async function getActiveEnvironmentMode() {
  await ensureEnvironmentSchema();
  const result = await q("SELECT mode FROM system_environment WHERE id = 'active' LIMIT 1");
  return normalizeEnvironmentMode(result.rows[0]?.mode || configuredEnvironmentMode());
}

async function scalarCount(sql, params = []) {
  try {
    const result = await q(sql, params);
    return Number(result.rows[0]?.count || result.rows[0]?.n || 0);
  } catch {
    return 0;
  }
}

export async function getSwitchBlockers() {
  const blockers = [];
  const openInvoices = await scalarCount(
    `SELECT COUNT(*)::int AS count
       FROM events
      WHERE type = 'invoice'
        AND COALESCE(payload->>'status', 'open') NOT IN ('paid', 'closed', 'void', 'cancelled')`
  );
  const pendingPurchases = await scalarCount(
    `SELECT COUNT(*)::int AS count
       FROM events
      WHERE type = 'purchase'
        AND COALESCE(payload->>'status', 'pending') IN ('pending', 'open', 'draft')`
  );
  const stockCounts = await scalarCount(
    `SELECT COUNT(*)::int AS count
       FROM records
      WHERE deleted = false
        AND type IN ('stockCount', 'stockCountSession')
        AND COALESCE(payload->>'status', 'open') IN ('open', 'active', 'in_progress')`
  );

  if (openInvoices > 0) blockers.push({ code: "open_invoices", label: `${openInvoices} open invoice(s) exist` });
  if (pendingPurchases > 0) blockers.push({ code: "pending_purchases", label: `${pendingPurchases} pending purchase(s) exist` });
  if (stockCounts > 0) blockers.push({ code: "stock_count", label: `${stockCounts} stock count session(s) in progress` });
  return blockers;
}

export async function getEnvironmentState({ includeBlockers = true } = {}) {
  await ensureEnvironmentSchema();
  const result = await q(
    "SELECT mode, previous_mode, last_switch_at, switched_by, metadata FROM system_environment WHERE id = 'active' LIMIT 1"
  );
  const row = result.rows[0] || {};
  const mode = normalizeEnvironmentMode(row.mode || configuredEnvironmentMode());
  return {
    mode,
    label: environmentLabel(mode),
    config: environmentConfig(mode),
    previousMode: row.previous_mode || null,
    lastSwitch: row.last_switch_at || null,
    switchedBy: row.switched_by || null,
    blockers: includeBlockers ? await getSwitchBlockers() : []
  };
}

export async function switchEnvironment({ req, user, mode, confirmation }) {
  await ensureEnvironmentSchema();
  const nextMode = normalizeEnvironmentMode(mode);
  const expected = nextMode.toUpperCase();
  if (String(confirmation || "").trim().toUpperCase() !== expected) {
    const error = new Error(`Type ${expected} to confirm this environment switch.`);
    error.status = 400;
    throw error;
  }

  const currentMode = await getActiveEnvironmentMode();
  if (sameEnvironment(currentMode, nextMode)) return getEnvironmentState();

  const blockers = await getSwitchBlockers();
  if (blockers.length) {
    const error = new Error("Environment switch blocked by active business activity.");
    error.status = 409;
    error.blockers = blockers;
    throw error;
  }

  const nowExpr = isMySql ? "NOW()" : "now()";
  const switchedBy = user?.name || user?.email || user?.id || "owner";
  const config = JSON.stringify(environmentConfig(nextMode));

  await q(
    `UPDATE system_environment
        SET mode = $1,
            previous_mode = $2,
            last_switch_at = ${nowExpr},
            switched_by = $3,
            metadata = $4,
            updated_at = ${nowExpr}
      WHERE id = 'active'`,
    [nextMode, currentMode, switchedBy, config]
  );

  await q(
    `INSERT INTO environment_audit_log
      (id, user_id, user_name, previous_environment, new_environment, ip_address, device, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      crypto.randomUUID(),
      user?.id || null,
      switchedBy,
      currentMode,
      nextMode,
      req?.ip || req?.headers?.["x-forwarded-for"] || null,
      req?.headers?.["user-agent"] || null,
      JSON.stringify({ label: environmentLabel(nextMode) })
    ]
  );

  const currentSessionId = user?.sessionId || user?.session_id || req?.sessionId || null;
  if (currentSessionId) {
    await q("UPDATE user_sessions SET environment = $1 WHERE id = $2", [nextMode, currentSessionId]);
    await q("UPDATE user_sessions SET is_active = false WHERE environment <> $1 AND id <> $2", [nextMode, currentSessionId]);
  } else {
    await q("UPDATE user_sessions SET is_active = false WHERE environment <> $1", [nextMode]);
  }
  return getEnvironmentState();
}
