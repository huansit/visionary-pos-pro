import pg from "pg";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let Pool = pg.Pool;

if (process.env.PG_MEM === "1") {
  const { newDb } = await import("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  Pool = adapter.Pool;
}

// Single shared connection pool (don't open a connection per request).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PGPOOL_MAX || "20", 10),
  idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT_MS || "30000", 10),
  connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || "5000", 10),
});

export const q = (text, params) => pool.query(text, params);

export const ready = process.env.PG_MEM === "1" && process.env.PG_MEM_AUTO_MIGRATE !== "0"
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
