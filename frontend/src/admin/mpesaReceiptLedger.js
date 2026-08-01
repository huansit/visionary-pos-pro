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
      allocations: [],
    };
    current.totalCents = Math.max(current.totalCents, Math.max(0, Math.round(Number(payment.mpesaReceiptTotalCents) || 0)));
    current.allocatedCents += Math.max(0, Math.round(Number(payment.amountCents) || 0));
    current.registeredAt = Math.min(current.registeredAt || Infinity, Number(payment.mpesaReceiptRegisteredAt || payment.ts || 0)) || 0;
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
  return {
    mpesaReceiptId: receipt.id,
    mpesaCodeLast4: receipt.codeLast4,
    mpesaReceiptTotalCents: receipt.totalCents,
    mpesaReceiptRegisteredAt: receipt.registeredAt,
    mpesaReceiptRegisteredByName: receipt.registeredByName,
  };
}
