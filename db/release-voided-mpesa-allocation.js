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
  const [events, allocations] = await Promise.all([
    client.query("SELECT id, type, branch_id, payload FROM events WHERE type IN ('invoice', 'invoiceVoidDecision', 'payment', 'paymentRelease')"),
    client.query(
      `SELECT a.id, a.transaction_id, a.invoice_id, a.branch_id, a.amount_cents, a.local_payment_id, a.status,
              t.reference_last4, t.amount_cents AS transaction_amount_cents, t.allocated_cents AS transaction_allocated_cents
         FROM kopokopo_allocations a
         JOIN kopokopo_transactions t ON t.id = a.transaction_id
        WHERE a.invoice_id = $1
          AND UPPER(t.reference_last4) = $2`,
      [invoiceId, codeLast4]
    ),
  ]);
  const rows = events.rows.map((row) => ({ ...row, payload: payloadOf(row) }));
  const invoice = rows.find((row) => row.type === "invoice" && row.id === invoiceId);
  const voided = Boolean(invoice && (
    ["void", "voided", "cancelled", "canceled"].includes(String(invoice.payload?.status || "").toLowerCase())
    || rows.some((row) => row.type === "invoiceVoidDecision"
      && String(row.payload?.invoiceId || "") === invoiceId
      && String(row.payload?.decision || "").toLowerCase() === "approved")
  ));
  const releasedPaymentIds = new Set(rows.filter((row) => row.type === "paymentRelease")
    .map((row) => String(row.payload?.paymentId || "").trim()).filter(Boolean));
  const payments = rows.filter((row) => row.type === "payment")
    .map((row) => ({ id: String(row.payload?.id || row.id || "").trim(), payload: row.payload || {} }))
    .filter((payment) => (payment.payload.invoiceId === invoiceId || payment.payload.orderId === invoiceId)
      && String(payment.payload.status || "captured").toLowerCase() === "captured"
      && !releasedPaymentIds.has(payment.id));
  const activeAllocations = allocations.rows.filter((row) => String(row.status || "active").toLowerCase() === "active");
  const byPaymentId = new Map();
  for (const allocation of activeAllocations) {
    const key = String(allocation.local_payment_id || "").trim();
    const list = byPaymentId.get(key) || [];
    list.push(allocation);
    byPaymentId.set(key, list);
  }
  const releasesMatchPayments = payments.length > 0 && payments.every((payment) => {
    const linked = byPaymentId.get(payment.id) || [];
    return providerMpesa(payment.payload)
      && linked.length > 0
      && linked.reduce((total, allocation) => total + Number(allocation.amount_cents || 0), 0) === paymentCents(payment.payload);
  });
  return { invoice, voided, payments, activeAllocations, releasesMatchPayments };
}

async function main() {
  if (!invoiceId || !codeLast4 || reason.length < 3) {
    throw new Error("Usage: --invoice=<invoice id> --code=<last 4> --reason=<reason> [--apply]");
  }
  const preview = await tx(async (client) => loadRepairContext(client));
  const report = {
    invoiceId,
    codeLast4,
    voided: preview.voided,
    payments: preview.payments.map((payment) => ({ id: payment.id, amountCents: paymentCents(payment.payload), method: payment.payload.method })),
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
        [`payment-release:${allocation.id}`, allocation.branch_id, "voided-mpesa-allocation-repair", releaseTs, releaseTs, {
          paymentId: payment?.id || String(allocation.local_payment_id || ""),
          invoiceId,
          branchId: allocation.branch_id,
          transactionId: allocation.transaction_id,
          allocationId: allocation.id,
          amountCents: Number(allocation.amount_cents || 0),
          reason,
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
