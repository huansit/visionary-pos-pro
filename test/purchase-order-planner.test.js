import test from "node:test";
import assert from "node:assert/strict";
import {
  preparePurchaseOrderLines,
  purchaseOrderExportText,
  purchaseOrderLineTotalCents,
  purchaseOrderTotalCents,
} from "../frontend/src/admin/purchaseOrderPlanner.js";

const recommendation = (overrides = {}) => ({
  productId: "juice-cpt",
  productName: "Juice",
  sku: "J001",
  branchId: "cpt",
  tier: "fast",
  onHand: 2,
  weeklyDemand: 10.5,
  targetStock: 21,
  incomingApplied: 3,
  transferQty: 4,
  reorderQty: 12,
  costCents: 12500,
  ...overrides,
});

test("prepares fast products before medium products and excludes slow products", () => {
  const lines = preparePurchaseOrderLines([
    recommendation({ productId: "medium", productName: "Medium", tier: "medium", weeklyDemand: 4, reorderQty: 5 }),
    recommendation({ productId: "slow", productName: "Slow", tier: "slow", weeklyDemand: 1, reorderQty: 8 }),
    recommendation(),
  ], { branchId: "cpt" });

  assert.deepEqual(lines.map((line) => line.productId), ["juice-cpt", "medium"]);
  assert.equal(lines[0].weeklyDemand, 10.5);
  assert.equal(lines[0].averageCostCents, 12500);
});

test("supports fast-only and medium-only prepared order filters", () => {
  const recommendations = [
    recommendation(),
    recommendation({ productId: "medium", tier: "medium", reorderQty: 4 }),
  ];
  assert.deepEqual(preparePurchaseOrderLines(recommendations, { branchId: "cpt", movementFilter: "fast" }).map((line) => line.tier), ["fast"]);
  assert.deepEqual(preparePurchaseOrderLines(recommendations, { branchId: "cpt", movementFilter: "medium" }).map((line) => line.tier), ["medium"]);
});

test("uses the cheapest supplier quote while retaining the moving average cost", () => {
  const [line] = preparePurchaseOrderLines([recommendation()], {
    branchId: "cpt",
    suppliers: [{ id: "s1", name: "A" }, { id: "s2", name: "B" }],
    supplierPrices: [
      { id: "q1", productId: "juice-cpt", supplierId: "s1", costCents: 13000 },
      { id: "q2", productId: "juice-cpt", supplierId: "s2", costCents: 12000 },
    ],
  });
  assert.equal(line.averageCostCents, 12500);
  assert.equal(line.costCents, 12000);
  assert.equal(line.supplierId, "s2");
  assert.equal(purchaseOrderLineTotalCents(line), 144000);
});

test("totals and exports only selected positive-amount products", () => {
  const lines = [
    { name: "Juice", qty: 4, costCents: 10000, selected: true },
    { name: "Water", qty: 2, costCents: 5000, selected: false },
    { name: "Soda", qty: 0, costCents: 7000, selected: true },
  ];
  assert.equal(purchaseOrderTotalCents(lines), 40000);
  assert.equal(purchaseOrderExportText(lines), "Products-Amount\r\nJuice-4");
});

test("plain-text exports do not include commas", () => {
  const output = purchaseOrderExportText([
    { name: "Juice, Orange", qty: 3, costCents: 10000, selected: true },
  ]);

  assert.equal(output, "Products-Amount\r\nJuice Orange-3");
  assert.equal(output.includes(","), false);
});
