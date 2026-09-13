import { isMySql, q, tx } from "../src/db.js";

const apply = process.argv.includes("--apply");
const listOnly = process.argv.includes("--list") || !apply;
const invoiceFilter = String(process.argv.find((argument) => argument.startsWith("--invoice=")) || "")
  .slice("--invoice=".length).trim().toLowerCase();

function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}

function text(value) { return String(value || "").trim(); }

async function main() {
  const [decisionResult, requestResult, invoiceResult, movementResult] = await Promise.all([
    q("SELECT id, branch_id, payload FROM events WHERE type = 'invoiceLineVoidDecision' ORDER BY server_ts, id"),
    q("SELECT id, payload FROM events WHERE type = 'invoiceLineVoidRequest'"),
    q("SELECT id, branch_id, payload FROM events WHERE type = 'invoice'"),
    q("SELECT id, branch_id, payload FROM events WHERE type = 'stockMovement'"),
  ]);
  const requests = new Map(requestResult.rows.map((row) => [row.id, payloadOf(row)]));
  const invoices = new Map(invoiceResult.rows.map((row) => [row.id, { branchId: row.branch_id, payload: payloadOf(row) }]));
  const returnMovements = movementResult.rows
    .map((row) => ({ id: row.id, branchId: text(row.branch_id), payload: payloadOf(row) }))
    .filter((movement) => movement.payload.source === "invoice_line_void" && movement.payload.voidRequestId);
  const returnMovementsByRequest = new Map();
  returnMovements.forEach((movement) => {
    const requestId = text(movement.payload.voidRequestId);
    const list = returnMovementsByRequest.get(requestId) || [];
    list.push(movement);
    returnMovementsByRequest.set(requestId, list);
  });

  const repairs = [];
  const verifiedStockMovements = [];
  const inconsistentStockMovements = [];
  for (const decisionRow of decisionResult.rows) {
    const decision = payloadOf(decisionRow);
    if (text(decision.decision).toLowerCase() !== "approved") continue;
    const requestId = text(decision.requestId);
    const request = requests.get(requestId);
    const invoiceId = text(decision.invoiceId || request?.invoiceId);
    const lineIndex = Number(decision.lineIndex ?? request?.lineIndex);
    const qty = Number(decision.qty ?? request?.qty);
    const invoice = invoices.get(invoiceId);
    if (!requestId || !invoiceId || !Number.isInteger(lineIndex) || lineIndex < 0 || !Number.isFinite(qty) || qty <= 0 || !invoice) continue;
    const invoiceNumber = text(invoice.payload.number || invoice.payload.receiptNo || invoiceId);
    if (invoiceFilter && invoiceFilter !== invoiceId.toLowerCase() && invoiceFilter !== invoiceNumber.toLowerCase()) continue;
    const item = Array.isArray(invoice.payload.items) ? invoice.payload.items[lineIndex] : null;
    const productId = text(item?.productId);
    const expectedId = `void-line-stock:${invoiceId}:${lineIndex}:${requestId}`;
    if (!productId) continue;
    const expectedBranchId = text(invoice.branchId || decisionRow.branch_id || decision.branchId);
    const candidates = returnMovementsByRequest.get(requestId) || [];
    const validMovement = candidates.find((movement) => text(movement.payload.productId) === productId
      && text(movement.branchId || movement.payload.branchId) === expectedBranchId
      && Number(movement.payload.qty) === qty);
    if (validMovement) {
      verifiedStockMovements.push({ id: validMovement.id, invoiceId, invoiceNumber, branchId: expectedBranchId, productId, qty, requestId });
      continue;
    }
    if (candidates.length) {
      inconsistentStockMovements.push({
        invoiceId,
        invoiceNumber,
        branchId: expectedBranchId,
        productId,
        qty,
        requestId,
        expectedId,
        found: candidates.map((movement) => ({ id: movement.id, branchId: movement.branchId || movement.payload.branchId || "", productId: movement.payload.productId || "", qty: Number(movement.payload.qty || 0) })),
      });
      continue;
    }
    repairs.push({
      id: expectedId,
      invoiceId,
      invoiceNumber,
      branchId: expectedBranchId,
      productId,
      qty,
      unitCostCents: Math.max(0, Number(item?.unitCostCents ?? item?.costCents ?? 0) || 0),
      requestId,
      decisionId: decisionRow.id,
      voidedAt: Number(decision.decidedAt || decision.ts || 0),
    });
  }

  if (listOnly) {
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", verifiedStockMovements, missingStockMovements: repairs, inconsistentStockMovements }, null, 2));
    if (!apply) console.log("Dry run only. Re-run with --apply to restore the listed stock movements.");
    return;
  }

  if (inconsistentStockMovements.length) {
    console.error(JSON.stringify({ mode: "blocked", message: "Inconsistent existing void-return movements require review; no stock was changed.", inconsistentStockMovements }, null, 2));
    process.exitCode = 2;
    return;
  }

  await tx(async (client) => {
    let appliedTs = Date.now();
    for (const repair of repairs) {
      appliedTs += 1;
      await client.query(
        isMySql
          ? "INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1, 'stockMovement', $2, $3, $4, $5, $6)"
          : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
             VALUES ($1, 'stockMovement', $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
        [repair.id, repair.branchId, "reconcile-invoice-line-void", appliedTs, appliedTs, {
          productId: repair.productId,
          branchId: repair.branchId,
          qty: repair.qty,
          unitCostCents: repair.unitCostCents,
          reason: `Line void ${repair.invoiceNumber}`,
          invoiceId: repair.invoiceId,
          voidRequestId: repair.requestId,
          voidDecisionId: repair.decisionId,
          source: "invoice_line_void",
          voidedAt: repair.voidedAt || null,
          ts: appliedTs,
        }]
      );
    }
  });
  console.log(JSON.stringify({ mode: "applied", restoredStockMovements: repairs.length, repairs, verifiedStockMovements }, null, 2));
}

main().catch((error) => {
  console.error("invoice line void stock reconciliation failed:", error?.message || error);
  process.exit(1);
});
