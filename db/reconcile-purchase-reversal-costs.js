import { isMySql, q, tx } from "../src/db.js";

const apply = process.argv.includes("--apply");
const purchaseFilter = String(process.argv.find((argument) => argument.startsWith("--purchase=")) || "")
  .slice("--purchase=".length).trim().toLowerCase();

function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}

function costForBranch(payload, branchId) {
  const entry = payload?.branchCosts?.[branchId];
  if (entry && typeof entry === "object") return Number(entry.costCents);
  return Number(entry);
}

function withBranchCost(payload, branchId, costCents, repair) {
  const branchCosts = payload?.branchCosts && typeof payload.branchCosts === "object" && !Array.isArray(payload.branchCosts)
    ? payload.branchCosts
    : {};
  const previous = branchCosts[branchId] && typeof branchCosts[branchId] === "object" && !Array.isArray(branchCosts[branchId])
    ? branchCosts[branchId]
    : {};
  return {
    ...payload,
    branchCosts: { ...branchCosts, [branchId]: { ...previous, costCents } },
    lastPurchaseReversalCostRepair: repair,
  };
}

async function main() {
  const [reversalResult, productResult, purchaseResult] = await Promise.all([
    q("SELECT id, branch_id, server_ts, payload FROM events WHERE type = 'purchaseReversal' ORDER BY server_ts, id"),
    q("SELECT id, updated_at, server_ts, payload FROM records WHERE type = 'product' AND deleted = false"),
    q("SELECT id, branch_id, payload FROM records WHERE type = 'purchase' AND deleted = false"),
  ]);
  const products = new Map(productResult.rows.map((row) => [String(row.id), { ...row, payload: payloadOf(row) }]));
  const purchaseLines = purchaseResult.rows
    .map((row) => ({ id: row.id, branchId: row.branch_id, payload: payloadOf(row) }))
    .filter((row) => !purchaseFilter || purchaseFilter === String(row.payload.batchNo || "").toLowerCase() || purchaseFilter === String(row.payload.batchId || row.id).toLowerCase())
    .map((row) => ({ id: row.id, branchId: row.branchId, batchNo: row.payload.batchNo || "", batchId: row.payload.batchId || row.id, productId: row.payload.productId || "", productName: row.payload.productName || "", status: row.payload.status || "" }));
  const reversalAudit = [];
  const repairs = [];

  for (const row of reversalResult.rows) {
    const reversal = payloadOf(row);
    const purchaseNo = String(reversal.purchaseBatchNo || reversal.purchaseBatchId || "").trim();
    if (purchaseFilter && purchaseFilter !== purchaseNo.toLowerCase() && purchaseFilter !== String(reversal.purchaseBatchId || "").toLowerCase()) continue;
    const branchId = String(reversal.branchId || row.branch_id || "").trim();
    const restoredCosts = reversal.restoredCosts && typeof reversal.restoredCosts === "object" ? reversal.restoredCosts : {};
    reversalAudit.push({ id: row.id, branchId, purchaseNo, reversedAt: reversal.reversedAt || row.server_ts, restoredCosts });
    for (const [productId, expectedValue] of Object.entries(restoredCosts)) {
      const expectedCostCents = Math.round(Number(expectedValue));
      const product = products.get(String(productId));
      if (!branchId || !product || !Number.isFinite(expectedCostCents) || expectedCostCents < 0) continue;
      const currentCostCents = costForBranch(product.payload, branchId);
      if (Number.isFinite(currentCostCents) && Math.round(currentCostCents) === expectedCostCents) continue;
      repairs.push({
        reversalId: row.id,
        purchaseNo: purchaseNo || "Purchase reversal",
        branchId,
        productId,
        productName: product.payload.name || product.payload.productName || productId,
        currentCostCents: Number.isFinite(currentCostCents) ? Math.round(currentCostCents) : null,
        restoredCostCents: expectedCostCents,
        productUpdatedAt: Number(product.updated_at || 0),
        productServerTs: Number(product.server_ts || 0),
        productPayload: product.payload,
      });
    }
  }

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", purchaseLines, reversalAudit, repairs: repairs.map(({ productPayload, ...repair }) => repair) }, null, 2));
    console.log("Dry run only. Re-run with --apply to restore the recorded reversal costs.");
    return;
  }

  await tx(async (client) => {
    let repairTs = Date.now();
    for (const repair of repairs) {
      repairTs = Math.max(repairTs + 1, repair.productUpdatedAt + 1);
      const audit = {
        reversalId: repair.reversalId,
        purchaseNo: repair.purchaseNo,
        branchId: repair.branchId,
        previousCostCents: repair.currentCostCents,
        restoredCostCents: repair.restoredCostCents,
        repairedAt: repairTs,
        repairedBy: "purchase-reversal-cost-reconciliation",
      };
      const payload = withBranchCost(repair.productPayload, repair.branchId, repair.restoredCostCents, audit);
      await client.query(
        isMySql
          ? "UPDATE records SET payload = $1, updated_at = $2, server_ts = $3, device_id = $4 WHERE type = 'product' AND id = $5"
          : "UPDATE records SET payload = $1, updated_at = $2, server_ts = $3, device_id = $4 WHERE type = 'product' AND id = $5",
        [payload, repairTs, repairTs, "reconcile-purchase-reversal-cost", repair.productId]
      );
      await client.query(
        isMySql
          ? "INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)"
          : "INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
        [`purchase-reversal-cost-repair:${repair.reversalId}:${repair.productId}`, "purchaseReversalCostRepair", repair.branchId, "reconcile-purchase-reversal-cost", repairTs, repairTs, audit]
      );
    }
  });
  console.log(JSON.stringify({ mode: "applied", repairedCosts: repairs.map(({ productPayload, ...repair }) => repair) }, null, 2));
}

main().catch((error) => {
  console.error("purchase reversal cost reconciliation failed:", error?.message || error);
  process.exit(1);
});
