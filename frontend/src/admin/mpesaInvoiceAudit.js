import { invoiceIsVoidedFromData } from "./invoiceVoidState.js";

const ACTIVE = "active";
const CAPTURED = "captured";

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function kes(value) {
  const amount = cents(value) / 100;
  return `KES ${amount.toLocaleString("en-KE", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function text(value) {
  return String(value || "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function activeEntry(entry) {
  return !entry?.status || lower(entry.status) === ACTIVE;
}

function capturedPayment(payment) {
  return !payment?.status || lower(payment.status) === CAPTURED;
}

function paymentInvoiceId(payment) {
  return text(payment?.invoiceId || payment?.orderId);
}

function transactionTimestamp(transaction) {
  const value = transaction?.originationTime || transaction?.createdAt || transaction?.ts;
  const timestamp = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function invoiceTimestamp(invoice) {
  const value = invoice?.ts || invoice?.issuedAt || invoice?.createdAt;
  const timestamp = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function transactionReference(transaction) {
  return text(transaction?.referenceMasked || transaction?.referenceLast4 || transaction?.id) || "Unknown M-Pesa transaction";
}

function invoiceReference(invoice) {
  return text(invoice?.number || invoice?.receiptNo || invoice?.id) || "Unknown invoice";
}

function issue({ code, severity = "warning", entityType, entityId, title, message }) {
  return { id: `${entityType}:${entityId}:${code}`, code, severity, entityType, entityId, title, message };
}

function issueRank(severity) {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

function isMpesa(payment) {
  const method = lower(payment?.method).replace(/[^a-z0-9]/g, "");
  return method === "mpesa";
}

function invoiceStatus(invoice) {
  return lower(invoice?.status || "open");
}

function isPaidStatus(invoice) {
  return ["paid", "cleared", "settled"].includes(invoiceStatus(invoice));
}

function isOpenStatus(invoice) {
  return ["open", "pending", "debt", "overdue", "partial", "partially_paid"].includes(invoiceStatus(invoice));
}

function isInvoiceDebt(invoice, balanceCents, voided = false) {
  if (balanceCents <= 0 || voided) return false;
  return invoice?.carriedOver === true
    || Number(invoice?.carriedOverAt || 0) > 0
    || Boolean(invoice?.closedDayId)
    || invoiceStatus(invoice) === "debt";
}

function uniqueById(entries) {
  const seen = new Set();
  return entries.filter((entry, index) => {
    const key = text(entry?.id) || `row:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildMpesaInvoiceAudit({
  transactions = [],
  invoices = [],
  referenceInvoices = invoices,
  payments = [],
  invoiceVoidRequests = [],
  invoiceVoidDecisions = [],
  branches = [],
  branchAuditStarts = null,
  auditPeriod = null,
  now = Date.now(),
  staleAfterMs = 24 * 60 * 60 * 1000,
  transactionScopeComplete = true,
} = {}) {
  const invoiceVoidData = {
    invoices: referenceInvoices,
    invoiceVoidRequests,
    invoiceVoidDecisions,
  };
  const isVoidedInvoice = (invoice) => invoiceIsVoidedFromData(invoiceVoidData, invoice);
  const branchById = new Map(branches.map((branch) => [text(branch.id), branch]));
  const auditStartByBranch = branchAuditStarts === null
    ? null
    : new Map(Object.entries(branchAuditStarts).map(([branchId, timestamp]) => [text(branchId), Number(timestamp) || 0]));
  const inAuditPeriod = (entry, timestamp) => {
    if (auditStartByBranch === null) return true;
    const start = auditStartByBranch.get(text(entry?.branchId)) || 0;
    return start > 0 && timestamp >= start;
  };
  const scopedTransactions = transactions.filter((transaction) => inAuditPeriod(transaction, transactionTimestamp(transaction)));
  const scopedInvoiceCandidates = invoices.filter((invoice) => inAuditPeriod(invoice, invoiceTimestamp(invoice)));
  const excludedVoidedInvoices = scopedInvoiceCandidates.filter(isVoidedInvoice);
  const scopedInvoices = scopedInvoiceCandidates.filter((invoice) => !isVoidedInvoice(invoice));
  const invoiceById = new Map([...referenceInvoices, ...invoices].map((invoice) => [text(invoice.id), invoice]));
  const auditPeriodStart = Math.max(0, Number(auditPeriod?.startedAt) || 0);
  const auditPeriodEnd = Math.max(0, Number(auditPeriod?.endedAt) || 0);
  const hasAuditPeriod = auditPeriodStart > 0 && auditPeriodEnd >= auditPeriodStart;
  const invoicePeriodCategory = (invoice) => {
    if (!hasAuditPeriod) return "selected_period";
    const timestamp = invoiceTimestamp(invoice);
    if (!timestamp) return "other_period";
    if (timestamp < auditPeriodStart) return "older_invoice";
    return timestamp <= auditPeriodEnd ? "selected_period" : "other_period";
  };
  const transactionById = new Map(scopedTransactions.map((transaction) => [text(transaction.id), transaction]));
  const issues = [];
  const allocationsByInvoiceId = new Map();
  const offsetsByInvoiceId = new Map();

  const transactionRows = scopedTransactions.map((transaction) => {
    const id = text(transaction.id);
    const reference = transactionReference(transaction);
    const amountCents = Math.max(0, cents(transaction.amountCents));
    const storedAllocatedCents = Math.max(0, cents(transaction.allocatedCents));
    const activeAllocations = uniqueById((transaction.allocations || []).filter(activeEntry)).map((allocation) => {
      const invoice = invoiceById.get(text(allocation.invoiceId));
      return {
        ...allocation,
        invoiceNumber: allocation.invoiceNumber || (invoice ? invoiceReference(invoice) : ""),
        invoiceTimestamp: invoice ? invoiceTimestamp(invoice) : 0,
        invoicePeriodCategory: invoice ? invoicePeriodCategory(invoice) : "other_period",
        invoiceVoided: Boolean(invoice && isVoidedInvoice(invoice)),
      };
    });
    const activeOffsets = uniqueById((transaction.offsets || []).filter(activeEntry));
    const auditableAllocations = activeAllocations.filter((entry) => !entry.invoiceVoided);
    const invoiceAllocatedCents = auditableAllocations.reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const voidedInvoiceAllocationCents = activeAllocations
      .filter((entry) => entry.invoiceVoided)
      .reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const selectedPeriodInvoiceAllocationCents = auditableAllocations
      .filter((entry) => entry.invoicePeriodCategory === "selected_period")
      .reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const olderInvoiceRecoveryCents = auditableAllocations
      .filter((entry) => entry.invoicePeriodCategory === "older_invoice")
      .reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const otherPeriodInvoiceAllocationCents = auditableAllocations
      .filter((entry) => entry.invoicePeriodCategory === "other_period")
      .reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const offsetCents = activeOffsets.reduce((sum, entry) => sum + Math.max(0, cents(entry.amountCents)), 0);
    const linkedConsumedCents = invoiceAllocatedCents + voidedInvoiceAllocationCents + offsetCents;
    const reversed = Boolean(transaction.reversedAt) || lower(transaction.status) === "reversed";
    const funding = lower(transaction.purpose) === "stock_funding";
    const allocatable = !reversed && !funding && transaction.allocatable !== false;
    const computedAvailableCents = allocatable ? Math.max(0, amountCents - storedAllocatedCents) : 0;
    const suppliedAvailable = Number(transaction.remainingCents);
    const rowIssues = [];
    const addIssue = (value) => { rowIssues.push(value); issues.push(value); };

    activeAllocations.forEach((allocation) => {
      const invoiceId = text(allocation.invoiceId);
      if (!allocationsByInvoiceId.has(invoiceId)) allocationsByInvoiceId.set(invoiceId, []);
      allocationsByInvoiceId.get(invoiceId).push({ ...allocation, transactionId: id, transactionReference: reference });
      const invoice = invoiceById.get(invoiceId);
      if (!invoice) {
        addIssue(issue({ code: "orphan_allocation", severity: "critical", entityType: "transaction", entityId: id, title: "Allocation has no invoice", message: `${reference} allocates money to a missing invoice record.` }));
      } else if (text(invoice.branchId) && text(transaction.branchId) && text(invoice.branchId) !== text(transaction.branchId) && !allocation.crossBranchAuthorized && !transaction.crossBranchAllowed) {
        addIssue(issue({ code: "allocation_without_cross_branch_whitelist", severity: "critical", entityType: "transaction", entityId: id, title: "Cross-branch allocation was not authorized", message: `${reference} is assigned to ${invoiceReference(invoice)} in a different branch without an active exact-transaction whitelist.` }));
      } else if (text(allocation.branchId) && text(invoice.branchId) && text(allocation.branchId) !== text(invoice.branchId)) {
        addIssue(issue({ code: "allocation_target_branch_mismatch", severity: "critical", entityType: "transaction", entityId: id, title: "Allocation ledger branch is incorrect", message: `${reference} is assigned to ${invoiceReference(invoice)}, but its allocation is recorded against a different branch.` }));
      } else if (isVoidedInvoice(invoice)) {
        addIssue(issue({ code: "allocation_to_voided_invoice", severity: "critical", entityType: "transaction", entityId: id, title: "Money allocated to voided invoice", message: `${reference} still has an active allocation to voided invoice ${invoiceReference(invoice)}.` }));
      }
    });

    activeOffsets.forEach((offset) => {
      const invoiceId = text(offset.invoiceId);
      if (!offsetsByInvoiceId.has(invoiceId)) offsetsByInvoiceId.set(invoiceId, []);
      offsetsByInvoiceId.get(invoiceId).push({ ...offset, transactionId: id, transactionReference: reference });
      const invoice = invoiceById.get(invoiceId);
      if (!invoice) {
        addIssue(issue({ code: "orphan_cash_offset", severity: "critical", entityType: "transaction", entityId: id, title: "Cash offset has no invoice", message: `${reference} offsets cash against a missing invoice record.` }));
      } else if (text(invoice.branchId) && text(transaction.branchId) && text(invoice.branchId) !== text(transaction.branchId)) {
        addIssue(issue({ code: "offset_branch_mismatch", severity: "critical", entityType: "transaction", entityId: id, title: "Cash offset branch mismatch", message: `${reference} offsets ${invoiceReference(invoice)} in a different branch.` }));
      } else if (isVoidedInvoice(invoice)) {
        addIssue(issue({ code: "offset_to_voided_invoice", severity: "critical", entityType: "transaction", entityId: id, title: "Cash offset linked to voided invoice", message: `${reference} still has an active cash offset against voided invoice ${invoiceReference(invoice)}.` }));
      }
    });

    if (allocatable && storedAllocatedCents !== linkedConsumedCents) {
      addIssue(issue({ code: "ledger_link_mismatch", severity: "critical", entityType: "transaction", entityId: id, title: "Used amount does not match its audit trail", message: `${reference} records ${kes(storedAllocatedCents)} as used, but active invoice allocations and cash offsets total ${kes(linkedConsumedCents)}.` }));
    }
    if (allocatable && (storedAllocatedCents > amountCents || linkedConsumedCents > amountCents)) {
      addIssue(issue({ code: "transaction_overallocated", severity: "critical", entityType: "transaction", entityId: id, title: "Transaction is over-allocated", message: `${reference} has more money consumed than the verified amount received.` }));
    }
    if (allocatable && Number.isFinite(suppliedAvailable) && Math.max(0, cents(suppliedAvailable)) !== computedAvailableCents) {
      addIssue(issue({ code: "available_balance_mismatch", severity: "warning", entityType: "transaction", entityId: id, title: "Available balance is inconsistent", message: `${reference} reports a different available balance from amount received minus amount used.` }));
    }

    const timestamp = transactionTimestamp(transaction);
    const staleAvailable = allocatable && computedAvailableCents > 0 && timestamp > 0 && now - timestamp >= staleAfterMs;
    if (staleAvailable) {
      addIssue(issue({ code: "stale_available_money", severity: "warning", entityType: "transaction", entityId: id, title: "Available money needs review", message: `${reference} has remained available for more than ${Math.max(1, Math.round(staleAfterMs / 3600000))} hours.` }));
    }

    let comment;
    if (reversed) comment = "Reversed by the provider. No money is available for invoice settlement.";
    else if (funding) comment = "Classified as stock funding. It is excluded from customer-payment totals and invoice settlement.";
    else if (computedAvailableCents > 0) comment = staleAvailable
      ? "Verified money remains unused and is older than the audit threshold. Confirm whether it should settle an invoice, offset deposited cash, or be classified as stock funding."
      : "Verified money remains available. It can settle invoices or offset cash receipts deposited to the till.";
    else if (voidedInvoiceAllocationCents > 0) comment = "Money is still linked to a voided invoice and requires correction.";
    else if (offsetCents > 0 && invoiceAllocatedCents > 0) comment = "Fully accounted for through invoice allocations and cash-deposit offsets.";
    else if (offsetCents > 0) comment = "Fully accounted for as cash deposited to the till. The linked invoices remain cash invoices.";
    else comment = "Fully accounted for through invoice allocation.";
    if (hasAuditPeriod && invoiceAllocatedCents > 0) {
      const periodParts = [
        selectedPeriodInvoiceAllocationCents > 0 ? `${kes(selectedPeriodInvoiceAllocationCents)} settled invoices issued in this audit period` : "",
        olderInvoiceRecoveryCents > 0 ? `${kes(olderInvoiceRecoveryCents)} recovered older invoice debt` : "",
        otherPeriodInvoiceAllocationCents > 0 ? `${kes(otherPeriodInvoiceAllocationCents)} settled invoices outside this audit period` : "",
      ].filter(Boolean);
      comment = `${comment} ${periodParts.join("; ")}.`;
    }

    return {
      ...transaction,
      id,
      reference,
      amountCents,
      storedAllocatedCents,
      invoiceAllocatedCents,
      voidedInvoiceAllocationCents,
      selectedPeriodInvoiceAllocationCents,
      olderInvoiceRecoveryCents,
      otherPeriodInvoiceAllocationCents,
      offsetCents,
      linkedConsumedCents,
      availableCents: computedAvailableCents,
      reversed,
      funding,
      allocatable,
      timestamp,
      branchName: branchById.get(text(transaction.branchId))?.name || text(transaction.branchId) || "Unknown branch",
      activeAllocations: auditableAllocations,
      activeOffsets,
      issues: rowIssues,
      comment,
    };
  });

  const paymentsByInvoiceId = new Map();
  payments.filter(capturedPayment).forEach((payment) => {
    const invoiceId = paymentInvoiceId(payment);
    if (!invoiceId) return;
    if (!paymentsByInvoiceId.has(invoiceId)) paymentsByInvoiceId.set(invoiceId, []);
    paymentsByInvoiceId.get(invoiceId).push(payment);
  });

  const invoiceRows = scopedInvoices.map((invoice) => {
    const id = text(invoice.id);
    const reference = invoiceReference(invoice);
    const totalCents = Math.max(0, cents(invoice.totalCents));
    const storedPaidCents = Math.max(0, cents(invoice.paidCents));
    const balanceCents = Math.max(0, totalCents - storedPaidCents);
    const invoicePayments = paymentsByInvoiceId.get(id) || [];
    const capturedPaymentCents = invoicePayments.reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const mpesaPayments = invoicePayments.filter(isMpesa);
    const providerMpesaPayments = mpesaPayments.filter((payment) => payment.providerVerified || payment.kopokopoTransactionId || payment.kopokopoAllocationId);
    const manualMpesaPayments = mpesaPayments.filter((payment) => !providerMpesaPayments.includes(payment));
    const mpesaCents = mpesaPayments.reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const providerMpesaCents = providerMpesaPayments.reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const manualMpesaCents = manualMpesaPayments.reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const cashCents = invoicePayments.filter((payment) => lower(payment.method) === "cash").reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const payrollCents = invoicePayments.filter((payment) => lower(payment.method) === "payroll").reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const otherCents = invoicePayments.filter((payment) => !isMpesa(payment) && !["cash", "payroll"].includes(lower(payment.method)))
      .reduce((sum, payment) => sum + Math.max(0, cents(payment.amountCents)), 0);
    const activeAllocations = allocationsByInvoiceId.get(id) || [];
    const activeOffsets = offsetsByInvoiceId.get(id) || [];
    const allocationCents = activeAllocations.reduce((sum, allocation) => sum + Math.max(0, cents(allocation.amountCents)), 0);
    const offsetCents = activeOffsets.reduce((sum, offset) => sum + Math.max(0, cents(offset.amountCents)), 0);
    const rowIssues = [];
    const addIssue = (value) => { rowIssues.push(value); issues.push(value); };
    const voided = isVoidedInvoice(invoice);
    const debt = isInvoiceDebt(invoice, balanceCents, voided);

    if (!voided && capturedPaymentCents !== storedPaidCents) {
      addIssue(issue({ code: "invoice_payment_total_mismatch", severity: "critical", entityType: "invoice", entityId: id, title: "Invoice paid total does not match payments", message: `${reference} records ${kes(storedPaidCents)} as paid, but its captured payment records total ${kes(capturedPaymentCents)}.` }));
    }
    if (!voided && storedPaidCents > totalCents) {
      addIssue(issue({ code: "invoice_overpaid", severity: "critical", entityType: "invoice", entityId: id, title: "Invoice is overpaid", message: `${reference} has more paid than its invoice total.` }));
    }
    if (!voided && isPaidStatus(invoice) && balanceCents > 0) {
      addIssue(issue({ code: "paid_invoice_has_balance", severity: "critical", entityType: "invoice", entityId: id, title: "Paid invoice still has a balance", message: `${reference} is marked paid but still has an outstanding balance.` }));
    }
    if (!voided && isOpenStatus(invoice) && totalCents > 0 && balanceCents === 0) {
      addIssue(issue({ code: "settled_invoice_still_open", severity: "warning", entityType: "invoice", entityId: id, title: "Settled invoice is still open", message: `${reference} has no balance but its status is still ${invoiceStatus(invoice)}.` }));
    }
    if (voided && allocationCents > 0) {
      addIssue(issue({ code: "voided_invoice_has_allocation", severity: "critical", entityType: "invoice", entityId: id, title: "Voided invoice has active M-Pesa money", message: `${reference} is voided but still has active provider allocations.` }));
    }
    if (providerMpesaPayments.length > 0 && providerMpesaCents !== allocationCents) {
      addIssue(issue({ code: "provider_payment_allocation_mismatch", severity: "critical", entityType: "invoice", entityId: id, title: "M-Pesa payment is not fully traceable", message: `${reference} has ${kes(providerMpesaCents)} in verified M-Pesa payments but ${kes(allocationCents)} in active provider allocations.` }));
    }
    if (allocationCents > totalCents && totalCents > 0) {
      addIssue(issue({ code: "invoice_allocation_exceeds_total", severity: "critical", entityType: "invoice", entityId: id, title: "M-Pesa allocations exceed invoice total", message: `${reference} has more active M-Pesa allocation than its total value.` }));
    }
    providerMpesaPayments.forEach((payment) => {
      const transactionId = text(payment.kopokopoTransactionId);
      if (transactionScopeComplete && transactionId && !transactionById.has(transactionId)) {
        addIssue(issue({ code: `missing_provider_transaction_${text(payment.id)}`, severity: "warning", entityType: "invoice", entityId: id, title: "Verified payment has no ledger transaction", message: `${reference} contains a provider-verified payment whose M-Pesa transaction is outside or missing from this audit scope.` }));
      }
    });

    let comment;
    if (voided) comment = allocationCents > 0 ? "Voided invoice requires immediate allocation review." : "Voided invoice; excluded from active sales settlement.";
    else if (debt) comment = `Carried-over invoice debt remains outstanding. ${allocationCents > 0 ? "Verified M-Pesa allocation is shown in the trace." : "No active verified M-Pesa allocation is attached."}`;
    else if (balanceCents > 0) comment = `Outstanding balance remains. ${allocationCents > 0 ? "Verified M-Pesa allocation is shown in the trace." : "No active verified M-Pesa allocation is attached."}`;
    else if (offsetCents > 0 && cashCents > 0) comment = "Invoice is paid as cash. A later till deposit is linked separately for audit and does not change the payment method.";
    else comment = "Invoice payment total is fully settled and traceable in the captured payment records.";

    return {
      ...invoice,
      id,
      reference,
      totalCents,
      storedPaidCents,
      balanceCents,
      capturedPaymentCents,
      mpesaCents,
      providerMpesaCents,
      manualMpesaCents,
      cashCents,
      payrollCents,
      otherCents,
      allocationCents,
      offsetCents,
      invoicePayments,
      activeAllocations,
      activeOffsets,
      voided,
      debt,
      timestamp: invoiceTimestamp(invoice),
      branchName: branchById.get(text(invoice.branchId))?.name || text(invoice.branchId) || "Unknown branch",
      issues: rowIssues,
      comment,
    };
  });

  const customerTransactions = transactionRows.filter((transaction) => transaction.allocatable);
  const availableRows = customerTransactions.filter((transaction) => transaction.availableCents > 0);
  const staleAvailableRows = availableRows.filter((transaction) => transaction.issues.some((entry) => entry.code === "stale_available_money"));
  const activeInvoiceRows = invoiceRows.filter((invoice) => !invoice.voided);
  const summary = {
    transactionCount: customerTransactions.length,
    invoiceCount: activeInvoiceRows.length,
    voidedInvoiceCount: excludedVoidedInvoices.length,
    receivedCents: customerTransactions.reduce((sum, transaction) => sum + transaction.amountCents, 0),
    invoiceAllocatedCents: customerTransactions.reduce((sum, transaction) => sum + transaction.invoiceAllocatedCents, 0),
    voidedInvoiceAllocationCents: customerTransactions.reduce((sum, transaction) => sum + transaction.voidedInvoiceAllocationCents, 0),
    selectedPeriodInvoiceAllocationCents: customerTransactions.reduce((sum, transaction) => sum + transaction.selectedPeriodInvoiceAllocationCents, 0),
    olderInvoiceRecoveryCents: customerTransactions.reduce((sum, transaction) => sum + transaction.olderInvoiceRecoveryCents, 0),
    otherPeriodInvoiceAllocationCents: customerTransactions.reduce((sum, transaction) => sum + transaction.otherPeriodInvoiceAllocationCents, 0),
    recoveryTransactionCount: customerTransactions.filter((transaction) => transaction.olderInvoiceRecoveryCents > 0).length,
    offsetCents: customerTransactions.reduce((sum, transaction) => sum + transaction.offsetCents, 0),
    availableCents: customerTransactions.reduce((sum, transaction) => sum + transaction.availableCents, 0),
    invoiceValueCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.totalCents, 0),
    invoicePaidCents: activeInvoiceRows.reduce((sum, invoice) => sum + Math.min(invoice.totalCents, invoice.storedPaidCents), 0),
    invoiceBalanceCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    capturedInvoicePaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.capturedPaymentCents, 0),
    providerMpesaPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.providerMpesaCents, 0),
    manualMpesaPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.manualMpesaCents, 0),
    cashPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.cashCents, 0),
    payrollPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.payrollCents, 0),
    otherPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + invoice.otherCents, 0),
    untracedPaidCents: activeInvoiceRows.reduce((sum, invoice) => sum + Math.max(0, Math.min(invoice.totalCents, invoice.storedPaidCents) - invoice.capturedPaymentCents), 0),
    excessCapturedPaymentCents: activeInvoiceRows.reduce((sum, invoice) => sum + Math.max(0, invoice.capturedPaymentCents - invoice.storedPaidCents), 0),
    debtCount: invoiceRows.filter((invoice) => invoice.debt).length,
    debtOutstandingCents: invoiceRows.filter((invoice) => invoice.debt).reduce((sum, invoice) => sum + invoice.balanceCents, 0),
    criticalCount: issues.filter((entry) => entry.severity === "critical").length,
    warningCount: issues.filter((entry) => entry.severity === "warning").length,
    infoCount: issues.filter((entry) => entry.severity === "info").length,
    flaggedCount: issues.length,
    staleAvailableCents: staleAvailableRows.reduce((sum, transaction) => sum + transaction.availableCents, 0),
  };
  summary.reconciliationGapCents = summary.receivedCents
    - summary.selectedPeriodInvoiceAllocationCents
    - summary.olderInvoiceRecoveryCents
    - summary.otherPeriodInvoiceAllocationCents
    - summary.voidedInvoiceAllocationCents
    - summary.offsetCents
    - summary.availableCents;

  const availableComment = summary.availableCents <= 0
    ? "All verified customer M-Pesa money in this audit scope is accounted for by active invoice allocations or cash-deposit offsets."
    : `Verified money remains available across ${availableRows.length} transaction${availableRows.length === 1 ? "" : "s"}. Available money has not yet settled an invoice or offset a cash receipt.${summary.staleAvailableCents > 0 ? " Some of it is older than the audit threshold and needs review." : ""}`;

  const invoicePaymentParts = [
    summary.providerMpesaPaymentCents > 0 ? `verified M-Pesa ${kes(summary.providerMpesaPaymentCents)}` : "",
    summary.manualMpesaPaymentCents > 0 ? `manual M-Pesa ${kes(summary.manualMpesaPaymentCents)}` : "",
    summary.cashPaymentCents > 0 ? `cash ${kes(summary.cashPaymentCents)}` : "",
    summary.payrollPaymentCents > 0 ? `payroll ${kes(summary.payrollPaymentCents)}` : "",
    summary.otherPaymentCents > 0 ? `other ${kes(summary.otherPaymentCents)}` : "",
  ].filter(Boolean);
  const traceWarning = summary.untracedPaidCents > 0
    ? ` ${kes(summary.untracedPaidCents)} of the paid amount has no captured payment record and is flagged.`
    : summary.excessCapturedPaymentCents > 0
      ? ` Captured payment records exceed invoice paid totals by ${kes(summary.excessCapturedPaymentCents)} and are flagged.`
      : " All paid amounts are backed by captured payment records.";
  const invoiceComment = `${summary.invoiceCount} active invoice${summary.invoiceCount === 1 ? "" : "s"} total ${kes(summary.invoiceValueCents)}: ${kes(summary.invoicePaidCents)} paid plus ${kes(summary.invoiceBalanceCents)} outstanding.${invoicePaymentParts.length ? ` Captured payment methods: ${invoicePaymentParts.join(", ")}.` : " No captured payments are recorded."}${traceWarning}`;
  const reconciliationParts = [
    `${kes(summary.selectedPeriodInvoiceAllocationCents)} settled invoices issued in the selected period`,
    `${kes(summary.olderInvoiceRecoveryCents)} recovered older invoice debt`,
    summary.otherPeriodInvoiceAllocationCents > 0 ? `${kes(summary.otherPeriodInvoiceAllocationCents)} settled invoices outside the selected period` : "",
    summary.voidedInvoiceAllocationCents > 0 ? `${kes(summary.voidedInvoiceAllocationCents)} is still linked to voided invoices and flagged` : "",
    `${kes(summary.offsetCents)} offset cash deposited to till`,
    `${kes(summary.availableCents)} remains available`,
  ].filter(Boolean);
  const reconciliationComment = `${kes(summary.receivedCents)} received: ${reconciliationParts.join("; ")}.${summary.reconciliationGapCents !== 0 ? ` ${kes(summary.reconciliationGapCents)} does not reconcile and requires review.` : " The funds-use equation balances."}`;

  return {
    transactions: transactionRows.sort((left, right) => right.timestamp - left.timestamp),
    invoices: invoiceRows.sort((left, right) => right.timestamp - left.timestamp),
    issues: issues.sort((left, right) => issueRank(left.severity) - issueRank(right.severity) || left.title.localeCompare(right.title)),
    summary,
    availableComment,
    invoiceComment,
    reconciliationComment,
    auditStartByBranch: auditStartByBranch === null ? null : Object.fromEntries(auditStartByBranch),
    excludedTransactionCount: transactions.length - scopedTransactions.length,
    excludedInvoiceCount: invoices.length - scopedInvoices.length,
    excludedVoidedInvoiceCount: excludedVoidedInvoices.length,
  };
}
