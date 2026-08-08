import test from "node:test";
import assert from "node:assert/strict";
import {
  invoiceRecoveryTimestamp,
  invoiceWasEverCarriedOver,
} from "../frontend/src/admin/creditRecovery.js";

test("keeps a settled debt in recovery history after its current carried-over flag clears", () => {
  const invoice = { id: "invoice-1", carriedOver: false, carriedOverAt: 100, paidCents: 1000, totalCents: 1000 };
  assert.equal(invoiceWasEverCarriedOver({}, invoice), true);
});

test("uses immutable End-of-Day invoice membership for legacy recovered debts", () => {
  const data = { endOfDays: [{ carriedOverInvoiceIds: ["invoice-1"] }] };
  assert.equal(invoiceWasEverCarriedOver(data, { id: "invoice-1", carriedOver: false }), true);
});

test("does not classify a normally paid invoice as recovered debt from closedDayId alone", () => {
  const invoice = { id: "invoice-1", closedDayId: "close-1", carriedOver: false };
  assert.equal(invoiceWasEverCarriedOver({}, invoice), false);
});

test("uses the latest captured settlement event as the recovery timestamp", () => {
  const data = { payments: [
    { id: "p1", invoiceId: "invoice-1", status: "captured", ts: 200 },
    { id: "p2", orderId: "invoice-1", status: "captured", ts: 350 },
    { id: "p3", invoiceId: "invoice-1", status: "rejected", ts: 900 },
  ] };
  assert.equal(invoiceRecoveryTimestamp(data, { id: "invoice-1", settledAt: 300 }), 350);
});
