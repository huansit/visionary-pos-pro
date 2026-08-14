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

test("orphan and unauthorized cross-branch allocations are flagged", () => {
  const missing = transaction({ id: "tx_missing", allocations: [{ id: "a_missing", invoiceId: "none", amountCents: 5000 }], amountCents: 5000, allocatedCents: 5000 });
  const crossBranch = transaction({ id: "tx_cross", referenceMasked: "****CROSS", branchId: "b_sip" });
  const audit = buildMpesaInvoiceAudit({ transactions: [missing, crossBranch], invoices: [invoice()], payments: [], branches, now: 5000 });
  assert.ok(audit.issues.some((entry) => entry.code === "orphan_allocation"));
  assert.ok(audit.issues.some((entry) => entry.code === "allocation_without_cross_branch_whitelist"));
});

test("an authorized cross-branch settlement stays valid after its whitelist is revoked", () => {
  const crossBranch = transaction({
    branchId: "b_sip",
    crossBranchAllowed: false,
    allocations: [{
      id: "alloc_cross",
      invoiceId: "inv_1",
      invoiceNumber: "RCP-CPT-000001",
      branchId: "b_cpt",
      amountCents: 10000,
      status: "active",
      crossBranchAuthorized: true,
    }],
  });
  const audit = buildMpesaInvoiceAudit({ transactions: [crossBranch], invoices: [invoice()], payments: [], branches, now: 5000 });
  assert.ok(!audit.issues.some((entry) => entry.code === "allocation_without_cross_branch_whitelist"));
  assert.ok(!audit.issues.some((entry) => entry.code === "allocation_target_branch_mismatch"));
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

test("voided invoices are excluded from invoice totals and detailed invoice results", () => {
  const active = invoice();
  const voided = invoice({ id: "inv_void", number: "RCP-CPT-000002", status: "voided", totalCents: 25000, paidCents: 0 });
  const audit = buildMpesaInvoiceAudit({
    transactions: [transaction()],
    invoices: [active, voided],
    payments: [providerPayment()],
    branches,
    now: 5000,
  });

  assert.deepEqual(audit.invoices.map((entry) => entry.id), ["inv_1"]);
  assert.equal(audit.summary.invoiceCount, 1);
  assert.equal(audit.summary.invoiceValueCents, 10000);
  assert.equal(audit.summary.voidedInvoiceCount, 1);
  assert.equal(audit.excludedVoidedInvoiceCount, 1);
});

test("approved void decisions exclude invoices whose stored status is still open", () => {
  const pendingStatusInvoice = invoice({
    id: "inv_287",
    number: "RCP-SIP-000287",
    branchId: "b_sip",
    status: "open",
    totalCents: 25000,
    paidCents: 0,
  });
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [pendingStatusInvoice],
    referenceInvoices: [pendingStatusInvoice],
    payments: [],
    invoiceVoidRequests: [{ id: "void_request_287", invoiceId: "inv_287", requestedAt: 2000 }],
    invoiceVoidDecisions: [{
      id: "void_decision_287",
      requestId: "void_request_287",
      invoiceId: "inv_287",
      decision: "approved",
      decidedAt: 3000,
    }],
    branches,
    now: 5000,
  });

  assert.equal(audit.invoices.length, 0);
  assert.equal(audit.summary.invoiceCount, 0);
  assert.equal(audit.summary.invoiceValueCents, 0);
  assert.equal(audit.summary.voidedInvoiceCount, 1);
  assert.equal(audit.excludedVoidedInvoiceCount, 1);
});

