import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateInvoicePayments,
  findMpesaReceipt,
  mpesaReceiptLedger,
  normalizeMpesaCodeLast4,
} from "../frontend/src/admin/mpesaReceiptLedger.js";

const allocation = (overrides = {}) => ({
  id: "pay-1",
  status: "captured",
  method: "m-pesa",
  branchId: "branch-a",
  amountCents: 40000,
  mpesaReceiptId: "receipt-1",
  mpesaCodeLast4: "7X9Q",
  mpesaReceiptTotalCents: 100000,
  mpesaReceiptRegisteredAt: 100,
  ...overrides,
});

test("normalizes only the last four M-Pesa code characters", () => {
  assert.equal(normalizeMpesaCodeLast4(" qwe-7x9q "), "7X9Q");
  assert.equal(normalizeMpesaCodeLast4("12"), "12");
});

test("tracks one receipt total without recounting it for every invoice allocation", () => {
  const payments = [
    allocation({ providerVerified: true, kopokopoTransactionId: "txn-1", mpesaPayerName: "Test Customer" }),
    allocation({ id: "pay-2", amountCents: 35000 }),
  ];
  const [receipt] = mpesaReceiptLedger(payments, { branchId: "branch-a", codeLast4: "7x9q" });
  assert.equal(receipt.totalCents, 100000);
  assert.equal(receipt.allocatedCents, 75000);
  assert.equal(receipt.remainingCents, 25000);
  assert.equal(receipt.providerVerified, true);
  assert.equal(receipt.kopokopoTransactionId, "txn-1");
  assert.equal(receipt.payerName, "Test Customer");
});

test("keeps identical last-four codes isolated by branch", () => {
  const payments = [allocation(), allocation({ id: "pay-2", branchId: "branch-b", mpesaReceiptId: "receipt-2" })];
  assert.equal(findMpesaReceipt(payments, { branchId: "branch-a", codeLast4: "7X9Q" }).id, "receipt-1");
  assert.equal(findMpesaReceipt(payments, { branchId: "branch-b", codeLast4: "7X9Q" }).id, "receipt-2");
});

test("shares one remaining balance across allocations from different invoices", () => {
  const receipt = findMpesaReceipt([
    allocation({ invoiceId: "invoice-a", cashierId: "cashier-a" }),
    allocation({ id: "pay-2", invoiceId: "invoice-b", cashierId: "cashier-b", amountCents: 60000 }),
  ], { branchId: "branch-a", codeLast4: "7X9Q" });
  assert.equal(receipt.allocatedCents, 100000);
  assert.equal(receipt.remainingCents, 0);
});

test("ignores rejected payment allocations when calculating remaining value", () => {
  const receipt = findMpesaReceipt([
    allocation(),
    allocation({ id: "pay-2", status: "rejected", amountCents: 60000 }),
  ], { branchId: "branch-a", codeLast4: "7X9Q" });
  assert.equal(receipt.remainingCents, 60000);
});

test("does not fully clear an invoice when the saved code amount is smaller than its balance", () => {
  const result = allocateInvoicePayments([
    { id: "invoice-a", totalCents: 100000, paidCents: 0 },
  ], { mpesaCents: 50000, cashCents: 0 });
  assert.deepEqual(result.allocations[0], {
    invoiceId: "invoice-a",
    mpesaCents: 50000,
    cashCents: 0,
    appliedCents: 50000,
    paidCents: 50000,
    outstandingCents: 50000,
    cleared: false,
  });
});

test("supports an exact M-Pesa and cash split without overstating either method", () => {
  const result = allocateInvoicePayments([
    { id: "invoice-a", totalCents: 100000, paidCents: 0 },
  ], { mpesaCents: 60000, cashCents: 40000 });
  assert.equal(result.allocations[0].cleared, true);
  assert.equal(result.allocations[0].mpesaCents, 60000);
  assert.equal(result.allocations[0].cashCents, 40000);
  assert.equal(result.mpesaRemaining, 0);
  assert.equal(result.cashRemaining, 0);
});

test("depletes one code across invoices in order and leaves the last invoice partially open", () => {
  const result = allocateInvoicePayments([
    { id: "invoice-a", totalCents: 40000, paidCents: 0 },
    { id: "invoice-b", totalCents: 70000, paidCents: 0 },
  ], { mpesaCents: 100000, cashCents: 0 });
  assert.equal(result.allocations[0].cleared, true);
  assert.equal(result.allocations[1].paidCents, 60000);
  assert.equal(result.allocations[1].outstandingCents, 10000);
  assert.equal(result.allocations[1].cleared, false);
});
