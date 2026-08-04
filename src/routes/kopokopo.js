import crypto from "node:crypto";
import { Router } from "express";
import { requireAdminOrSupervisor, requireOwnerOrAdmin, requireRoles } from "../auth.js";
import { isMySql, q, tx } from "../db.js";
import { publishRealtimeEvent } from "../realtime.js";
import {
  createKopokopoSubscriptions,
  kopokopoConfig,
  kopokopoConfigForBranch,
  kopokopoConfigs,
  kopokopoEnabled,
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
const requireKopokopoViewer = requireRoles(new Set(["owner", "admin", "manager", "supervisor", "cashier"]));

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

function branchRequiresVerifiedKopokopo(_config, branchId) {
  return Boolean(kopokopoConfigForBranch(branchId)?.enabled);
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
    payerPhoneLast4: row.payer_phone_last4 ?? row.payerPhoneLast4 ?? null,
    originationTime: row.origination_time ?? row.originationTime ?? null,
    reversedAt: row.reversed_at ?? row.reversedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    providerVerified: true,
  };
}

function ledgerInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function ledgerTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function publicAllocation(row, invoicePayload = null) {
  const payload = invoicePayload || {};
  const invoiceId = row.invoice_id ?? row.invoiceId;
  return {
    id: row.id,
    invoiceId,
    invoiceNumber: payload.number || payload.invoiceNumber || payload.receiptNo || invoiceId,
    amountCents: Number(row.amount_cents ?? row.amountCents ?? 0),
    status: row.status || "active",
    allocatedByName: row.allocated_by_name ?? row.allocatedByName ?? null,
    allocatedAt: row.allocated_at ?? row.allocatedAt ?? null,
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
    const configs = kopokopoConfigs().filter((config) => config.enabled && config.webhookSecret);
    if (!configs.length) return res.status(503).json({ error: "kopokopo_not_configured" });
    const signature = req.get("x-kopokopo-signature");
    const config = configs.find((candidate) => validKopokopoSignature(req.rawBody, signature, candidate.webhookSecret));
    if (!config) {
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
      if (!parsed.branchId) {
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
    const configs = kopokopoConfigs().filter((candidate) => candidate.enabled);
    const counts = await q(
      `SELECT COUNT(*) AS transaction_count, MAX(origination_time) AS last_transaction_at
         FROM kopokopo_transactions`
    );
    const row = counts.rows[0] || {};
    return res.json({
      enabled: configs.length > 0,
      mode: config.mode,
      oauthConfigured: configs.length > 0 && configs.every((candidate) => candidate.clientId && candidate.clientSecret),
      webhookConfigured: configs.length > 0 && configs.every((candidate) => candidate.webhookSecret && candidate.webhookUrl),
      branchMappingConfigured: configs.length > 0 && configs.every((candidate) => Object.keys(candidate.tillBranchMap).length || (candidate.mode === "sandbox" && candidate.sandboxBranchId)),
      sandboxBranchId: config.mode === "sandbox" ? config.sandboxBranchId || null : null,
      accounts: configs.map((candidate) => ({
        id: candidate.accountId,
        branchIds: [...new Set(Object.values(candidate.tillBranchMap || {}))],
        tillNumbers: Object.keys(candidate.tillBranchMap || {}),
        oauthConfigured: Boolean(candidate.clientId && candidate.clientSecret),
        webhookConfigured: Boolean(candidate.webhookSecret && candidate.webhookUrl),
      })),
      transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
      lastTransactionAt: row.last_transaction_at ?? row.lastTransactionAt ?? null,
    });
  } catch (error) {
    console.error("Kopo Kopo status failed:", error);
    return res.status(500).json({ error: "kopokopo_status_failed" });
  }
});

router.post("/subscriptions", requireOwnerOrAdmin, async (req, res) => {
  try {
    const branchId = identifier(req.body?.branchId);
    const config = branchId ? kopokopoConfigForBranch(branchId) : kopokopoConfig();
    if (!config?.enabled) return res.status(409).json({ error: branchId ? "kopokopo_disabled_for_branch" : "kopokopo_disabled" });
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
    const branchId = identifier(req.body?.branchId);
    if (!branchId) return res.status(400).json({ error: "branch_required" });
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const config = kopokopoConfigForBranch(branchId);
    if (!config?.enabled) return res.status(409).json({ error: "kopokopo_disabled_for_branch" });
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
    const config = kopokopoConfigForBranch(existing.branchId);
    if (!config?.enabled) return res.status(409).json({ error: "kopokopo_disabled_for_branch" });
    const paymentRequest = await reconcileKopokopoIncomingPaymentRequest(id, config);
    let transaction = null;
    if (paymentRequest.status === "completed" && paymentRequest.providerTransactionId) {
      const result = await q(
        `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status,
                till_number, branch_id, payer_name, payer_phone_last4, origination_time
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
                till_number, branch_id, payer_name, payer_phone_last4, origination_time
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

router.get("/transactions", requireKopokopoViewer, async (req, res) => {
  try {
    const config = kopokopoConfig();
    const enabled = kopokopoEnabled();
    const requestedBranchId = identifier(req.query.branchId);
    const allBranches = requestedBranchId.toLowerCase() === "all";
    const accountBranchId = identifier(req.account?.branchId);
    const accountRole = String(req.account?.role || req.account?.kind || "").trim().toLowerCase();
    const cashierViewer = accountRole === "cashier";
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const sort = String(req.query.sort || "desc").trim().toLowerCase() === "asc" ? "ASC" : "DESC";
    const limit = Math.max(1, ledgerInteger(req.query.limit, 50, 100));
    const offset = ledgerInteger(req.query.offset, 0, 100000);
    const from = ledgerTimestamp(req.query.from);
    const to = ledgerTimestamp(req.query.to);
    const validStatuses = new Set(["all", "available", "partial", "allocated", "reversed"]);

    if (!requestedBranchId || search.length > 80 || !validStatuses.has(status)) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_filters" });
    }
    if ((req.query.from && !from) || (req.query.to && !to) || (from && to && from > to)) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_dates" });
    }
    if (cashierViewer && (!accountBranchId || allBranches || requestedBranchId !== accountBranchId)) {
      return res.status(403).json({ error: "branch_not_authorized" });
    }
    if ((allBranches && accountBranchId) || (!allBranches && !accountCanAccessBranch(req.account, requestedBranchId))) {
      return res.status(403).json({ error: "branch_not_authorized" });
    }

    const values = [];
    const clauses = [];
    const addValue = (value) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (!allBranches) clauses.push(`branch_id = ${addValue(requestedBranchId)}`);
    if (search) {
      const pattern = `%${search}%`;
      const placeholder = addValue(pattern);
      clauses.push(`(
        lower(COALESCE(payer_name, '')) LIKE ${placeholder}
        OR lower(COALESCE(payer_phone_last4, '')) LIKE ${placeholder}
        OR lower(COALESCE(reference_last4, '')) LIKE ${placeholder}
        OR id IN (
          SELECT search_allocation.transaction_id
            FROM kopokopo_allocations search_allocation
            JOIN events search_invoice
              ON search_invoice.id = search_allocation.invoice_id
             AND search_invoice.type = 'invoice'
           WHERE lower(COALESCE(
               search_invoice.payload->>'number',
               search_invoice.payload->>'invoiceNumber',
               search_invoice.payload->>'receiptNo',
               ''
             )) LIKE ${placeholder}
        )
      )`);
    }
    if (from) clauses.push(`COALESCE(origination_time, created_at) >= ${addValue(from)}`);
    if (to) clauses.push(`COALESCE(origination_time, created_at) <= ${addValue(to)}`);
    if (status === "available") clauses.push("lower(status) = 'received' AND reversed_at IS NULL AND allocated_cents < amount_cents");
    if (status === "partial") clauses.push("lower(status) = 'received' AND reversed_at IS NULL AND allocated_cents > 0 AND allocated_cents < amount_cents");
    if (status === "allocated") clauses.push("reversed_at IS NULL AND allocated_cents >= amount_cents");
    if (status === "reversed") clauses.push("reversed_at IS NOT NULL");
    const where = clauses.length ? clauses.join(" AND ") : "1 = 1";

    const summary = await q(
      `SELECT COUNT(*) AS total_count,
              COALESCE(SUM(amount_cents), 0) AS total_amount_cents,
              COALESCE(SUM(allocated_cents), 0) AS total_allocated_cents
         FROM kopokopo_transactions
        WHERE ${where}`,
      values
    );
    const branchSummary = await q(
      `SELECT branch_id, COUNT(*) AS transaction_count,
              COALESCE(SUM(amount_cents), 0) AS amount_cents,
              COALESCE(SUM(allocated_cents), 0) AS allocated_cents
         FROM kopokopo_transactions
        WHERE ${where}
        GROUP BY branch_id
        ORDER BY branch_id`,
      values
    );
    const pageValues = [...values, limit, offset];
    const result = await q(
      `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status, till_number,
              branch_id, payer_name, payer_phone_last4, origination_time, reversed_at, created_at
         FROM kopokopo_transactions
        WHERE ${where}
        ORDER BY COALESCE(origination_time, created_at) ${sort}, created_at ${sort}, id ${sort}
        LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    const transactionRows = result.rows;
    const allocationsByTransaction = new Map();
    if (transactionRows.length) {
      const transactionIds = transactionRows.map((row) => row.id);
      const transactionPlaceholders = transactionIds.map((_, index) => `$${index + 1}`).join(", ");
      const allocationResult = await q(
        `SELECT id, transaction_id, invoice_id, amount_cents, status, allocated_by_name, allocated_at
           FROM kopokopo_allocations
          WHERE transaction_id IN (${transactionPlaceholders})
          ORDER BY allocated_at, id`,
        transactionIds
      );
      const invoiceIds = [...new Set(allocationResult.rows.map((row) => row.invoice_id ?? row.invoiceId).filter(Boolean))];
      const invoicePayloadById = new Map();
      if (invoiceIds.length) {
        const invoicePlaceholders = invoiceIds.map((_, index) => `$${index + 1}`).join(", ");
        const invoiceResult = await q(
          `SELECT id, payload
             FROM events
            WHERE type = 'invoice'
              AND id IN (${invoicePlaceholders})`,
          invoiceIds
        );
        for (const invoice of invoiceResult.rows) invoicePayloadById.set(invoice.id, invoice.payload || {});
      }
      for (const allocation of allocationResult.rows) {
        const transactionId = allocation.transaction_id ?? allocation.transactionId;
        const invoiceId = allocation.invoice_id ?? allocation.invoiceId;
        const current = allocationsByTransaction.get(transactionId) || [];
        current.push(publicAllocation(allocation, invoicePayloadById.get(invoiceId)));
        allocationsByTransaction.set(transactionId, current);
      }
    }
    const totals = summary.rows[0] || {};
    const amountCents = Number(totals.total_amount_cents ?? totals.totalAmountCents ?? 0);
    const allocatedCents = Number(totals.total_allocated_cents ?? totals.totalAllocatedCents ?? 0);
    return res.json({
      enabled,
      branchId: allBranches ? "all" : requestedBranchId,
      providerRequired: allBranches ? null : branchRequiresVerifiedKopokopo(config, requestedBranchId),
      transactions: transactionRows.map((row) => ({
        ...publicTransaction(row),
        allocations: allocationsByTransaction.get(row.id) || [],
      })),
      page: {
        total: Number(totals.total_count ?? totals.totalCount ?? 0),
        limit,
        offset,
      },
      summary: {
        amountCents,
        allocatedCents,
        remainingCents: Math.max(0, amountCents - allocatedCents),
        branches: branchSummary.rows.map((row) => {
          const branchAmountCents = Number(row.amount_cents ?? row.amountCents ?? 0);
          const branchAllocatedCents = Number(row.allocated_cents ?? row.allocatedCents ?? 0);
          return {
            branchId: row.branch_id ?? row.branchId ?? null,
            transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
            amountCents: branchAmountCents,
            allocatedCents: branchAllocatedCents,
            remainingCents: Math.max(0, branchAmountCents - branchAllocatedCents),
          };
        }),
      },
    });
  } catch (error) {
    console.error("Kopo Kopo transaction ledger failed:", error);
    return res.status(500).json({ error: "kopokopo_transaction_ledger_failed" });
  }
});

router.get("/transactions/lookup", requireAdminOrSupervisor, async (req, res) => {
  try {
    const config = kopokopoConfig();
    const branchId = String(req.query.branchId || "").trim();
    const last4 = String(req.query.last4 || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!branchId || (last4.length > 0 && last4.length !== 4)) return res.status(400).json({ error: "invalid_branch_or_last4" });
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const providerRequired = branchRequiresVerifiedKopokopo(config, branchId);
    const enabled = kopokopoEnabled();
    if (!enabled || !last4) return res.json({ enabled, providerRequired, transactions: [] });
    const result = await q(
      `SELECT id, reference_last4, amount_cents, allocated_cents, currency, status, till_number, branch_id, payer_name, payer_phone_last4, origination_time
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
    return res.json({ enabled: true, providerRequired, transactions: result.rows.map(publicTransaction) });
  } catch (error) {
    console.error("Kopo Kopo lookup failed:", error);
    return res.status(500).json({ error: "kopokopo_lookup_failed" });
  }
});

router.post("/allocations", requireAdminOrSupervisor, async (req, res) => {
  try {
    if (!kopokopoEnabled()) return res.status(409).json({ error: "kopokopo_disabled" });
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
    if (!result.duplicate) {
      publishRealtimeEvent("kopokopo", {
        source: "kopokopo",
        branchId,
        accepted: result.allocations.length,
        types: ["kopokopoAllocation"],
      });
    }
    return res.json(result);
  } catch (error) {
    console.error("Kopo Kopo allocation failed:", error);
    return res.status(500).json({ error: "kopokopo_allocation_failed" });
  }
});

export default router;

