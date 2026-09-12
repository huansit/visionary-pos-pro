function asNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/**
 * Rebuild invoice lines from the immutable sale lines plus approved item voids.
 *
 * The original line remains in `_lineVoidAuditItems` for receipts and audits,
 * while `items` and `totalCents` describe the amount that is still a sale. This
 * same projection is deliberately used for live invoices and end-of-day
 * snapshots so reports cannot retain pre-void revenue or quantities.
 */
export function applyApprovedInvoiceLineVoids(data, invoices = data?.invoices || []) {
  const requests = new Map((data?.invoiceLineVoidRequests || []).map((entry) => [String(entry?.id || ""), entry]));
  const voidedByInvoice = new Map();

  (data?.invoiceLineVoidDecisions || []).forEach((decision) => {
    if (String(decision?.decision || "").toLowerCase() !== "approved") return;
    const request = requests.get(String(decision?.requestId || ""));
    const invoiceId = String(decision?.invoiceId || request?.invoiceId || "");
    const lineIndex = Number(decision?.lineIndex ?? request?.lineIndex);
    const qty = asNonNegativeNumber(decision?.qty ?? request?.qty);
    if (!invoiceId || !Number.isInteger(lineIndex) || lineIndex < 0 || qty <= 0) return;
    const byLine = voidedByInvoice.get(invoiceId) || new Map();
    byLine.set(lineIndex, (byLine.get(lineIndex) || 0) + qty);
    voidedByInvoice.set(invoiceId, byLine);
  });

  if (!voidedByInvoice.size) return invoices || [];
  return (invoices || []).map((invoice) => {
    const lineVoids = voidedByInvoice.get(String(invoice?.id || ""));
    if (!lineVoids) return invoice;
    const baseItems = Array.isArray(invoice?._lineVoidBaseItems)
      ? invoice._lineVoidBaseItems
      : (Array.isArray(invoice?.items) ? invoice.items : []);
    const baseTotalCents = Number.isFinite(Number(invoice?._lineVoidBaseTotalCents))
      ? Number(invoice._lineVoidBaseTotalCents)
      : asNonNegativeNumber(invoice?.totalCents);
    let voidedCents = 0;
    const auditItems = baseItems.map((item, index) => {
      const originalQty = asNonNegativeNumber(item?.qty ?? item?.quantity);
      const voidedQty = Math.min(originalQty, asNonNegativeNumber(lineVoids.get(index)));
      const remainingQty = Math.max(0, originalQty - voidedQty);
      const priceCents = asNonNegativeNumber(item?.priceCents ?? item?.unitPriceCents);
      voidedCents += Math.round(voidedQty * priceCents);
      return { ...item, qty: originalQty, remainingQty, voidedQty, voided: voidedQty > 0 };
    });
    const items = auditItems
      .map((item) => ({ ...item, qty: item.remainingQty }))
      .filter((item) => Number(item.qty || 0) > 0);

    return {
      ...invoice,
      _lineVoidBaseItems: baseItems,
      _lineVoidBaseTotalCents: baseTotalCents,
      _lineVoidAuditItems: auditItems,
      items,
      totalCents: Math.max(0, baseTotalCents - voidedCents),
      lineVoidCents: voidedCents,
      lineVoided: true,
    };
  });
}
