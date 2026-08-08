const text = (value) => String(value ?? "").trim();

const invoiceIdForPayment = (payment) => text(payment?.invoiceId || payment?.orderId);

export function invoiceWasEverCarriedOver(data, invoice) {
  const invoiceId = text(invoice?.id);
  if (!invoiceId) return false;
  if (invoice?.carriedOver === true || Number(invoice?.carriedOverAt || 0) > 0) return true;

  return (data?.endOfDays || []).some((entry) =>
    (entry?.carriedOverInvoiceIds || []).some((id) => text(id) === invoiceId)
  );
}

export function invoiceRecoveryTimestamp(data, invoice) {
  const invoiceId = text(invoice?.id);
  if (!invoiceId) return 0;

  const paymentTimestamp = (data?.payments || []).reduce((latest, payment) => {
    if (invoiceIdForPayment(payment) !== invoiceId) return latest;
    if (String(payment?.status || "captured").toLowerCase() !== "captured") return latest;
    const timestamp = Number(payment?.ts || payment?.createdAt || payment?.updatedAt || payment?.serverTs || 0);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);

  return Math.max(
    paymentTimestamp,
    Number(invoice?.settledAt || 0),
    Number(invoice?.lastSettledAt || 0)
  );
}
