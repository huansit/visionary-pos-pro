import crypto from "node:crypto";
import { Router } from "express";
import { requireAdminOrSupervisor, requireOwnerOrAdmin } from "../auth.js";
import { isMySql, q, tx } from "../db.js";
import {
  createKopokopoSubscriptions,
  kopokopoConfig,
  normalizeKopokopoCallback,
  parseKopokopoWebhook,
  validKopokopoSignature,
} from "../services/kopokopo.js";
import { storeKopokopoEvent } from "../services/kopokopoLedger.js";
import {
  cleanupKopokopoSandboxTestRequest,
  createTrackedKopokopoIncomingPayment,
  getKopokopoIncomingPaymentRequest,
  getKopokopoSandboxTestRequest,
  kopokopoSandboxTestAllocationIds,
  reconcileKopokopoIncomingPaymentRequest,
} from "../services/kopokopoIncomingPayments.js";

const router = Router();
const MAX_IDENTIFIER_LENGTH = 191;

function integerCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

function identifier(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= MAX_IDENTIFIER_LENGTH ? id : "";
}

function payloadCents(payload, centField, moneyField) {
  const cents = Number(payload?.[centField]);
  if (Number.isFinite(cents)) return Math.max(0, Math.round(cents));
  const money = Number(payload?.[moneyField]);
  return Number.isFinite(money) ? Math.max(0, Math.round(money * 100)) : 0;
}

function accountCanAccessBranch(account, branchId) {
  const accountBranchId = String(account?.branchId || "").trim();
  return !accountBranchId || accountBranchId === branchId;
}

function sandboxTestConfig(config) {
  const callbackUrl = new URL(config.webhookUrl);
  callbackUrl.pathname = "/api/integrations/kopokopo/sandbox-test-webhook";
  callbackUrl.search = "";
  callbackUrl.hash = "";
  return { ...config, webhookUrl: callbackUrl.toString() };
}

function sandboxTestAvailable(config) {
  return config.enabled && config.mode === "sandbox" && Boolean(config.sandboxBranchId);
}

function publicTransaction(row) {
  const amountCents = Number(row.amount_cents ?? row.amountCents ?? 0);
  const allocatedCents = Number(row.allocated_cents ?? row.allocatedCents ?? 0);
  const referenceLast4 = row.reference_last4 ?? row.referenceLast4;
  return {
    id: row.id,
    referenceMasked: `****${referenceLast4}`,
    referenceLast4,
    amountCents,
    allocatedCents,
    remainingCents: Math.max(0, amountCents - allocatedCents),
    currency: row.currency,
    status: row.status,
    tillNumber: row.till_number ?? row.tillNumber ?? null,
    branchId: row.branch_id ?? row.branchId ?? null,
    payerName: row.payer_name ?? row.payerName ?? null,
    originationTime: row.origination_time ?? row.originationTime ?? null,
    providerVerified: true,
  };
}

