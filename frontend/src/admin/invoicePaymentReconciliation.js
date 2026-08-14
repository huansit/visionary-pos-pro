const OPEN_INVOICE_STATUSES = new Set([
  "",
  "open",
  "pending",
  "debt",
  "overdue",
  "partial",
  "partially_paid",
]);

const VOID_INVOICE_STATUSES = new Set([
  "void",
  "voided",
  "cancelled",
  "canceled",
  "rejected",
]);

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function statusValue(value) {
  return String(value || "").trim().toLowerCase();
}

export function reconcileInvoicePaymentState(invoice, capturedPaymentCents, { voided = false } = {}) {
  const totalCents = cents(invoice?.totalCents);
  const paidCents = Math.min(
    totalCents,
    Math.max(cents(invoice?.paidCents), cents(capturedPaymentCents)),
  );
  const currentStatus = statusValue(invoice?.status);
  const fullyPaid = totalCents > 0 && paidCents >= totalCents;
  const canRepairStatus = !voided
    && !VOID_INVOICE_STATUSES.has(currentStatus)
    && OPEN_INVOICE_STATUSES.has(currentStatus);

  return {
    ...invoice,
    paidCents,
    status: fullyPaid && canRepairStatus ? "paid" : invoice?.status,
  };
}
