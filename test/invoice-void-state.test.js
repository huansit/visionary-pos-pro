import assert from "node:assert/strict";
import test from "node:test";
import { invoiceIsVoidedFromData, invoiceVoidStateFromData } from "../frontend/src/admin/invoiceVoidState.js";

test("an approved void remains final even when a newer request is present", () => {
  const data = {
    invoices: [{ id: "inv-1", status: "open" }],
    invoiceVoidRequests: [
      { id: "request-approved", invoiceId: "inv-1", requestedAt: 100 },
      { id: "request-newer", invoiceId: "inv-1", requestedAt: 300 },
    ],
    invoiceVoidDecisions: [
      { id: "decision-approved", invoiceId: "inv-1", requestId: "request-approved", decision: "APPROVED", decidedAt: 200 },
      { id: "decision-rejected", invoiceId: "inv-1", requestId: "request-newer", decision: "rejected", decidedAt: 400 },
    ],
  };

  assert.equal(invoiceIsVoidedFromData(data, data.invoices[0]), true);
  assert.equal(invoiceVoidStateFromData(data, "inv-1").status, "approved");
  assert.equal(invoiceVoidStateFromData(data, "inv-1").decision.id, "decision-approved");

  const businessDayTotal = [
    data.invoices[0],
    { id: "inv-2", status: "paid", totalCents: 125000 },
  ]
    .filter((invoice) => !invoiceIsVoidedFromData(data, invoice))
    .reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0);
  assert.equal(businessDayTotal, 125000);
});

test("legacy direct void status is excluded without a separate decision record", () => {
  const invoice = { id: "inv-legacy", status: "voided" };
  const data = { invoices: [invoice], invoiceVoidRequests: [], invoiceVoidDecisions: [] };

  assert.equal(invoiceIsVoidedFromData(data, invoice), true);
  assert.equal(invoiceVoidStateFromData(data, invoice).status, "approved");
});

test("rejected or pending void requests keep an invoice operational", () => {
  const invoice = { id: "inv-open", status: "open" };
  const pending = {
    invoices: [invoice],
    invoiceVoidRequests: [{ id: "request", invoiceId: "inv-open", requestedAt: 100 }],
    invoiceVoidDecisions: [],
  };
  const rejected = {
    ...pending,
    invoiceVoidDecisions: [{ id: "decision", invoiceId: "inv-open", requestId: "request", decision: "rejected", decidedAt: 200 }],
  };

  assert.equal(invoiceIsVoidedFromData(pending, invoice), false);
  assert.equal(invoiceVoidStateFromData(pending, invoice).status, "pending");
  assert.equal(invoiceIsVoidedFromData(rejected, invoice), false);
  assert.equal(invoiceVoidStateFromData(rejected, invoice).status, "rejected");
});