async function validateAllocationInvoices(client, allocations, branchId, syntheticInvoices = new Map()) {
  const invoiceIds = allocations.map((entry) => entry.invoiceId);
  const placeholders = invoiceIds.map((_, index) => `$${index + 1}`).join(", ");
  const storedInvoiceIds = invoiceIds.filter((id) => !syntheticInvoices.has(id));
  let storedInvoices = [];
  if (storedInvoiceIds.length) {
    const storedPlaceholders = storedInvoiceIds.map((_, index) => `$${index + 1}`).join(", ");
    const invoices = await client.query(
      `SELECT id, branch_id, payload
         FROM events
        WHERE type = 'invoice'
          AND id IN (${storedPlaceholders})
        FOR UPDATE`,
      storedInvoiceIds
    );
    storedInvoices = invoices.rows;
  }
  const invoiceById = new Map(storedInvoices.map((row) => [row.id, row]));
  for (const [id, invoice] of syntheticInvoices) invoiceById.set(id, invoice);
  const relatedEvents = await client.query(
    `SELECT id, type, payload
       FROM events
      WHERE type IN ('payment', 'invoiceVoidDecision')
        AND (branch_id = $1 OR branch_id IS NULL)`,
    [branchId]
  );
  const paymentIds = new Set();
  const paidByInvoice = new Map();
  const voidedInvoiceIds = new Set();
  for (const row of relatedEvents.rows) {
    const payload = row.payload || {};
    const invoiceId = String(payload.invoiceId || payload.orderId || "").trim();
    if (!invoiceId) continue;
    if (row.type === "invoiceVoidDecision") {
      if (String(payload.decision || "").toLowerCase() === "approved") voidedInvoiceIds.add(invoiceId);
      continue;
    }
    if (payload.status && String(payload.status).toLowerCase() !== "captured") continue;
    paymentIds.add(String(row.id));
    if (payload.id) paymentIds.add(String(payload.id));
    paidByInvoice.set(invoiceId, (paidByInvoice.get(invoiceId) || 0) + payloadCents(payload, "amountCents", "amount"));
  }

  const reservations = await client.query(
    `SELECT invoice_id, amount_cents, local_payment_id
       FROM kopokopo_allocations
      WHERE lower(status) = 'active'
        AND invoice_id IN (${placeholders})`,
    invoiceIds
  );
  const reservedByInvoice = new Map();
  for (const row of reservations.rows) {
    const localPaymentId = String(row.local_payment_id ?? row.localPaymentId ?? "");
    if (localPaymentId && paymentIds.has(localPaymentId)) continue;
    const invoiceId = row.invoice_id ?? row.invoiceId;
    reservedByInvoice.set(invoiceId, (reservedByInvoice.get(invoiceId) || 0) + Number(row.amount_cents ?? row.amountCents ?? 0));
  }

  for (const allocation of allocations) {
    const invoice = invoiceById.get(allocation.invoiceId);
    if (!invoice) return { conflict: "kopokopo_invoice_not_found", invoiceId: allocation.invoiceId };
    const payload = invoice.payload || {};
    const invoiceBranchId = String(invoice.branch_id ?? invoice.branchId ?? payload.branchId ?? "").trim();
    if (!invoiceBranchId || invoiceBranchId !== branchId) {
      return { conflict: "kopokopo_invoice_branch_mismatch", invoiceId: allocation.invoiceId };
    }
    if (voidedInvoiceIds.has(allocation.invoiceId) || String(payload.status || "").toLowerCase() === "voided") {
      return { conflict: "kopokopo_invoice_voided", invoiceId: allocation.invoiceId };
    }
    const totalCents = payloadCents(payload, "totalCents", "total");
    const recordedPaidCents = Math.max(
      payloadCents(payload, "paidCents", "paid"),
      paidByInvoice.get(allocation.invoiceId) || 0
    );
    const reservedCents = reservedByInvoice.get(allocation.invoiceId) || 0;
    const outstandingCents = Math.max(0, totalCents - recordedPaidCents - reservedCents);
    if (totalCents <= 0 || allocation.amountCents > outstandingCents) {
      return {
        conflict: "kopokopo_invoice_balance_exceeded",
        invoiceId: allocation.invoiceId,
        invoiceRemainingCents: outstandingCents,
      };
    }
  }
  return null;
}

