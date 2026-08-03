const normalizeText = (value) => String(value ?? "").trim();

export function normalizeMpesaCodeLast4(value) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-4);
}

export function mpesaReceiptLedger(payments, { branchId, codeLast4 } = {}) {
  const normalizedBranchId = normalizeText(branchId);
  const normalizedCode = normalizeMpesaCodeLast4(codeLast4);
  const groups = new Map();

  for (const payment of payments || []) {
    if (payment?.status && payment.status !== "captured") continue;
    if (!payment?.mpesaReceiptId || normalizeMpesaCodeLast4(payment.mpesaCodeLast4).length !== 4) continue;
    if (normalizedBranchId && normalizeText(payment.branchId) !== normalizedBranchId) continue;
    if (normalizedCode && normalizeMpesaCodeLast4(payment.mpesaCodeLast4) !== normalizedCode) continue;

    const receiptId = normalizeText(payment.mpesaReceiptId);
    const current = groups.get(receiptId) || {
      id: receiptId,
      branchId: normalizeText(payment.branchId),
      codeLast4: normalizeMpesaCodeLast4(payment.mpesaCodeLast4),
      totalCents: 0,
      allocatedCents: 0,
      registeredAt: Number(payment.mpesaReceiptRegisteredAt || payment.ts || 0),
      registeredByName: normalizeText(payment.mpesaReceiptRegisteredByName || payment.recordedByName),
      payerName: normalizeText(payment.mpesaPayerName),
      payerPhoneLast4: normalizeText(payment.mpesaPayerPhoneLast4),
      originationTime: normalizeText(payment.mpesaOriginationTime),
      providerVerified: Boolean(payment.providerVerified),
      kopokopoTransactionId: normalizeText(payment.kopokopoTransactionId),
      allocations: [],
    };
    current.totalCents = Math.max(current.totalCents, Math.max(0, Math.round(Number(payment.mpesaReceiptTotalCents) || 0)));
    current.allocatedCents += Math.max(0, Math.round(Number(payment.amountCents) || 0));
    current.registeredAt = Math.min(current.registeredAt || Infinity, Number(payment.mpesaReceiptRegisteredAt || payment.ts || 0)) || 0;
    current.payerName ||= normalizeText(payment.mpesaPayerName);
    current.payerPhoneLast4 ||= normalizeText(payment.mpesaPayerPhoneLast4);
    current.originationTime ||= normalizeText(payment.mpesaOriginationTime);
    current.providerVerified ||= Boolean(payment.providerVerified);
    current.kopokopoTransactionId ||= normalizeText(payment.kopokopoTransactionId);
    current.allocations.push(payment);
    groups.set(receiptId, current);
  }

  return [...groups.values()]
    .map((receipt) => ({
      ...receipt,
      remainingCents: Math.max(0, receipt.totalCents - receipt.allocatedCents),
    }))
    .sort((a, b) => b.registeredAt - a.registeredAt || b.id.localeCompare(a.id));
}

export function findMpesaReceipt(payments, { branchId, codeLast4 } = {}) {
  if (normalizeMpesaCodeLast4(codeLast4).length !== 4) return null;
  return mpesaReceiptLedger(payments, { branchId, codeLast4 })[0] || null;
}

export function receiptForSettlement({ verifiedReceipt, savedReceipt } = {}) {
  return verifiedReceipt || savedReceipt || null;
}

export function mpesaProviderSelectionError({ amountCents = 0, loading = false, transactions = [], selectedTransaction = null } = {}) {
  if (Number(amountCents) <= 0) return "";
  if (loading) return "Checking the M-Pesa transaction with Kopo Kopo...";
  if (transactions.length > 1 && !selectedTransaction) return "Select the matching Kopo Kopo transaction.";
  return "";
}

export function allocateInvoicePayments(invoices, { mpesaCents = 0, cashCents = 0 } = {}) {
  let mpesaRemaining = Math.max(0, Math.round(Number(mpesaCents) || 0));
  let cashRemaining = Math.max(0, Math.round(Number(cashCents) || 0));
  const allocations = [];

  for (const invoice of invoices || []) {
    const totalCents = Math.max(0, Math.round(Number(invoice?.totalCents) || 0));
    const previousPaidCents = Math.min(totalCents, Math.max(0, Math.round(Number(invoice?.paidCents) || 0)));
    let dueCents = totalCents - previousPaidCents;
    const mpesaAppliedCents = Math.min(dueCents, mpesaRemaining);
    mpesaRemaining -= mpesaAppliedCents;
    dueCents -= mpesaAppliedCents;
    const cashAppliedCents = Math.min(dueCents, cashRemaining);
    cashRemaining -= cashAppliedCents;
    dueCents -= cashAppliedCents;
    const appliedCents = mpesaAppliedCents + cashAppliedCents;
    if (appliedCents <= 0) continue;
    const paidCents = previousPaidCents + appliedCents;
    allocations.push({
      invoiceId: invoice.id,
      mpesaCents: mpesaAppliedCents,
      cashCents: cashAppliedCents,
      appliedCents,
      paidCents,
      outstandingCents: Math.max(0, totalCents - paidCents),
      cleared: paidCents >= totalCents,
    });
  }

  return { allocations, mpesaRemaining, cashRemaining };
}

export function mpesaReceiptPaymentFields(receipt) {
  const fields = {
    mpesaReceiptId: receipt.id,
    mpesaCodeLast4: receipt.codeLast4,
    mpesaReceiptTotalCents: receipt.totalCents,
    mpesaReceiptRegisteredAt: receipt.registeredAt,
    mpesaReceiptRegisteredByName: receipt.registeredByName,
  };
  if (receipt.providerVerified) fields.providerVerified = true;
  if (receipt.kopokopoTransactionId) fields.kopokopoTransactionId = receipt.kopokopoTransactionId;
  if (receipt.payerName) fields.mpesaPayerName = receipt.payerName;
  if (receipt.payerPhoneLast4) fields.mpesaPayerPhoneLast4 = receipt.payerPhoneLast4;
  if (receipt.originationTime) fields.mpesaOriginationTime = receipt.originationTime;
  return fields;
}
