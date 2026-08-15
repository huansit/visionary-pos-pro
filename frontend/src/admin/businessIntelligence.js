import {
  preparePurchaseOrderLines,
  purchaseOrderExportText,
  purchaseOrderTotalCents,
  selectedPurchaseOrderLines,
} from "./purchaseOrderPlanner.js";

export function buildOneWeekPurchaseOrderPlans({
  branches = [],
  recommendations = [],
  supplierPrices = [],
  suppliers = [],
} = {}) {
  const defaultSupplierId = suppliers[0]?.id || "";

  return branches
    .filter((branch) => branch?.active !== false)
    .map((branch) => {
      const lines = selectedPurchaseOrderLines(preparePurchaseOrderLines(recommendations, {
        branchId: branch.id,
        movementFilter: "active",
        supplierPrices,
        suppliers,
        defaultSupplierId,
      }));

      return {
        branchId: branch.id,
        branchName: branch.name || "Branch",
        lookbackDays: 28,
        coverDays: 7,
        itemCount: lines.length,
        unitCount: lines.reduce((sum, line) => sum + Math.max(0, Math.floor(Number(line.qty) || 0)), 0),
        estimatedTotalCostCents: purchaseOrderTotalCents(lines),
        lines,
        exportText: purchaseOrderExportText(lines),
      };
    });
}

export function formatOneWeekPurchaseOrders(plans = []) {
  const populated = plans.filter((plan) => plan.lines?.length);
  if (!populated.length) return "No fast or medium-moving products require a one-week reorder.";

  return populated
    .map((plan) => `${plan.branchName}\r\n${plan.exportText}`)
    .join("\r\n\r\n");
}
