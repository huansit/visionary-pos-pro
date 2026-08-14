import test from "node:test";
import assert from "node:assert/strict";
import {
  correctReceivedPurchaseCost,
  purchaseRepairStockQuantity,
  recoverableDeletedPurchaseLines,
  restoreDeletedPurchaseLine,
  updateOrderedPurchaseCost,
} from "../frontend/src/admin/purchaseCostRepair.js";

const ids = () => {
  let sequence = 0;
  return (prefix) => `${prefix}_test_${++sequence}`;
};

function baseData() {
  return {
    branches: [{ id: "b_cpt", name: "Cape Town" }],
    suppliers: [{ id: "s_1", name: "Supplier One" }],
    products: [{ id: "p_1", name: "Product One", sku: "CPT001" }],
    purchases: [{
      id: "po_keep",
      batchId: "pb_43",
      batchNo: "PO-0043",
      supplierId: "s_1",
      supplierName: "Supplier One",
      productId: "p_1",
      productName: "Product One",
      branchId: "b_cpt",
      qty: 2,
      costCents: 10000,
      lineTotalCents: 20000,
      status: "received",
      date: "2026-08-10",
      ts: 100,
    }],
    stockMovements: [{
      id: "mv_keep",
      purchaseId: "po_keep",
      purchaseBatchId: "pb_43",
      productId: "p_1",
      branchId: "b_cpt",
      qty: 2,
      costCents: 10000,
      valueCents: 20000,
      reason: "Purchase Supplier One",
      ts: 100,
    }],
  };
}

test("received purchase cost correction is audited without changing stock quantity", () => {
  const data = baseData();
  const beforeQty = purchaseRepairStockQuantity(data, "p_1", "b_cpt");
  const result = correctReceivedPurchaseCost(data, {
    purchaseId: "po_keep",
    correctedUnitCostCents: 12500,
    reason: "Supplier invoice price was entered incorrectly",
    actor: { id: "u_admin", name: "Admin" },
    correctedAt: 500,
    idFactory: ids(),
  });

  assert.equal(result.purchase.costCents, 12500);
  assert.equal(result.purchase.lineTotalCents, 25000);
  assert.equal(result.purchase.costCorrections.length, 1);
  assert.equal(result.purchase.costCorrections[0].actorName, "Admin");
  assert.equal(result.movement.qty, 0);
  assert.equal(result.movement.valueAdjustmentCents, 5000);
  assert.equal(purchaseRepairStockQuantity(result.data, "p_1", "b_cpt"), beforeQty);
  assert.equal(result.branchCostCents, 12500);
});

test("deleted PO-0043 line is recovered from its orphan movement without duplicating stock", () => {
  const data = baseData();
  data.products.push({ id: "p_deleted", name: "Deleted Item", sku: "CPT043" });
  data.stockMovements.push({
    id: "mv_deleted",
    purchaseId: "po_deleted",
    purchaseBatchId: "pb_43",
    productId: "p_deleted",
    branchId: "b_cpt",
    qty: 3,
    costCents: 20000,
    valueCents: 60000,
    reason: "Purchase Supplier One",
    ts: 110,
  });
  const beforeQty = purchaseRepairStockQuantity(data, "p_deleted", "b_cpt");
  const candidates = recoverableDeletedPurchaseLines(data, "pb_43");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].purchaseId, "po_deleted");

  const result = restoreDeletedPurchaseLine(data, {
    candidate: candidates[0],
    batchNo: "PO-0043",
    correctedUnitCostCents: 25000,
    reason: "Restore deleted item and use the supplier invoice cost",
    actor: { id: "u_admin", name: "Admin" },
    restoredAt: 600,
    idFactory: ids(),
  });

  assert.equal(result.purchase.id, "po_deleted");
  assert.equal(result.purchase.batchNo, "PO-0043");
  assert.equal(result.purchase.qty, 3);
  assert.equal(result.purchase.costCents, 25000);
  assert.equal(result.purchase.status, "received");
  assert.equal(result.purchase.restoredFromMovementId, "mv_deleted");
  assert.equal(result.costAudit.previousUnitCostCents, 20000);
  assert.equal(result.data.stockMovements.length, data.stockMovements.length + 1);
  assert.equal(result.data.stockMovements.at(-1).qty, 0);
  assert.equal(purchaseRepairStockQuantity(result.data, "p_deleted", "b_cpt"), beforeQty);
  assert.equal(result.branchCostCents, 25000);
  assert.equal(recoverableDeletedPurchaseLines(result.data, "pb_43").length, 0);
});

test("purchase repair requires a reason and cannot edit an outstanding order", () => {
  const data = baseData();
  data.purchases[0].status = "ordered";
  assert.throws(() => correctReceivedPurchaseCost(data, {
    purchaseId: "po_keep",
    correctedUnitCostCents: 12500,
    reason: "wrong",
  }), /Only received/);
  data.purchases[0].status = "received";
  assert.throws(() => correctReceivedPurchaseCost(data, {
    purchaseId: "po_keep",
    correctedUnitCostCents: 12500,
    reason: "",
  }), /correction reason/);
});

test("outstanding purchase cost can be replaced before receiving without changing stock", () => {
  const data = baseData();
  data.purchases[0].status = "ordered";
  data.purchases[0].receivedAt = null;
  const beforeMovements = data.stockMovements.length;

  const result = updateOrderedPurchaseCost(data, {
    purchaseId: "po_keep",
    updatedUnitCostCents: 13500,
    reason: "Supplier confirmed the final invoice price",
    actor: { id: "u_admin", name: "Admin" },
    updatedAt: 700,
    idFactory: ids(),
  });

  assert.equal(result.purchase.costCents, 13500);
  assert.equal(result.purchase.lineTotalCents, 27000);
  assert.equal(result.purchase.orderCostEdits.length, 1);
  assert.equal(result.purchase.orderCostEdits[0].previousUnitCostCents, 10000);
  assert.equal(result.purchase.orderCostEdits[0].actorName, "Admin");
  assert.equal(result.purchase.updatedAt, 700);
  assert.equal(result.data.stockMovements.length, beforeMovements);
  assert.strictEqual(result.data.products, data.products);
});

test("outstanding cost edit rejects received, unchanged, and unexplained changes", () => {
  const data = baseData();
  assert.throws(() => updateOrderedPurchaseCost(data, {
    purchaseId: "po_keep",
    updatedUnitCostCents: 12500,
    reason: "Final supplier price",
  }), /Received purchase costs/);

  data.purchases[0].status = "ordered";
  assert.throws(() => updateOrderedPurchaseCost(data, {
    purchaseId: "po_keep",
    updatedUnitCostCents: 10000,
    reason: "Final supplier price",
  }), /unchanged/);
  assert.throws(() => updateOrderedPurchaseCost(data, {
    purchaseId: "po_keep",
    updatedUnitCostCents: 12500,
    reason: "",
  }), /correction reason/);
});
