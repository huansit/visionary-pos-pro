import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPurchaseLotTrace,
  formatPurchaseLotStamp,
  nextPurchaseOrderNumber,
} from "../frontend/src/admin/purchaseLotTraceability.js";

const purchase = (id, batchNo, qty, branchId = "b1") => ({
  id, batchId: `batch-${id}`, batchNo, productId: "p1", branchId, qty,
  status: "received", supplierName: "Supplier", receivedAt: 100,
});

const movement = (id, qty, extra = {}) => ({
  id, productId: "p1", branchId: "b1", qty, ts: 100, ...extra,
});

test("active stock keeps its purchase order stamp until the lot is exhausted", () => {
  const data = {
    purchases: [purchase("po1", "PO-0043", 5)],
    stockMovements: [
      movement("receive", 5, { purchaseId: "po1", purchaseBatchId: "batch-po1" }),
      movement("sale", -2, { ts: 200 }),
    ],
  };
  const trace = buildPurchaseLotTrace(data);
  assert.equal(formatPurchaseLotStamp(trace.activeLotsFor("p1", "b1")), "PO-0043 (3)");
  assert.equal(formatPurchaseLotStamp(trace.referencesForMovement("sale")), "PO-0043 (2)");
});

test("purchase stamp disappears after all units from the lot leave stock", () => {
  const trace = buildPurchaseLotTrace({
    purchases: [purchase("po1", "PO-0043", 2)],
    stockMovements: [movement("receive", 2, { purchaseId: "po1" }), movement("sale", -2, { ts: 200 })],
  });
  assert.deepEqual(trace.activeLotsFor("p1", "b1"), []);
  assert.equal(formatPurchaseLotStamp(trace.referencesForMovement("sale")), "PO-0043 (2)");
});

test("branch transfers preserve the originating purchase order", () => {
  const trace = buildPurchaseLotTrace({
    purchases: [purchase("po1", "PO-0043", 4)],
    stockMovements: [
      movement("receive", 4, { purchaseId: "po1" }),
      movement("transfer-out", -2, { transferId: "tr1", ts: 200 }),
      movement("transfer-in", 2, { transferId: "tr1", branchId: "b2", ts: 200 }),
    ],
  });
  assert.equal(formatPurchaseLotStamp(trace.activeLotsFor("p1", "b1")), "PO-0043 (2)");
  assert.equal(formatPurchaseLotStamp(trace.activeLotsFor("p1", "b2")), "PO-0043 (2)");
});

test("FIFO shortages identify both legacy and purchase units consumed", () => {
  const trace = buildPurchaseLotTrace({
    purchases: [purchase("po1", "PO-0043", 3)],
    stockMovements: [
      movement("opening", 2, { ts: 50 }),
      movement("receive", 3, { purchaseId: "po1", ts: 100 }),
      movement("loss", -4, { ts: 200 }),
    ],
  });
  assert.equal(formatPurchaseLotStamp(trace.referencesForMovement("loss")), "Legacy/untracked (2), PO-0043 (2)");
  assert.equal(formatPurchaseLotStamp(trace.activeLotsFor("p1", "b1")), "PO-0043 (1)");
});

test("purchase order numbering continues after the highest historical sequence", () => {
  assert.equal(nextPurchaseOrderNumber([{ batchNo: "PO-0043" }, { batchNo: "PO-0047" }, { batchNo: "legacy" }]), "PO-0048");
});
