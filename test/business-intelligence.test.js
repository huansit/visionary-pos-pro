import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOneWeekPurchaseOrderPlans,
  formatOneWeekPurchaseOrders,
} from "../frontend/src/admin/businessIntelligence.js";

const recommendation = (overrides = {}) => ({
  productId: "juice",
  productName: "Juice",
  sku: "J001",
  branchId: "cpt",
  tier: "fast",
  onHand: 2,
  weeklyDemand: 4,
  targetStock: 6,
  incomingApplied: 0,
  transferQty: 0,
  reorderQty: 4,
  costCents: 10000,
  ...overrides,
});

test("builds one-week plans for active branches using fast and medium movers", () => {
  const plans = buildOneWeekPurchaseOrderPlans({
    branches: [
      { id: "cpt", name: "Cape Town", active: true },
      { id: "sip", name: "SIPCITY", active: true },
      { id: "old", name: "Closed", active: false },
    ],
    recommendations: [
      recommendation(),
      recommendation({ productId: "water", productName: "Water", branchId: "sip", tier: "medium", reorderQty: 3 }),
      recommendation({ productId: "slow", productName: "Slow", branchId: "sip", tier: "slow", reorderQty: 8 }),
    ],
  });

  assert.equal(plans.length, 2);
  assert.equal(plans[0].lookbackDays, 28);
  assert.equal(plans[0].coverDays, 7);
  assert.equal(plans[0].estimatedTotalCostCents, 40000);
  assert.equal(
    formatOneWeekPurchaseOrders(plans),
    "Cape Town\r\nProducts-Amount\r\nJuice-4\r\n\r\nSIPCITY\r\nProducts-Amount\r\nWater-3",
  );
});

test("explains when no one-week purchase order is required", () => {
  const plans = buildOneWeekPurchaseOrderPlans({
    branches: [{ id: "cpt", name: "Cape Town", active: true }],
    recommendations: [],
  });

  assert.equal(formatOneWeekPurchaseOrders(plans), "No fast or medium-moving products require a one-week reorder.");
});