async function allocateKopokopoPayment({
  transactionId,
  branchId,
  idempotencyKey,
  allocations,
  account,
  allowedStatuses = ["received"],
  syntheticInvoices = new Map(),
}) {
  const requestedTotal = allocations.reduce((sum, entry) => sum + entry.amountCents, 0);
  const acceptedStatuses = new Set(allowedStatuses.map((status) => String(status).toLowerCase()));
  return tx(async (client) => {
    const prior = await client.query(
      `SELECT id, transaction_id, invoice_id, branch_id, amount_cents, local_payment_id, allocated_at
         FROM kopokopo_allocations
        WHERE batch_idempotency_key = $1
        ORDER BY allocated_at, id`,
      [idempotencyKey]
    );
    if (prior.rows.length) {
      const same = prior.rows.length === allocations.length && prior.rows.every((row) => {
        const requestedEntry = allocations.find((entry) => entry.invoiceId === (row.invoice_id ?? row.invoiceId));
        return requestedEntry
          && (row.transaction_id ?? row.transactionId) === transactionId
          && (row.branch_id ?? row.branchId) === branchId
          && Number(row.amount_cents ?? row.amountCents) === requestedEntry.amountCents
          && (row.local_payment_id ?? row.localPaymentId) === requestedEntry.localPaymentId;
      });
      if (!same) return { conflict: "idempotency_key_reused" };
      const transaction = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1", [transactionId]);
      if (!transaction.rows[0] || (transaction.rows[0].branch_id ?? transaction.rows[0].branchId) !== branchId) {
        return { conflict: "idempotency_key_reused" };
      }
      return { duplicate: true, transaction: publicTransaction(transaction.rows[0]), allocations: prior.rows };
    }

    const locked = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
    const transaction = locked.rows[0];
    if (!transaction) return { conflict: "kopokopo_transaction_not_found" };
    if ((transaction.branch_id ?? transaction.branchId) !== branchId) return { conflict: "kopokopo_branch_mismatch" };
    if (!acceptedStatuses.has(String(transaction.status).toLowerCase()) || transaction.reversed_at) {
      return { conflict: "kopokopo_transaction_unavailable" };
    }
    if (String(transaction.currency || "").toUpperCase() !== "KES") return { conflict: "kopokopo_currency_unsupported" };
    const remaining = Number(transaction.amount_cents) - Number(transaction.allocated_cents);
    if (requestedTotal > remaining) return { conflict: "kopokopo_amount_exceeds_balance", remainingCents: Math.max(0, remaining) };
    const invoiceConflict = await validateAllocationInvoices(client, allocations, branchId, syntheticInvoices);
    if (invoiceConflict) return invoiceConflict;

    const inserted = [];
    for (const entry of allocations) {
      const id = `kpa_${crypto.randomUUID()}`;
      const saved = await client.query(
        `INSERT INTO kopokopo_allocations
          (id, transaction_id, invoice_id, branch_id, amount_cents, allocated_by, allocated_by_name, batch_idempotency_key, local_payment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, transactionId, entry.invoiceId, branchId, entry.amountCents, account?.id || null, account?.name || null, idempotencyKey, entry.localPaymentId]
      );
      inserted.push({ id, transactionId, invoiceId: entry.invoiceId, branchId, amountCents: entry.amountCents, localPaymentId: entry.localPaymentId, raw: saved.raw || null });
    }
    await client.query(
      `UPDATE kopokopo_transactions
          SET allocated_cents = allocated_cents + $2, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [transactionId, requestedTotal]
    );
    const updated = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1", [transactionId]);
    return { duplicate: false, transaction: publicTransaction(updated.rows[0]), allocations: inserted };
  });
}

router.post("/webhook", async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!config.enabled || !config.webhookSecret) return res.status(503).json({ error: "kopokopo_not_configured" });
    if (!validKopokopoSignature(req.rawBody, req.get("x-kopokopo-signature"), config.webhookSecret)) {
      return res.status(401).json({ error: "invalid_kopokopo_signature" });
    }
    const callback = normalizeKopokopoCallback(req.body);
    if (!callback.recognized) return res.status(202).json({ ok: true, ignored: true });
    if (!callback.events.length) return res.status(202).json({ ok: true, ignored: true, kind: callback.kind });

    const summary = {
      received: callback.received,
      stored: 0,
      duplicates: 0,
      ignored: Math.max(0, callback.received - callback.events.length),
    };
    for (const body of callback.events) {
      const parsed = parseKopokopoWebhook(body, config);
      if (!parsed.supported) {
        summary.ignored += 1;
        continue;
      }
      if (!parsed.valid) {
        if (callback.kind === "subscription") {
          return res.status(400).json({ error: "invalid_kopokopo_webhook" });
        }
        summary.ignored += 1;
        continue;
      }
      const result = await storeKopokopoEvent(parsed, body);
      if (result.duplicate) summary.duplicates += 1;
      else summary.stored += 1;
    }
    if (callback.kind === "subscription" && summary.ignored > 0) {
      return res.status(202).json({ ok: true, ignored: true });
    }
    if (callback.kind === "subscription") {
      return res.status(200).json({ ok: true, duplicate: summary.duplicates === 1 });
    }
    return res.status(200).json({ ok: true, kind: callback.kind, ...summary });
  } catch (error) {
    console.error("Kopo Kopo webhook failed:", error);
    return res.status(500).json({ error: "kopokopo_webhook_failed" });
  }
});

router.post("/sandbox-test-webhook", async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!sandboxTestAvailable(config)) return res.status(404).json({ error: "kopokopo_sandbox_test_unavailable" });
    if (!validKopokopoSignature(req.rawBody, req.get("x-kopokopo-signature"), config.webhookSecret)) {
      return res.status(401).json({ error: "invalid_kopokopo_signature" });
    }
    return res.status(200).json({ ok: true, test: true });
  } catch (error) {
    console.error("Kopo Kopo sandbox test callback failed:", error.message);
    return res.status(500).json({ error: "kopokopo_sandbox_test_callback_failed" });
  }
});

