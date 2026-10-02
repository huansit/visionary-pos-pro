import { isMySql, q, tx } from "../src/db.js";

const apply = process.argv.includes("--apply");
const purchaseFilter = String(process.argv.find((argument) => argument.startsWith("--purchase=")) || "")
  .slice("--purchase=".length).trim().toLowerCase();

function payloadOf(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const [purchaseResult, movementResult] = await Promise.all([
    q("SELECT id, branch_id, payload FROM records WHERE type = 'purchase' AND deleted = false ORDER BY updated_at, id"),
    q("SELECT id, payload FROM events WHERE type = 'stockMovement'"),
  ]);

  const movementsByPurchase = new Map();
  for (const row of movementResult.rows) {
    const payload = payloadOf(row.payload);
    const purchaseId = text(payload.purchaseId);
    if (!purchaseId) continue;
    const entries = movementsByPurchase.get(purchaseId) || [];
    entries.push({ id: row.id, payload });
    movementsByPurchase.set(purchaseId, entries);
  }

  const repairs = [];
  for (const row of purchaseResult.rows) {
    const purchase = payloadOf(row.payload);
    const purchaseId = text(row.id || purchase.id);
    const branchId = text(row.branch_id || purchase.branchId);
    const offsetQty = Math.max(0, number(purchase.externalBorrowedOffsetQty));
    if (!purchaseId || !branchId || offsetQty <= 0) continue;
    if (text(purchase.source).toLowerCase() === "external_stock_borrowing") continue;
    if (text(purchase.status).toLowerCase() !== "received") continue;
    if (purchaseFilter && ![
      purchaseId,
      text(purchase.batchNo),
      text(purchase.batchId),
    ].some((value) => value.toLowerCase() === purchaseFilter)) continue;

    const existing = movementsByPurchase.get(purchaseId) || [];
    const alreadyAudited = existing.some(({ payload }) => (
      Math.max(0, number(payload.externalBorrowedOffsetQty)) > 0
      || text(payload.mode).toLowerCase() === "purchase_external_borrowed_settlement"
    ));
    if (alreadyAudited) continue;

    const settlements = Array.isArray(purchase.externalBorrowedSettlements) ? purchase.externalBorrowedSettlements : [];
    const shops = [...new Set(settlements.map((settlement) => text(settlement?.externalShopName)).filter(Boolean))];
    repairs.push({
      id: `external-borrowed-settlement-repair:${purchaseId}`,
      purchaseId,
      purchaseNo: text(purchase.batchNo || purchase.batchId || purchaseId),
      branchId,
      productId: text(purchase.productId),
      productName: text(purchase.productName || purchase.productId),
      supplierName: text(purchase.supplierName),
      offsetQty,
      shops,
      originalMovementIds: existing.map(({ id }) => id),
      receivedAt: number(purchase.receivedAt || purchase.updatedAt || purchase.ts || Date.now()),
      settlements,
    });
  }

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", repairs }, null, 2));
    console.log("Dry run only. Re-run with --apply to add only missing zero-net external-borrowed settlement audit movements.");
    return;
  }

  await tx(async (client) => {
    let ts = Date.now();
    for (const repair of repairs) {
      ts = Math.max(ts + 1, repair.receivedAt + 1);
      const reason = `Purchase ${repair.supplierName || repair.purchaseNo} · ${repair.offsetQty} borrowed unit${repair.offsetQty === 1 ? "" : "s"} settled${repair.shops.length ? ` · ${repair.shops.join(", ")}` : ""}`;
      const payload = {
        purchaseId: repair.purchaseId,
        purchaseBatchNo: repair.purchaseNo,
        productId: repair.productId,
        branchId: repair.branchId,
        qty: 0,
        mode: "purchase_external_borrowed_settlement",
        auditOnly: true,
        source: "external_stock_borrowing",
        externalBorrowedOffsetQty: repair.offsetQty,
        externalBorrowedSettlements: repair.settlements,
        reason,
        reconciledAt: ts,
        reconciliation: "missing_external_borrowed_purchase_settlement_audit",
        ts,
      };
      await client.query(
        isMySql
          ? "INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1, 'stockMovement', $2, NULL, $3, $4, $5)"
          : "INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1, 'stockMovement', $2, NULL, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
        [repair.id, repair.branchId, ts, ts, payload]
      );
    }
  });

  console.log(JSON.stringify({
    mode: "applied",
    addedAuditMovements: repairs.map(({ settlements, ...repair }) => repair),
  }, null, 2));
}

main().catch((error) => {
  console.error("external borrowed purchase settlement reconciliation failed:", error?.message || error);
  process.exit(1);
});
