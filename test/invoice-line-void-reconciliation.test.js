import assert from "node:assert/strict";
import test from "node:test";
import { applyApprovedInvoiceLineVoids } from "../frontend/src/admin/invoiceLineVoidReconciliation.js";

test("approved partial item void keeps the audit line while reducing report totals", () => {
  const invoice = {
    id: "invoice-1",
    totalCents: 35000,
    paidCents: 0,
    items: [
      { productId: "beer", name: "Beer", qty: 2, priceCents: 10000 },
      { productId: "water", name: "Water", qty: 3, priceCents: 5000 },
    ],
  };
  const data = {
    invoiceLineVoidRequests: [{ id: "void-request-1", invoiceId: invoice.id, lineIndex: 1, qty: 2 }],
    invoiceLineVoidDecisions: [{ id: "void-decision-1", invoiceId: invoice.id, requestId: "void-request-1", decision: "approved" }],
  };

  const [projected] = applyApprovedInvoiceLineVoids(data, [invoice]);

  assert.equal(projected.totalCents, 25000);
  assert.deepEqual(projected.items.map((item) => [item.productId, item.qty]), [["beer", 2], ["water", 1]]);
  assert.deepEqual(projected._lineVoidAuditItems.map((item) => [item.productId, item.qty, item.remainingQty, item.voidedQty]), [
    ["beer", 2, 2, 0],
    ["water", 3, 1, 2],
  ]);
  assert.equal(projected.lineVoided, true);
  assert.equal(projected.lineVoidCents, 10000);
});

test("end-of-day invoice snapshots receive the same approved partial void projection", () => {
  const snapshot = {
    id: "invoice-closed",
    totalCents: 30000,
    items: [{ productId: "spirit", qty: 3, priceCents: 10000 }],
  };
  const data = {
    invoiceLineVoidRequests: [{ id: "closed-void-request", invoiceId: snapshot.id, lineIndex: 0, qty: 1 }],
    invoiceLineVoidDecisions: [{ id: "closed-void-decision", invoiceId: snapshot.id, requestId: "closed-void-request", decision: "approved" }],
  };

  const [projected] = applyApprovedInvoiceLineVoids(data, [snapshot]);
  assert.equal(projected.totalCents, 20000);
  assert.equal(projected.items[0].qty, 2);
  assert.equal(projected._lineVoidAuditItems[0].voidedQty, 1);
});