router.get("/status", requireAdminOrSupervisor, async (_req, res) => {
  try {
    const config = kopokopoConfig();
    const counts = await q(
      `SELECT COUNT(*) AS transaction_count, MAX(origination_time) AS last_transaction_at
         FROM kopokopo_transactions`
    );
    const row = counts.rows[0] || {};
    return res.json({
      enabled: config.enabled,
      mode: config.mode,
      oauthConfigured: Boolean(config.clientId && config.clientSecret),
      webhookConfigured: Boolean(config.webhookSecret && config.webhookUrl),
      branchMappingConfigured: Boolean(Object.keys(config.tillBranchMap).length || (config.mode === "sandbox" && config.sandboxBranchId)),
      sandboxBranchId: config.mode === "sandbox" ? config.sandboxBranchId || null : null,
      transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
      lastTransactionAt: row.last_transaction_at ?? row.lastTransactionAt ?? null,
    });
  } catch (error) {
    console.error("Kopo Kopo status failed:", error);
    return res.status(500).json({ error: "kopokopo_status_failed" });
  }
});

router.post("/subscriptions", requireOwnerOrAdmin, async (_req, res) => {
  try {
    const config = kopokopoConfig();
    if (!config.enabled) return res.status(409).json({ error: "kopokopo_disabled" });
    const subscriptions = await createKopokopoSubscriptions(config);
    return res.status(201).json({ subscriptions });
  } catch (error) {
    console.error("Kopo Kopo subscription failed:", error);
    return res.status(502).json({
      error: error.message || "kopokopo_subscription_failed",
      providerStatus: error.providerStatus || null,
      providerMessage: error.providerMessage || null,
    });
  }
});

router.post("/incoming-payments", requireAdminOrSupervisor, async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!config.enabled) return res.status(409).json({ error: "kopokopo_disabled" });
    const branchId = identifier(req.body?.branchId);
    if (!branchId) return res.status(400).json({ error: "branch_required" });
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const result = await createTrackedKopokopoIncomingPayment({
      idempotencyKey: req.body?.idempotencyKey,
      branchId,
      amountCents: req.body?.amountCents,
      phoneNumber: req.body?.phoneNumber,
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
      reference: req.body?.reference,
      notes: req.body?.notes,
      createdBy: req.account?.id,
    }, config);
    return res.status(result.duplicate ? 200 : 202).json(result);
  } catch (error) {
    const invalid = new Set([
      "invalid_kopokopo_idempotency_key",
      "invalid_kopokopo_incoming_payment",
      "kopokopo_payment_reference_required",
    ]);
    const conflict = new Set([
      "kopokopo_branch_till_not_configured",
      "kopokopo_till_branch_mismatch",
      "kopokopo_idempotency_key_reused",
    ]).has(error.message);
    console.error("Kopo Kopo incoming payment request failed:", error.message, error.providerStatus || "");
    return res.status(invalid.has(error.message) ? 400 : conflict ? 409 : 502).json({
      error: error.message || "kopokopo_incoming_payment_request_failed",
      providerStatus: error.providerStatus || null,
      providerMessage: error.providerMessage || null,
    });
  }
});

