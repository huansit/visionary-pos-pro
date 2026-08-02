import crypto from "node:crypto";
import { Router } from "express";
import { requireAdminOrSupervisor, requireOwnerOrAdmin } from "../auth.js";
import { isMySql, q, tx } from "../db.js";
import {
  createKopokopoSubscriptions,
  kopokopoConfig,
  parseKopokopoWebhook,
  redactKopokopoPayload,
  validKopokopoSignature,
} from "../services/kopokopo.js";

const router = Router();

function integerCents(value) {
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

function accountCanAccessBranch(account, branchId) {
  const accountBranchId = String(account?.branchId || "").trim();
  return !accountBranchId || accountBranchId === branchId;
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

async function insertWebhookEvent(client, parsed, body) {
  const existing = await client.query(
    "SELECT event_id FROM kopokopo_webhook_events WHERE event_id = $1 LIMIT 1",
    [parsed.eventId]
  );
  if (existing.rows[0]) return false;
  if (isMySql) {
    const result = await client.query(
      `INSERT IGNORE INTO kopokopo_webhook_events (event_id, topic, resource_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [parsed.eventId, parsed.topic, parsed.resourceId, JSON.stringify(body)]
    );
    return Number(result.raw?.affectedRows || 0) > 0;
  }
  const result = await client.query(
    `INSERT INTO kopokopo_webhook_events (event_id, topic, resource_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [parsed.eventId, parsed.topic, parsed.resourceId, JSON.stringify(body)]
  );
  return Boolean(result.rows[0]);
}

async function applyReceivedTransaction(client, parsed) {
  const existing = await client.query(
    "SELECT id, status FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2 LIMIT 1 FOR UPDATE",
    [parsed.resourceId, parsed.reference]
  );
  const row = existing.rows[0];
  if (row) {
    await client.query(
      `UPDATE kopokopo_transactions
          SET webhook_event_id = $2,
              amount_cents = $3,
              currency = $4,
              status = CASE WHEN lower(status) = 'reversed' THEN status ELSE $5 END,
              till_number = $6,
              branch_id = COALESCE($7, branch_id),
              payer_name = COALESCE($8, payer_name),
              origination_time = COALESCE($9, origination_time),
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [row.id, parsed.eventId, parsed.amountCents, parsed.currency, parsed.status, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.originationTime]
    );
    return;
  }
  await client.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, currency, status, till_number, branch_id, payer_name, origination_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [parsed.resourceId, parsed.eventId, parsed.reference, parsed.referenceLast4, parsed.amountCents, parsed.currency, parsed.status, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.originationTime]
  );
}

async function applyReversedTransaction(client, parsed) {
  const existing = await client.query(
    "SELECT id FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2 LIMIT 1 FOR UPDATE",
    [parsed.resourceId, parsed.reference]
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE kopokopo_transactions
          SET webhook_event_id = $2, status = 'Reversed', reversed_at = COALESCE($3, ${isMySql ? "NOW()" : "now()"}),
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [existing.rows[0].id, parsed.eventId, parsed.eventTime]
    );
    return;
  }
  await client.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, currency, status, till_number, branch_id, payer_name, origination_time, reversed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Reversed', $7, $8, $9, $10, COALESCE($11, ${isMySql ? "NOW()" : "now()"}))`,
    [parsed.resourceId, parsed.eventId, parsed.reference, parsed.referenceLast4, parsed.amountCents, parsed.currency, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.originationTime, parsed.eventTime]
  );
}

router.post("/webhook", async (req, res) => {
  try {
    const config = kopokopoConfig();
    if (!config.enabled || !config.webhookSecret) return res.status(503).json({ error: "kopokopo_not_configured" });
    if (!validKopokopoSignature(req.rawBody, req.get("x-kopokopo-signature"), config.webhookSecret)) {
      return res.status(401).json({ error: "invalid_kopokopo_signature" });
    }
    const parsed = parseKopokopoWebhook(req.body, config);
    if (!parsed.supported) return res.status(202).json({ ok: true, ignored: true });
    if (!parsed.valid) return res.status(400).json({ error: "invalid_kopokopo_webhook" });
    const result = await tx(async (client) => {
      const inserted = await insertWebhookEvent(client, parsed, redactKopokopoPayload(req.body));
      if (!inserted) return { duplicate: true };
      if (parsed.reversed) await applyReversedTransaction(client, parsed);
      else await applyReceivedTransaction(client, parsed);
      return { duplicate: false };
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("Kopo Kopo webhook failed:", error);
    return res.status(500).json({ error: "kopokopo_webhook_failed" });
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
    const transactionId = String(req.body?.transactionId || "").trim();
    const branchId = String(req.body?.branchId || "").trim();
    const idempotencyKey = String(req.body?.idempotencyKey || "").trim();
    const requested = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    if (!transactionId || !branchId || !idempotencyKey || requested.length < 1 || requested.length > 50) {
      return res.status(400).json({ error: "invalid_kopokopo_allocation_request" });
    }
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const invoiceIds = new Set();
    const allocations = [];
    for (const entry of requested) {
      const invoiceId = String(entry?.invoiceId || "").trim();
      const localPaymentId = String(entry?.localPaymentId || "").trim();
      const amountCents = integerCents(entry?.amountCents);
      if (!invoiceId || !localPaymentId || !amountCents || invoiceIds.has(invoiceId)) {
        return res.status(400).json({ error: "invalid_kopokopo_allocation_entry" });
      }
      invoiceIds.add(invoiceId);
      allocations.push({ invoiceId, localPaymentId, amountCents });
    }
    const requestedTotal = allocations.reduce((sum, entry) => sum + entry.amountCents, 0);
    const result = await tx(async (client) => {
      const prior = await client.query(
        `SELECT id, transaction_id, invoice_id, amount_cents, local_payment_id, allocated_at
           FROM kopokopo_allocations
          WHERE batch_idempotency_key = $1
          ORDER BY allocated_at, id`,
        [idempotencyKey]
      );
      if (prior.rows.length) {
        const same = prior.rows.length === allocations.length && prior.rows.every((row) => {
          const requestedEntry = allocations.find((entry) => entry.invoiceId === (row.invoice_id ?? row.invoiceId));
          return requestedEntry && row.transaction_id === transactionId && Number(row.amount_cents) === requestedEntry.amountCents && row.local_payment_id === requestedEntry.localPaymentId;
        });
        if (!same) return { conflict: "idempotency_key_reused" };
        const transaction = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1", [transactionId]);
        return { duplicate: true, transaction: publicTransaction(transaction.rows[0]), allocations: prior.rows };
      }

      const locked = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      const transaction = locked.rows[0];
      if (!transaction) return { conflict: "kopokopo_transaction_not_found" };
      if ((transaction.branch_id ?? transaction.branchId) !== branchId) return { conflict: "kopokopo_branch_mismatch" };
      if (String(transaction.status).toLowerCase() !== "received" || transaction.reversed_at) return { conflict: "kopokopo_transaction_unavailable" };
      const remaining = Number(transaction.amount_cents) - Number(transaction.allocated_cents);
      if (requestedTotal > remaining) return { conflict: "kopokopo_amount_exceeds_balance", remainingCents: Math.max(0, remaining) };

      const inserted = [];
      for (const entry of allocations) {
        const id = `kpa_${crypto.randomUUID()}`;
        const saved = await client.query(
          `INSERT INTO kopokopo_allocations
            (id, transaction_id, invoice_id, branch_id, amount_cents, allocated_by, allocated_by_name, batch_idempotency_key, local_payment_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, transactionId, entry.invoiceId, branchId, entry.amountCents, req.account?.id || null, req.account?.name || null, idempotencyKey, entry.localPaymentId]
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
    if (result.conflict) return res.status(409).json({ error: result.conflict, remainingCents: result.remainingCents });
    return res.json(result);
  } catch (error) {
    console.error("Kopo Kopo allocation failed:", error);
    return res.status(500).json({ error: "kopokopo_allocation_failed" });
  }
});

export default router;
