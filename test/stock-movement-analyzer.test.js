import test from "node:test";
import assert from "node:assert/strict";
import { analyzeStockMovements } from "../frontend/src/admin/stockMovementAnalyzer.js";

const row = (overrides = {}) => ({
  id: "juice:cpt",
  productKey: "sku:juice",
  productId: "juice-cpt",
  productName: "Juice",
  sku: "J001",
  branchId: "cpt",
  branchName: "Cape Town",
  onHand: 1,
  soldUnits: 28,
  reorderLevel: 4,
  costCents: 10000,
  incomingQty: 0,
  ...overrides,
});

test("moves genuine surplus to a fast-moving branch before recommending a reorder", () => {
  const result = analyzeStockMovements([
    row(),
    row({ id: "juice:sip", productId: "juice-sip", branchId: "sip", branchName: "SIPCITY", onHand: 30, soldUnits: 0 }),
  ], { lookbackDays: 28 });
  const recommendation = result.recommendations.find((entry) => entry.branchId === "cpt");
  assert.equal(recommendation.tier, "fast");
  assert.equal(recommendation.targetStock, 14);
  assert.equal(recommendation.transferQty, 13);
  assert.equal(recommendation.reorderQty, 0);
  assert.equal(recommendation.transfers[0].sourceReserve, 4);
  assert.equal(recommendation.transfers[0].sourceOnHand, 30);
  assert.equal(recommendation.transfers[0].sourceAvailableBeforeTransfer, 26);
  assert.equal(recommendation.transfers[0].sourceAvailableAfterTransfer, 13);
});

test("uses available stock from another branch even when its cost is not recorded", () => {
  const result = analyzeStockMovements([
    row({ onHand: 1, soldUnits: 28 }),
    row({ id: "juice:sip", productId: "juice-sip", branchId: "sip", branchName: "SIPCITY", onHand: 20, soldUnits: 0, costCents: 0 }),
  ], { lookbackDays: 28 });
  const recommendation = result.recommendations.find((entry) => entry.branchId === "cpt");
  assert.equal(recommendation.transferQty, 13);
  assert.equal(recommendation.reorderQty, 0);
  assert.equal(recommendation.transfers[0].sourceOnHand, 20);
  assert.equal(recommendation.transfers[0].sourceReserve, 4);
});

test("never allocates the same source surplus twice", () => {
  const result = analyzeStockMovements([
    row({ id: "juice:a", branchId: "a", branchName: "A", onHand: 0, soldUnits: 28 }),
    row({ id: "juice:b", branchId: "b", branchName: "B", onHand: 0, soldUnits: 21 }),
    row({ id: "juice:source", branchId: "source", branchName: "Source", onHand: 12, soldUnits: 0 }),
  ], { lookbackDays: 28 });
  assert.equal(result.recommendations.reduce((sum, entry) => sum + entry.transferQty, 0), 8);
  assert.ok(result.recommendations.reduce((sum, entry) => sum + entry.reorderQty, 0) > 0);
});

test("subtracts open purchase quantities from the supplier reorder recommendation", () => {
  const [recommendation] = analyzeStockMovements([
    row({ onHand: 0, soldUnits: 8, incomingQty: 3 }),
  ], { lookbackDays: 28 }).recommendations;
  assert.equal(recommendation.tier, "medium");
  assert.equal(recommendation.needQty, 6);
  assert.equal(recommendation.incomingApplied, 3);
  assert.equal(recommendation.reorderQty, 3);
});

test("uses a pending incoming transfer before proposing another branch transfer", () => {
  const result = analyzeStockMovements([
    row({ onHand: 0, soldUnits: 8, pendingTransferIncomingQty: 6 }),
    row({ id: "juice:sip", productId: "juice-sip", branchId: "sip", branchName: "SIPCITY", onHand: 20, soldUnits: 0 }),
  ], { lookbackDays: 28 });
  const recommendation = result.recommendations.find((entry) => entry.branchId === "cpt");
  assert.equal(recommendation.incomingApplied, 6);
  assert.equal(recommendation.transferQty, 0);
  assert.equal(recommendation.reorderQty, 0);
  assert.equal(recommendation.action, "incoming");
});

test("does not offer stock already reserved by a pending transfer request", () => {
  const result = analyzeStockMovements([
    row({ id: "juice:a", branchId: "a", branchName: "A", onHand: 0, soldUnits: 28 }),
    row({ id: "juice:source", branchId: "source", branchName: "Source", onHand: 20, soldUnits: 0, reservedOutgoingQty: 10 }),
  ], { lookbackDays: 28 });
  const recommendation = result.recommendations.find((entry) => entry.branchId === "a");
  assert.equal(recommendation.transferQty, 6);
  assert.equal(recommendation.reorderQty, 8);
  assert.equal(recommendation.transfers[0].sourceReservedOutgoingQty, 10);
  assert.equal(recommendation.transfers[0].sourceAvailableBeforeTransfer, 6);
  assert.equal(recommendation.transfers[0].sourceAvailableAfterTransfer, 0);
});

test("does not recommend transfers or reorders for slow-moving products", () => {
  const result = analyzeStockMovements([row({ onHand: 0, soldUnits: 1 })], { lookbackDays: 28 });
  assert.equal(result.rows[0].tier, "slow");
  assert.deepEqual(result.recommendations, []);
});
