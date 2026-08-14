import test from "node:test";
import assert from "node:assert/strict";
import { buildMpesaInvoiceAudit } from "../frontend/src/admin/mpesaInvoiceAudit.js";

const branches = [{ id: "b_cpt", name: "Cape Town" }, { id: "b_sip", name: "SIPCITY" }];

function invoice(overrides = {}) {
  return { id: "inv_1", number: "RCP-CPT-000001", branchId: "b_cpt", status: "paid", totalCents: 10000, paidCents: 10000, ts: 1000, ...overrides };
}

function transaction(overrides = {}) {
  return {
    id: "tx_1",
    referenceMasked: "****ABCD",
    branchId: "b_cpt",
    amountCents: 10000,
    allocatedCents: 10000,
    remainingCents: 0,
    status: "received",
    originationTime: new Date(1000).toISOString(),
    allocations: [{ id: "alloc_1", invoiceId: "inv_1", invoiceNumber: "RCP-CPT-000001", amountCents: 10000, status: "active" }],
    offsets: [],
    ...overrides,
  };
}

function providerPayment(overrides = {}) {
  return { id: "pay_1", invoiceId: "inv_1", method: "m-pesa", status: "captured", amountCents: 10000, providerVerified: true, kopokopoTransactionId: "tx_1", ...overrides };
}

test("fully reconciled provider payment has no audit issues", () => {
  const audit = buildMpesaInvoiceAudit({ transactions: [transaction()], invoices: [invoice()], payments: [providerPayment()], branches, now: 5000 });
  assert.equal(audit.issues.length, 0);
  assert.equal(audit.summary.receivedCents, 10000);
  assert.equal(audit.summary.invoiceAllocatedCents, 10000);
  assert.equal(audit.summary.availableCents, 0);
  assert.match(audit.availableComment, /accounted for/i);
});

test("cash offsets consume available money without paying the invoice", () => {
  const cashInvoice = invoice({ status: "paid" });
  const cashPayment = { id: "cash_1", invoiceId: "inv_1", method: "cash", status: "captured", amountCents: 10000 };
  const deposited = transaction({ allocations: [], offsets: [{ id: "offset_1", invoiceId: "inv_1", invoiceNumber: cashInvoice.number, amountCents: 10000, status: "active" }] });
  const audit = buildMpesaInvoiceAudit({ transactions: [deposited], invoices: [cashInvoice], payments: [cashPayment], branches, now: 5000 });
  assert.equal(audit.summary.invoiceAllocatedCents, 0);
  assert.equal(audit.summary.offsetCents, 10000);
  assert.equal(audit.invoices[0].cashCents, 10000);
  assert.equal(audit.invoices[0].offsetCents, 10000);
  assert.match(audit.invoices[0].comment, /paid as cash/i);
  assert.equal(audit.issues.length, 0);
});

test("stored used amount must match active allocation and offset links", () => {
  const broken = transaction({ allocatedCents: 8000, remainingCents: 2000 });
  const audit = buildMpesaInvoiceAudit({ transactions: [broken], invoices: [invoice()], payments: [providerPayment()], branches, now: 5000 });
  assert.ok(audit.issues.some((entry) => entry.code === "ledger_link_mismatch" && entry.severity === "critical"));
});

test("orphan and cross-branch allocations are flagged", () => {
  const missing = transaction({ id: "tx_missing", allocations: [{ id: "a_missing", invoiceId: "none", amountCents: 5000 }], amountCents: 5000, allocatedCents: 5000 });
  const crossBranch = transaction({ id: "tx_cross", referenceMasked: "****CROSS", branchId: "b_sip" });
  const audit = buildMpesaInvoiceAudit({ transactions: [missing, crossBranch], invoices: [invoice()], payments: [], branches, now: 5000 });
  assert.ok(audit.issues.some((entry) => entry.code === "orphan_allocation"));
  assert.ok(audit.issues.some((entry) => entry.code === "allocation_branch_mismatch"));
});

test("a transaction can trace an invoice outside the selected report period", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [transaction()],
    invoices: [],
    referenceInvoices: [invoice()],
    payments: [],
    branches,
    now: 5000,
    transactionScopeComplete: false,
  });
  assert.equal(audit.invoices.length, 0);
  assert.equal(audit.transactions[0].activeAllocations[0].invoiceNumber, "RCP-CPT-000001");
  assert.ok(!audit.issues.some((entry) => entry.code === "orphan_allocation"));
});

