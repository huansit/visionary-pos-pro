import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./routes/auth.js";
import barcodeRoutes from "./routes/barcodes.js";
import syncRoutes from "./routes/sync.js";
import { requireDevice } from "./auth.js";
import { isMySql, q, ready } from "./db.js";

let dbReadyError = null;
const dbReady = ready.catch((error) => {
  dbReadyError = error;
  console.error("database initialization failed:", error);
});

const app = express();
const here = dirname(fileURLToPath(import.meta.url));
const frontendDist = join(here, "..", "frontend", "dist");

app.use(helmet());
app.use(express.json({ limit: "5mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const origins = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

// Health check used by monitoring and tills before attempting sync.
app.get("/health", async (_req, res, next) => {
  try {
    await dbReady;
    if (dbReadyError) {
      return res.status(503).json({
        ok: false,
        database: "error",
        error: dbReadyError.code || dbReadyError.message || "database_initialization_failed"
      });
    }
    await q("SELECT 1");
    res.json({ ok: true, database: isMySql ? "mysql" : "postgres", ts: Date.now() });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/barcodes", barcodeRoutes);
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
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") return next();
  const indexPath = join(frontendDist, "index.html");
  if (existsSync(indexPath)) return res.sendFile(indexPath);
  return next();
});

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "server_error" }); });

// Listen on whatever the platform provides via PORT — Hostinger/LiteSpeed may pass
// a numeric port OR a Unix socket path. Pass it through unchanged (parseInt would
// turn a socket path into NaN and bind a random port the proxy can't reach), and do
// NOT pin a host: that lets Node bind all interfaces for a numeric port, or the
// socket for a path — which is what the platform proxy expects.
const port = process.env.PORT || 3000;
let server;

if (process.env.NODE_ENV !== "test") {
  server = app.listen(port, () => console.log(`Visionary POS API listening on ${port}`));
  // Surface bind failures (e.g. EADDRINUSE) to stderr so the platform logs show them.
  server.on("error", (err) => console.error("FATAL: server failed to bind to", port, "-", err.message));
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