router.get("/incoming-payments/:id", requireAdminOrSupervisor, async (req, res) => {
  try {
    const id = identifier(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_kopokopo_incoming_payment_id" });
    const existing = await getKopokopoIncomingPaymentRequest(id);
    if (!existing) return res.status(404).json({ error: "kopokopo_incoming_payment_not_found" });
    if (!accountCanAccessBranch(req.account, existing.branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const paymentRequest = await reconcileKopokopoIncomingPaymentRequest(id);
    let transaction = null;
    if (paymentRequest.status === "completed" && paymentRequest.providerTransactionId) {
      const result = await q(
        `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status,
                till_number, branch_id, payer_name, origination_time
           FROM kopokopo_transactions
          WHERE id = $1 AND branch_id = $2
          LIMIT 1`,
        [paymentRequest.providerTransactionId, existing.branchId]
      );
      if (result.rows[0]) transaction = publicTransaction(result.rows[0]);
    }
    return res.json({ request: paymentRequest, transaction });
  } catch (error) {
    console.error("Kopo Kopo incoming payment status failed:", error.message);
    return res.status(502).json({ error: "kopokopo_incoming_payment_status_failed" });
  }
});

router.post("/sandbox-tests", requireOwnerOrAdmin, async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!sandboxTestAvailable(config)) return res.status(409).json({ error: "kopokopo_sandbox_test_unavailable" });
    const requestedTestType = String(req.body?.testType || "retrieval").trim().toLowerCase();
    if (!["retrieval", "allocation"].includes(requestedTestType)) {
      return res.status(400).json({ error: "invalid_kopokopo_sandbox_test_type" });
    }
    const amountCents = integerCents(req.body?.amountCents);
    if (!amountCents || amountCents > 100_000) {
      return res.status(400).json({ error: "invalid_kopokopo_sandbox_test_amount" });
    }
    const keyPrefix = requestedTestType === "allocation" ? "sandbox-allocation-test:" : "sandbox-test:";
    const result = await createTrackedKopokopoIncomingPayment({
      idempotencyKey: `${keyPrefix}${crypto.randomUUID()}`,
      branchId: config.sandboxBranchId,
      amountCents,
      phoneNumber: req.body?.phoneNumber,
      firstName: "VISIONPOS",
      lastName: "Sandbox",
      reference: `VPOSTEST${Date.now()}`,
      notes: "VISIONPOS admin sandbox verification",
      createdBy: req.account?.id,
    }, sandboxTestConfig(config));
    const paymentRequest = { ...result.request, testType: requestedTestType };
    return res.status(202).json({ request: paymentRequest, branchId: config.sandboxBranchId });
  } catch (error) {
    const invalid = new Set([
      "invalid_kopokopo_incoming_payment",
      "kopokopo_payment_reference_required",
    ]).has(error.message);
    console.error("Kopo Kopo sandbox test failed:", error.message, error.providerStatus || "");
    return res.status(invalid ? 400 : 502).json({
      error: error.message || "kopokopo_sandbox_test_failed",
      providerStatus: error.providerStatus || null,
      providerMessage: error.providerMessage || null,
    });
  }
});

router.get("/sandbox-tests/:id", requireOwnerOrAdmin, async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!sandboxTestAvailable(config)) return res.status(409).json({ error: "kopokopo_sandbox_test_unavailable" });
    const id = identifier(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_kopokopo_sandbox_test_id" });
    const existing = await getKopokopoSandboxTestRequest(id);
    if (!existing) return res.status(404).json({ error: "kopokopo_sandbox_test_not_found" });
    const reconciled = await reconcileKopokopoIncomingPaymentRequest(id, sandboxTestConfig(config));
    const paymentRequest = { ...reconciled, testType: existing.testType };
    let transaction = null;
    let allocationTest = null;
    if (paymentRequest.status === "completed" && paymentRequest.providerTransactionId) {
      const result = await q(
        `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status,
                till_number, branch_id, payer_name, origination_time
           FROM kopokopo_transactions
          WHERE id = $1 AND branch_id = $2
          LIMIT 1`,
        [paymentRequest.providerTransactionId, config.sandboxBranchId]
      );
      if (result.rows[0]) transaction = publicTransaction(result.rows[0]);
      if (transaction && existing.testType === "allocation") {
        const testIds = kopokopoSandboxTestAllocationIds(id);
        const syntheticInvoices = new Map([[
          testIds.invoiceId,
          {
            id: testIds.invoiceId,
            branch_id: config.sandboxBranchId,
            payload: {
              id: testIds.invoiceId,
              branchId: config.sandboxBranchId,
              totalCents: paymentRequest.amountCents,
              paidCents: 0,
              status: "open",
              sandboxTest: true,
              sandboxRequestId: id,
            },
          },
        ]]);
        const allocationResult = await allocateKopokopoPayment({
          transactionId: transaction.id,
          branchId: config.sandboxBranchId,
          idempotencyKey: testIds.idempotencyKey,
          allocations: [{
            invoiceId: testIds.invoiceId,
            localPaymentId: testIds.localPaymentId,
            amountCents: paymentRequest.amountCents,
          }],
          account: req.account,
          allowedStatuses: ["sandboxtest"],
          syntheticInvoices,
        });
        if (allocationResult.conflict) throw new Error(allocationResult.conflict);
        transaction = allocationResult.transaction;
        allocationTest = {
          invoiceId: testIds.invoiceId,
          invoiceTotalCents: paymentRequest.amountCents,
          allocatedCents: paymentRequest.amountCents,
          invoiceBalanceCents: 0,
          transactionRemainingCents: transaction.remainingCents,
          allocationId: allocationResult.allocations[0]?.id || null,
          verified: transaction.allocatedCents === paymentRequest.amountCents && transaction.remainingCents === 0,
        };
      }
    }
    return res.json({ request: paymentRequest, transaction, allocationTest, branchId: config.sandboxBranchId });
  } catch (error) {
    console.error("Kopo Kopo sandbox test status failed:", error.message);
    return res.status(502).json({ error: "kopokopo_sandbox_test_status_failed" });
  }
});

