import test from "node:test";
import assert from "node:assert/strict";
import { reconcileInvoicePaymentState } from "../frontend/src/admin/invoicePaymentReconciliation.js";

test("captured payments repair a fully settled invoice left open by out-of-order sync", () => {
  const invoice = { id: "inv_1", status: "open", totalCents: 150000, paidCents: 0 };
  const result = reconcileInvoicePaymentState(invoice, 150000);

  assert.equal(result.paidCents, 150000);
  assert.equal(result.status, "paid");
});

test("partial captured payments keep an invoice open", () => {
  const invoice = { id: "inv_1", status: "open", totalCents: 150000, paidCents: 0 };
  const result = reconcileInvoicePaymentState(invoice, 50000);

  assert.equal(result.paidCents, 50000);
  assert.equal(result.status, "open");
});

test("reconciliation never converts voided or rejected invoices to paid", () => {
  for (const status of ["voided", "cancelled", "rejected"]) {
    const result = reconcileInvoicePaymentState({ status, totalCents: 10000, paidCents: 0 }, 10000);
    assert.equal(result.status, status);
  }

  const approvedVoid = reconcileInvoicePaymentState(
    { status: "open", totalCents: 10000, paidCents: 0 },
    10000,
    { voided: true },
  );
  assert.equal(approvedVoid.status, "open");
});

test("zero-value open invoices are not silently marked paid", () => {
  const result = reconcileInvoicePaymentState({ status: "open", totalCents: 0, paidCents: 0 }, 0);
  assert.equal(result.status, "open");
});
