import { isMySql, tx } from "../src/db.js";

const apply = process.argv.includes("--apply");
const invoiceId = String(process.argv.find((argument) => argument.startsWith("--invoice=")) || "").slice("--invoice=".length).trim();
const codeLast4 = String(process.argv.find((argument) => argument.startsWith("--code=")) || "").slice("--code=".length).trim().toUpperCase();
const reason = String(process.argv.find((argument) => argument.startsWith("--reason=")) || "").slice("--reason=".length).trim();

function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}

function paymentCents(payment) {
  const cents = Number(payment?.amountCents);
  if (Number.isFinite(cents)) return Math.max(0, Math.round(cents));
  const amount = Number(payment?.amount);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
}

function providerMpesa(payment) {
  const method = String(payment?.method || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return method === "mpesa" && Boolean(payment?.providerVerified || payment?.kopokopoTransactionId || payment?.kopokopoAllocationId);
}

async function loadRepairContext(client) {
  const events = await client.query(
    "SELECT id, type, branch_id, payload FROM events WHERE type IN ('invoice', 'invoiceVoidDecision', 'payment', 'paymentRelease')"
  );
  const rows = events.rows.map((row) => ({ ...row, payload: payloadOf(row) }));
  // Admin screens show the human receipt number, while allocations use the
  // immutable internal invoice event id. Accept either without guessing.
  const invoice = rows.find((row) => {
    if (row.type !== "invoice") return false;
    const payload = row.payload || {};
    return [row.id, payload.id, payload.number, payload.invoiceNumber, payload.receiptNumber]
      .some((value) => String(value || "").trim().toUpperCase() === invoiceId.toUpperCase());
  });
  const resolvedInvoiceId = String(invoice?.id || invoiceId).trim();
  const releasedPaymentIds = new Set(rows.filter((row) => row.type === "paymentRelease")
    .map((row) => String(row.payload?.paymentId || "").trim()).filter(Boolean));
  const payments = rows.filter((row) => row.type === "payment")
    .map((row) => ({ id: String(row.payload?.id || row.id || "").trim(), payload: row.payload || {} }))
    .filter((payment) => (payment.payload.invoiceId === resolvedInvoiceId || payment.payload.orderId === resolvedInvoiceId)
      && String(payment.payload.status || "captured").toLowerCase() === "captured"
      && !releasedPaymentIds.has(payment.id));
  const paymentIds = payments.map((payment) => payment.id).filter(Boolean);
  const allocationIds = payments
    .map((payment) => String(payment.payload?.kopokopoAllocationId || "").trim())
    .filter(Boolean);
  const paymentPlaceholders = paymentIds.map((_, index) => `$${index + 3}`).join(", ");
  const allocationIdPlaceholders = allocationIds
    .map((_, index) => `$${index + 3 + paymentIds.length}`).join(", ");
  const allocationScope = [
    "a.invoice_id = $1",
    paymentPlaceholders && `a.local_payment_id IN (${paymentPlaceholders})`,
    allocationIdPlaceholders && `a.id IN (${allocationIdPlaceholders})`,
  ].filter(Boolean).join(" OR ");
  const providerTransactionIds = payments
    .map((payment) => String(payment.payload?.kopokopoTransactionId || "").trim())
    .filter(Boolean);
  const transactionIdPlaceholders = providerTransactionIds
    .map((_, index) => `$${index + 2}`).join(", ");
  const transactionScope = [
    "UPPER(reference_last4) = $1",
    "RIGHT(UPPER(reference), 4) = $1",
    transactionIdPlaceholders && `id IN (${transactionIdPlaceholders})`,
  ].filter(Boolean).join(" OR ");
  const transactionRows = await client.query(
    `SELECT id, reference_last4, amount_cents, allocated_cents, status, branch_id
       FROM kopokopo_transactions
      WHERE ${transactionScope}`,
    [codeLast4, ...providerTransactionIds]
  );
  const allocations = await client.query(
    `SELECT a.id, a.transaction_id, a.invoice_id, a.branch_id, a.amount_cents, a.local_payment_id, a.status,
            t.reference_last4, t.amount_cents AS transaction_amount_cents, t.allocated_cents AS transaction_allocated_cents
       FROM kopokopo_allocations a
       JOIN kopokopo_transactions t ON t.id = a.transaction_id
      WHERE (${allocationScope})
        AND (UPPER(t.reference_last4) = $2 OR RIGHT(UPPER(t.reference), 4) = $2)`,
    [resolvedInvoiceId, codeLast4, ...paymentIds, ...allocationIds]
  );
  const voided = Boolean(invoice && (
    ["void", "voided", "cancelled", "canceled"].includes(String(invoice.payload?.status || "").toLowerCase())
    || rows.some((row) => row.type === "invoiceVoidDecision"
      && String(row.payload?.invoiceId || "") === resolvedInvoiceId
      && String(row.payload?.decision || "").toLowerCase() === "approved")
  ));
  const activeAllocations = allocations.rows.filter((row) => String(row.status || "active").toLowerCase() === "active");
  const byPaymentId = new Map();
  for (const allocation of activeAllocations) {
    const key = String(allocation.local_payment_id || "").trim();
    const list = byPaymentId.get(key) || [];
    list.push(allocation);
    byPaymentId.set(key, list);
  }
  const releasesMatchPayments = payments.length > 0 && payments.every((payment) => {
    const allocationId = String(payment.payload?.kopokopoAllocationId || "").trim();
    const linked = [
      ...(byPaymentId.get(payment.id) || []),
      ...activeAllocations.filter((allocation) => allocation.id === allocationId),
    ].filter((allocation, index, values) => values.findIndex((entry) => entry.id === allocation.id) === index);
    return providerMpesa(payment.payload)
      && linked.length > 0
      && linked.reduce((total, allocation) => total + Number(allocation.amount_cents || 0), 0) === paymentCents(payment.payload);
  });
  return {
    invoice,
    resolvedInvoiceId,
    voided,
    payments,
    transactions: transactionRows.rows,
    allocations: allocations.rows,
    activeAllocations,
    releasesMatchPayments,
  };
}

async function main() {
  if (!invoiceId || !codeLast4 || reason.length < 3) {
    throw new Error("Usage: --invoice=<invoice id> --code=<last 4> --reason=<reason> [--apply]");
  }
  const preview = await tx(async (client) => loadRepairContext(client));
  const report = {
    invoiceId,
    resolvedInvoiceId: preview.resolvedInvoiceId,
    codeLast4,
    voided: preview.voided,
    payments: preview.payments.map((payment) => ({
      id: payment.id,
      amountCents: paymentCents(payment.payload),
      method: payment.payload.method,
      providerTransactionId: payment.payload?.kopokopoTransactionId || null,
      providerAllocationId: payment.payload?.kopokopoAllocationId || null,
    })),
    transactions: preview.transactions.map((transaction) => ({
      id: transaction.id,
      codeLast4: transaction.reference_last4,
      amountCents: Number(transaction.amount_cents || 0),
      allocatedCents: Number(transaction.allocated_cents || 0),
      status: transaction.status,
      branchId: transaction.branch_id,
    })),
    allocations: preview.allocations.map((allocation) => ({
      id: allocation.id,
      invoiceId: allocation.invoice_id,
      paymentId: allocation.local_payment_id,
      status: allocation.status,
      amountCents: Number(allocation.amount_cents || 0),
      transactionId: allocation.transaction_id,
    })),
    activeAllocations: preview.activeAllocations.map((allocation) => ({ id: allocation.id, transactionId: allocation.transaction_id, amountCents: Number(allocation.amount_cents || 0), branchId: allocation.branch_id })),
    eligible: preview.voided && preview.releasesMatchPayments,
  };
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", ...report }, null, 2));
    console.log("Dry run only. Re-run with --apply to release the verified M-Pesa code once.");
    return;
  }
  if (!report.eligible) {
    throw new Error("The invoice is not a voided, fully matched provider M-Pesa allocation. No money was changed.");
  }

  const result = await tx(async (client) => {
    const current = await loadRepairContext(client);
    if (!current.voided || !current.releasesMatchPayments) {
      throw new Error("The allocation changed before repair. No money was changed.");
    }
    const paymentById = new Map(current.payments.map((payment) => [payment.id, payment]));
    const byTransactionId = new Map();
    for (const allocation of current.activeAllocations) {
      const list = byTransactionId.get(allocation.transaction_id) || [];
      list.push(allocation);
      byTransactionId.set(allocation.transaction_id, list);
    }
    let releaseTs = Date.now();
    for (const [transactionId, allocations] of byTransactionId) {
      const amountCents = allocations.reduce((total, allocation) => total + Number(allocation.amount_cents || 0), 0);
      await client.query("SELECT id FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      await client.query(
        `UPDATE kopokopo_transactions
            SET allocated_cents = GREATEST(0, allocated_cents - $2), updated_at = ${isMySql ? "NOW()" : "now()"}
          WHERE id = $1`,
        [transactionId, amountCents]
      );
    }
    for (const allocation of current.activeAllocations) {
      releaseTs += 1;
      await client.query("UPDATE kopokopo_allocations SET status = 'released' WHERE id = $1 AND lower(status) = 'active'", [allocation.id]);
      const payment = paymentById.get(String(allocation.local_payment_id || ""));
      await client.query(
        `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, 'paymentRelease', $2, $3, $4, $5, $6)`,
        // This is a server-side repair, not an action from a registered
        // terminal. `events.device_id` is a foreign key, so recording a
        // made-up repair device makes the whole transaction fail. Keep it
        // null and preserve the repair provenance in the immutable payload.
        [`payment-release:${allocation.id}`, allocation.branch_id, null, releaseTs, releaseTs, {
          paymentId: payment?.id || String(allocation.local_payment_id || ""),
          invoiceId: current.resolvedInvoiceId,
          branchId: allocation.branch_id,
          transactionId: allocation.transaction_id,
          allocationId: allocation.id,
          amountCents: Number(allocation.amount_cents || 0),
          reason,
          releaseSource: "server_repair",
          releasedBy: "voided-mpesa-allocation-repair",
          releasedByName: "M-Pesa void correction",
          releasedAt: releaseTs,
        }]
      );
    }
    return { releasedAllocations: current.activeAllocations.length, releasedCents: current.activeAllocations.reduce((total, allocation) => total + Number(allocation.amount_cents || 0), 0) };
  });
  console.log(JSON.stringify({ mode: "applied", ...report, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
