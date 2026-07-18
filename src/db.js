import pg from "pg";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appMode, assertStartupConfig, runtimeConfig } from "./config.js";

let Pool = pg.Pool;
const databaseUrl = runtimeConfig.databaseUrl;
assertStartupConfig();

export function getActiveDatabaseEnvironment() {
  return appMode;
}

export function setActiveDatabaseEnvironment() {
  const error = new Error("runtime_environment_switching_disabled");
  error.status = 410;
  throw error;
}

export function getDatabaseUrlForMode() {
  return databaseUrl;
}

export const isMySql = databaseUrl.startsWith("mysql://") || databaseUrl.startsWith("mysql2://");
export const isPgMem = process.env.PG_MEM === "1";

if (isPgMem) {
  const { newDb } = await import("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  Pool = adapter.Pool;
}

function postgresPool() {
  return new Pool({
    connectionString: databaseUrl,
    max: parseInt(process.env.PGPOOL_MAX || "20", 10),
    idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT_MS || "30000", 10),
    connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || "5000", 10),
  });
}

function mysqlParams(params = []) {
  return params.map((value) => {
    if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      return JSON.stringify(value);
    }
    return value;
  });
}

function mysqlText(text) {
  return text.replace(/\$(\d+)/g, "?");
}

function normalizeRows(rows) {
  return rows.map((row) => {
    for (const key of ["payload", "rights"]) {
      if (typeof row[key] === "string") {
        try { row[key] = JSON.parse(row[key]); } catch (_) {}
      }
    }
    return row;
  });
}

function mysqlPool(rawPool) {
  return {
    async query(text, params = []) {
      const [rows] = await rawPool.execute(mysqlText(text), mysqlParams(params));
      return { rows: Array.isArray(rows) ? normalizeRows(rows) : [], raw: rows };
    },
    async connect() {
      const connection = await rawPool.getConnection();
      return {
        async query(text, params = []) {
          const sql = text === "BEGIN" ? "START TRANSACTION" : text;
          const [rows] = await connection.execute(mysqlText(sql), mysqlParams(params));
          return { rows: Array.isArray(rows) ? normalizeRows(rows) : [], raw: rows };
        },
        release() {
          connection.release();
        }
      };
    },
    async end() {
      await rawPool.end();
    }
  };
}

async function createPool() {
  const url = databaseUrl;
  const currentIsMySql = url.startsWith("mysql://") || url.startsWith("mysql2://");
  if (currentIsMySql) {
    const mysql = await import("mysql2/promise");
    const rawPool = mysql.createPool({
      uri: url,
      waitForConnections: true,
      connectionLimit: parseInt(process.env.MYSQL_POOL_MAX || process.env.PGPOOL_MAX || "20", 10),
      queueLimit: 0,
    });
    return mysqlPool(rawPool);
  }
  return postgresPool();
}

const activePool = await createPool();

export const pool = {
  query(text, params) {
    return activePool.query(text, params);
  },
  connect() {
    return activePool.connect();
  },
  end() {
    return activePool.end?.();
  }
};

export const q = (text, params) => pool.query(text, params);

export const ready = isMySql
  ? applyMySqlSchema()
  : process.env.PG_MEM === "1" && process.env.PG_MEM_AUTO_MIGRATE !== "0"
    ? applyMemorySchema()
    : Promise.resolve();

async function applyMemorySchema() {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(here, "..", "db", "schema.sql"), "utf8")
    .replace(/,\s*CONSTRAINT devices_token_hash_is_bcrypt CHECK \(token_hash ~ '[^']+'\)/g, "")
    .replace(/,\s*CONSTRAINT user_records_have_no_plain_credentials CHECK \([\s\S]*?\n  \)/g, "")
    .replace(/,\s*CONSTRAINT credential_pin_hash_is_bcrypt CHECK \(pin_hash IS NULL OR pin_hash ~ '[^']+'\)/g, "")
    .replace(/,\s*CONSTRAINT credential_password_hash_is_bcrypt CHECK \(password_hash IS NULL OR password_hash ~ '[^']+'\)/g, "");
  await pool.query(schema);
}

async function applyMySqlSchema() {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(join(here, "..", "db", "schema.mysql.sql"), "utf8");
  const statements = schema
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error?.code !== "ER_DUP_KEYNAME") throw error;
    }
  }
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ms-epoch server clock used for cursors and server-time LWW.
export const serverNow = () => Date.now();

