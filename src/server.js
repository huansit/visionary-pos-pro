import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import "dotenv/config";

import authRoutes from "./routes/auth.js";
import syncRoutes from "./routes/sync.js";
import { requireDevice } from "./auth.js";
import { isMySql, q, ready } from "./db.js";

await ready;

const app = express();

app.use(helmet());
app.use(express.json({ limit: "5mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const origins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

// Health check used by monitoring and tills before attempting sync.
app.get("/health", async (_req, res, next) => {
  try {
    await q("SELECT 1");
    res.json({ ok: true, ts: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/sync", syncRoutes);

/**
 * GET /api/reconcile/oversell  (device-authed)
 * STUB for Codex: aggregate stockMovement events per (branchId, productId),
 * sum payload.qty, and return rows where on-hand < 0 so a supervisor can
 * reconcile physically. (See Sync Backend Design §4.3 — detect, don't prevent.)
 */
app.get("/api/reconcile/oversell", requireDevice, async (_req, res, next) => {
  try {
    const result = await q(
      isMySql
        ? `SELECT
             COALESCE(branch_id, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branchId'))) AS branchId,
             JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productId')) AS productId,
             SUM(COALESCE(JSON_EXTRACT(payload, '$.qty') + 0, JSON_EXTRACT(payload, '$.quantity') + 0, 0)) AS onHand
           FROM events
           WHERE type = 'stockMovement'
             AND JSON_EXTRACT(payload, '$.productId') IS NOT NULL
           GROUP BY COALESCE(branch_id, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branchId'))), JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productId'))
           HAVING SUM(COALESCE(JSON_EXTRACT(payload, '$.qty') + 0, JSON_EXTRACT(payload, '$.quantity') + 0, 0)) < 0
           ORDER BY branchId, productId`
        : `SELECT
             COALESCE(branch_id, payload->>'branchId') AS "branchId",
             payload->>'productId' AS "productId",
             SUM(COALESCE((payload->>'qty')::numeric, (payload->>'quantity')::numeric, 0)) AS "onHand"
           FROM events
           WHERE type = 'stockMovement'
             AND payload ? 'productId'
           GROUP BY COALESCE(branch_id, payload->>'branchId'), payload->>'productId'
           HAVING SUM(COALESCE((payload->>'qty')::numeric, (payload->>'quantity')::numeric, 0)) < 0
           ORDER BY "branchId", "productId"`
    );
    res.json({ rows: result.rows });
  } catch (error) {
    next(error);
  }
});

// 404 + error handlers
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "server_error" }); });

const port = parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "127.0.0.1";
let server;

if (process.env.NODE_ENV !== "test") {
  server = app.listen(port, host, () => console.log(`Visionary POS API listening on ${host}:${port}`));
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  if (!server) return;
  server.close(async () => {
    const { pool } = await import("./db.js");
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