test("cash offsets must remain in the same branch and cannot target voided invoices", () => {
  const crossBranch = transaction({
    branchId: "b_sip",
    allocations: [],
    offsets: [{ id: "offset_cross", invoiceId: "inv_1", amountCents: 10000, status: "active" }],
  });
  const voidedOffset = transaction({
    id: "tx_void",
    allocations: [],
    offsets: [{ id: "offset_void", invoiceId: "inv_void", amountCents: 10000, status: "active" }],
  });
  const audit = buildMpesaInvoiceAudit({
    transactions: [crossBranch, voidedOffset],
    invoices: [invoice(), invoice({ id: "inv_void", number: "RCP-CPT-000002", status: "voided", paidCents: 0 })],
    payments: [],
    branches,
    now: 5000,
  });
  assert.ok(audit.issues.some((entry) => entry.code === "offset_branch_mismatch"));
  assert.ok(audit.issues.some((entry) => entry.code === "offset_to_voided_invoice"));
});

test("old unallocated money is explained and flagged for review", () => {
  const old = transaction({ amountCents: 3000, allocatedCents: 0, remainingCents: 3000, allocations: [], originationTime: new Date(1000).toISOString() });
  const audit = buildMpesaInvoiceAudit({ transactions: [old], invoices: [], payments: [], branches, now: 48 * 3600000, staleAfterMs: 24 * 3600000 });
  assert.ok(audit.issues.some((entry) => entry.code === "stale_available_money"));
  assert.equal(audit.summary.availableCents, 3000);
  assert.equal(audit.summary.staleAvailableCents, 3000);
  assert.match(audit.availableComment, /older than the audit threshold/i);
});

test("stock funding and reversals do not become available customer money", () => {
  const funding = transaction({ id: "funding", purpose: "stock_funding", allocatedCents: 0, remainingCents: 0, allocations: [] });
  const reversed = transaction({ id: "reversed", reversedAt: new Date(2000).toISOString(), allocatedCents: 0, remainingCents: 0, allocations: [] });
  const audit = buildMpesaInvoiceAudit({ transactions: [funding, reversed], invoices: [], payments: [], branches, now: 5000 });
  assert.equal(audit.summary.transactionCount, 0);
  assert.equal(audit.summary.receivedCents, 0);
  assert.equal(audit.summary.availableCents, 0);
  assert.equal(audit.issues.length, 0);
});

test("invoice paid amount must agree with captured payments", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [invoice({ paidCents: 7000, status: "paid" })],
    payments: [{ id: "cash_1", invoiceId: "inv_1", method: "cash", status: "captured", amountCents: 6000 }],
    branches,
    now: 5000,
  });
  assert.ok(audit.issues.some((entry) => entry.code === "invoice_payment_total_mismatch"));
  assert.ok(audit.issues.some((entry) => entry.code === "paid_invoice_has_balance"));
});

test("audit excludes transactions and invoices created before each branch integration", () => {
  const transactions = [
    transaction({ id: "tx_cpt_before", branchId: "b_cpt", originationTime: new Date(1500).toISOString() }),
    transaction({ id: "tx_cpt_after", branchId: "b_cpt", originationTime: new Date(2500).toISOString() }),
    transaction({ id: "tx_sip_before", branchId: "b_sip", originationTime: new Date(3500).toISOString() }),
    transaction({ id: "tx_sip_after", branchId: "b_sip", originationTime: new Date(4500).toISOString() }),
  ].map((entry) => ({ ...entry, allocations: [], allocatedCents: 0, remainingCents: entry.amountCents }));
  const invoices = [
    invoice({ id: "inv_cpt_before", branchId: "b_cpt", ts: 1500 }),
    invoice({ id: "inv_cpt_after", branchId: "b_cpt", ts: 2500 }),
    invoice({ id: "inv_sip_before", branchId: "b_sip", ts: 3500 }),
    invoice({ id: "inv_sip_after", branchId: "b_sip", ts: 4500 }),
  ];

  const audit = buildMpesaInvoiceAudit({
    transactions,
    invoices,
    payments: [],
    branches,
    branchAuditStarts: { b_cpt: 2000, b_sip: 4000 },
    now: 5000,
  });

  assert.deepEqual(audit.transactions.map((entry) => entry.id).sort(), ["tx_cpt_after", "tx_sip_after"]);
  assert.deepEqual(audit.invoices.map((entry) => entry.id).sort(), ["inv_cpt_after", "inv_sip_after"]);
  assert.equal(audit.excludedTransactionCount, 2);
  assert.equal(audit.excludedInvoiceCount, 2);
});

test("a branch without verified Kopo Kopo history is not audited", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [invoice({ branchId: "b_sip", ts: 5000 })],
    payments: [],
    branches,
    branchAuditStarts: { b_sip: 0 },
    now: 6000,
  });

  assert.equal(audit.invoices.length, 0);
  assert.equal(audit.excludedInvoiceCount, 1);
});