router.delete("/sandbox-tests/:id", requireOwnerOrAdmin, async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!sandboxTestAvailable(config)) return res.status(409).json({ error: "kopokopo_sandbox_test_unavailable" });
    const id = identifier(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid_kopokopo_sandbox_test_id" });
    const result = await cleanupKopokopoSandboxTestRequest(id, config);
    return res.json(result);
  } catch (error) {
    const conflict = error.message === "kopokopo_sandbox_test_has_allocations";
    console.error("Kopo Kopo sandbox test cleanup failed:", error.message);
    return res.status(conflict ? 409 : 500).json({ error: error.message || "kopokopo_sandbox_test_cleanup_failed" });
  }
});

router.get("/transactions/lookup", requireAdminOrSupervisor, async (req, res) => {
  try {
    const config = kopokopoConfig();
    const branchId = String(req.query.branchId || "").trim();
    const last4 = String(req.query.last4 || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!branchId || last4.length !== 4) return res.status(400).json({ error: "branch_and_last4_required" });
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    if (!config.enabled) return res.json({ enabled: false, transactions: [] });
    const result = await q(
      `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status, till_number, branch_id, payer_name, origination_time
         FROM kopokopo_transactions
        WHERE branch_id = $1
          AND reference_last4 = $2
          AND lower(status) = 'received'
          AND reversed_at IS NULL
          AND allocated_cents < amount_cents
        ORDER BY origination_time DESC, created_at DESC
        LIMIT 20`,
      [branchId, last4]
    );
    return res.json({ enabled: true, transactions: result.rows.map(publicTransaction) });
  } catch (error) {
    console.error("Kopo Kopo lookup failed:", error);
    return res.status(500).json({ error: "kopokopo_lookup_failed" });
  }
});

router.post("/allocations", requireAdminOrSupervisor, async (req, res) => {
  try {
    if (!kopokopoConfig().enabled) return res.status(409).json({ error: "kopokopo_disabled" });
    const transactionId = identifier(req.body?.transactionId);
    const branchId = identifier(req.body?.branchId);
    const idempotencyKey = identifier(req.body?.idempotencyKey);
    const requested = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    if (!transactionId || !branchId || !idempotencyKey || requested.length < 1 || requested.length > 50) {
      return res.status(400).json({ error: "invalid_kopokopo_allocation_request" });
    }
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const invoiceIds = new Set();
    const allocations = [];
    for (const entry of requested) {
      const invoiceId = identifier(entry?.invoiceId);
      const localPaymentId = identifier(entry?.localPaymentId);
      const amountCents = integerCents(entry?.amountCents);
      if (!invoiceId || !localPaymentId || !amountCents || invoiceIds.has(invoiceId)) {
        return res.status(400).json({ error: "invalid_kopokopo_allocation_entry" });
      }
      invoiceIds.add(invoiceId);
      allocations.push({ invoiceId, localPaymentId, amountCents });
    }
    const requestedTotal = allocations.reduce((sum, entry) => sum + entry.amountCents, 0);
    if (!Number.isSafeInteger(requestedTotal) || requestedTotal <= 0) {
      return res.status(400).json({ error: "invalid_kopokopo_allocation_total" });
    }
    const result = await allocateKopokopoPayment({
      transactionId,
      branchId,
      idempotencyKey,
      allocations,
      account: req.account,
    });
    if (result.conflict) {
      return res.status(409).json({
        error: result.conflict,
        remainingCents: result.remainingCents,
        invoiceId: result.invoiceId,
        invoiceRemainingCents: result.invoiceRemainingCents,
      });
    }
    return res.json(result);
  } catch (error) {
    console.error("Kopo Kopo allocation failed:", error);
    return res.status(500).json({ error: "kopokopo_allocation_failed" });
  }
});

export default router;