test("allocations to voided invoices are flagged without inflating active invoice allocations", () => {
  const voided = invoice({ id: "inv_void", number: "RCP-CPT-000002", status: "voided", totalCents: 10000, paidCents: 0 });
  const linked = transaction({
    allocations: [{ id: "alloc_void", invoiceId: "inv_void", invoiceNumber: voided.number, amountCents: 10000, status: "active" }],
  });
  const audit = buildMpesaInvoiceAudit({ transactions: [linked], invoices: [voided], payments: [], branches, now: 5000 });

  assert.equal(audit.summary.invoiceCount, 0);
  assert.equal(audit.summary.invoiceAllocatedCents, 0);
  assert.equal(audit.summary.voidedInvoiceAllocationCents, 10000);
  assert.equal(audit.summary.reconciliationGapCents, 0);
  assert.equal(audit.transactions[0].activeAllocations.length, 0);
  assert.ok(audit.issues.some((entry) => entry.code === "allocation_to_voided_invoice"));
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

test("invoice summary reconciles total, paid, balance, and payment methods", () => {
  const businessDayInvoice = invoice({ status: "open", totalCents: 567000, paidCents: 539000 });
  const mpesa = transaction({ amountCents: 501000, allocatedCents: 501000, remainingCents: 0,
    allocations: [{ id: "alloc_1", invoiceId: "inv_1", invoiceNumber: businessDayInvoice.number, amountCents: 501000, status: "active" }] });
  const audit = buildMpesaInvoiceAudit({
    transactions: [mpesa],
    invoices: [businessDayInvoice],
    payments: [
      providerPayment({ amountCents: 501000 }),
      { id: "cash_1", invoiceId: "inv_1", method: "cash", status: "captured", amountCents: 38000 },
    ],
    branches,
    now: 5000,
  });

  assert.equal(audit.summary.invoiceCount, 1);
  assert.equal(audit.summary.invoiceValueCents, 567000);
  assert.equal(audit.summary.invoicePaidCents, 539000);
  assert.equal(audit.summary.invoiceBalanceCents, 28000);
  assert.equal(audit.summary.providerMpesaPaymentCents, 501000);
  assert.equal(audit.summary.cashPaymentCents, 38000);
  assert.equal(audit.summary.untracedPaidCents, 0);
  assert.match(audit.invoiceComment, /KES 5,670/);
  assert.match(audit.invoiceComment, /cash KES 380/i);
  assert.equal(audit.issues.length, 0);
});

test("selected-period M-Pesa is split between current invoices and older debt recovery", () => {
  const oldInvoice = invoice({ id: "inv_old", number: "RCP-CPT-000099", ts: 5000, totalCents: 6000, paidCents: 6000 });
  const currentInvoice = invoice({ id: "inv_current", number: "RCP-CPT-000100", ts: 15000, totalCents: 3000, paidCents: 3000 });
  const received = transaction({
    amountCents: 10000,
    allocatedCents: 9000,
    remainingCents: 1000,
    originationTime: new Date(16000).toISOString(),
    allocations: [
      { id: "alloc_old", invoiceId: oldInvoice.id, invoiceNumber: oldInvoice.number, amountCents: 6000, status: "active" },
      { id: "alloc_current", invoiceId: currentInvoice.id, invoiceNumber: currentInvoice.number, amountCents: 3000, status: "active" },
    ],
  });
  const audit = buildMpesaInvoiceAudit({
    transactions: [received],
    invoices: [currentInvoice],
    referenceInvoices: [oldInvoice, currentInvoice],
    payments: [],
    branches,
    auditPeriod: { startedAt: 10000, endedAt: 20000 },
    now: 21000,
    transactionScopeComplete: false,
  });

  assert.equal(audit.summary.selectedPeriodInvoiceAllocationCents, 3000);
  assert.equal(audit.summary.olderInvoiceRecoveryCents, 6000);
  assert.equal(audit.summary.otherPeriodInvoiceAllocationCents, 0);
  assert.equal(audit.summary.availableCents, 1000);
  assert.equal(audit.summary.recoveryTransactionCount, 1);
  assert.equal(audit.summary.reconciliationGapCents, 0);
  assert.match(audit.reconciliationComment, /recovered older invoice debt/i);
});

test("paid invoice without a captured payment record is flagged", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [invoice()],
    payments: [],
    branches,
    now: 5000,
  });

  assert.equal(audit.summary.untracedPaidCents, 10000);
  assert.ok(audit.issues.some((entry) => entry.code === "invoice_payment_total_mismatch"));
  assert.match(audit.invoiceComment, /no captured payment record/i);
});

test("audit messages display KES instead of internal cents", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [invoice({ number: "RCP-SIP-000262", totalCents: 50000, paidCents: 50000 })],
    payments: [providerPayment({ amountCents: 50000 })],
    branches,
    now: 5000,
  });
  const mismatch = audit.issues.find((entry) => entry.code === "provider_payment_allocation_mismatch");

  assert.ok(mismatch);
  assert.match(mismatch.message, /KES 500/);
  assert.doesNotMatch(mismatch.message, /\bcents\b/i);
});

test("carried-over invoice debts are exposed separately in the audit", () => {
  const audit = buildMpesaInvoiceAudit({
    transactions: [],
    invoices: [
      invoice({ id: "debt_1", status: "open", carriedOver: true, totalCents: 15000, paidCents: 5000 }),
      invoice({ id: "open_1", number: "RCP-CPT-000002", status: "open", totalCents: 7000, paidCents: 0 }),
      invoice({ id: "recovered_1", number: "RCP-CPT-000003", status: "paid", carriedOver: true, totalCents: 9000, paidCents: 9000 }),
    ],
    payments: [],
    branches,
    now: 5000,
  });

  assert.equal(audit.invoices.find((entry) => entry.id === "debt_1").debt, true);
  assert.equal(audit.invoices.find((entry) => entry.id === "open_1").debt, false);
  assert.equal(audit.invoices.find((entry) => entry.id === "recovered_1").debt, false);
  assert.equal(audit.summary.debtCount, 1);
  assert.equal(audit.summary.debtOutstandingCents, 10000);
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
