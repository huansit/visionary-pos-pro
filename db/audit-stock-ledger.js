import { pool, q } from "../src/db.js";

const branchId = String(process.argv.find((argument) => argument.startsWith("--branch=")) || "").slice(9).trim();
const productTerm = String(process.argv.find((argument) => argument.startsWith("--product=")) || "").slice(10).trim().toLowerCase();

function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}

function text(value) { return String(value ?? "").trim(); }
function quantity(payload = {}) {
  const value = Number(payload.qty ?? payload.quantity);
  return Number.isFinite(value) ? value : 0;
}
function timestamp(row, payload) {
  const value = Number(row.server_ts || row.client_ts || payload.ts || 0);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : "unknown";
}
function movementKind(payload = {}) {
  if (payload.purchaseId || /^purchase\b/i.test(text(payload.reason))) return "purchase receipt";
  if (text(payload.mode).toLowerCase() === "correction") return "stock correction";
  if (text(payload.mode).toLowerCase() === "count") return "inventory count";
  if (/sale|invoice/i.test(text(payload.reason))) return "sale";
  if (/transfer|borrow/i.test(text(payload.reason))) return "transfer";
  return text(payload.reason) || "other";
}

if (!branchId || !productTerm) {
  console.error("Usage: node db/audit-stock-ledger.js --branch=b_sip --product=Predator");
  process.exitCode = 2;
} else {
  try {
    const [productResult, movementResult] = await Promise.all([
      q("SELECT id, payload FROM records WHERE type = 'product' AND deleted = false"),
      q("SELECT id, branch_id, device_id, client_ts, server_ts, payload FROM events WHERE type = 'stockMovement' ORDER BY server_ts, id"),
    ]);
    const products = productResult.rows
      .map((row) => ({ id: text(row.id), payload: payloadOf(row) }))
      .filter((product) => [product.id, product.payload.name, product.payload.sku, product.payload.barcode]
        .some((value) => text(value).toLowerCase().includes(productTerm)));
    if (!products.length) {
      console.log(JSON.stringify({ branchId, product: productTerm, movements: [], message: "No matching product record found." }, null, 2));
    } else {
      const productIds = new Set(products.map((product) => product.id));
      const movements = movementResult.rows
        .map((row) => ({ ...row, payload: payloadOf(row) }))
        .filter((row) => text(row.branch_id || row.payload.branchId || row.payload.branch_id) === branchId
          && productIds.has(text(row.payload.productId || row.payload.product_id)))
        .map((row) => ({
          id: text(row.id),
          at: timestamp(row, row.payload),
          quantity: quantity(row.payload),
          runningQty: 0,
          kind: movementKind(row.payload),
          purchaseId: text(row.payload.purchaseId) || "-",
          countSession: text(row.payload.stockCountSessionId) || "-",
          correctionFrom: row.payload.previousQty ?? "-",
          correctionTo: row.payload.correctedQty ?? row.payload.finalQty ?? "-",
          reason: text(row.payload.reason) || "-",
          device: text(row.device_id) || "management session",
        }));
      let runningQty = 0;
      for (const movement of movements) {
        runningQty += movement.quantity;
        movement.runningQty = runningQty;
      }
      console.log("VISIONPOS stock ledger audit (read only)");
      console.log(`Branch: ${branchId}`);
      console.log(`Product matches: ${products.map((product) => `${product.payload.name || product.id} (${product.id})`).join(", ")}`);
      console.log(`Current ledger quantity: ${runningQty}`);
      console.table(movements);
      console.log("No stock, purchases, or counts were changed.");
    }
  } finally {
    await pool.end();
  }
}
