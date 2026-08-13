import crypto from "node:crypto";
import { Router } from "express";
import { requireAdminOrSupervisor, requireOwnerOrAdmin, requireRoles } from "../auth.js";
import { isMySql, q, tx } from "../db.js";
import { publishRealtimeEvent } from "../realtime.js";
import {
  branchForTill,
  createKopokopoSubscriptions,
  kopokopoConfig,
  kopokopoConfigForBranch,
  kopokopoConfigs,
  kopokopoEnabled,
  kopokopoTransactionKind,
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

function transactionPurpose(transaction) {
  const purpose = String(transaction?.purpose ?? transaction?.transactionPurpose ?? "customer_payment")
    .trim()
    .toLowerCase();
  return purpose === "stock_funding" ? "stock_funding" : "customer_payment";
}

function publicTransaction(row) {
  const amountCents = Number(row.amount_cents ?? row.amountCents ?? 0);
  const allocatedCents = Number(row.allocated_cents ?? row.allocatedCents ?? 0);
  const referenceLast4 = row.reference_last4 ?? row.referenceLast4;
  const reversedAt = row.reversed_at ?? row.reversedAt ?? null;
  const reversed = Boolean(reversedAt) || String(row.status || "").toLowerCase() === "reversed";
  const providerTopic = row.provider_topic ?? row.providerTopic ?? null;
  const transactionKind = kopokopoTransactionKind(providerTopic);
  const purpose = transactionPurpose(row);
  const allocatable = !reversed && purpose !== "stock_funding";
  return {
    id: row.id,
    referenceMasked: `****${referenceLast4}`,
    referenceLast4,
    amountCents,
    allocatedCents,
    remainingCents: allocatable ? Math.max(0, amountCents - allocatedCents) : 0,
    currency: row.currency,
    status: row.status,
    tillNumber: row.till_number ?? row.tillNumber ?? null,
    branchId: row.branch_id ?? row.branchId ?? null,
    payerName: row.payer_name ?? row.payerName ?? null,
    payerPhoneLast4: row.payer_phone_last4 ?? row.payerPhoneLast4 ?? null,
    originationTime: row.origination_time ?? row.originationTime ?? null,
    reversedAt,
    createdAt: row.created_at ?? row.createdAt ?? null,
    providerVerified: true,
    transactionKind,
    allocatable,
    purpose,
    purposeChangedAt: row.purpose_changed_at ?? row.purposeChangedAt ?? null,
    purposeChangedByName: row.purpose_changed_by_name ?? row.purposeChangedByName ?? null,
    purposeNote: row.purpose_note ?? row.purposeNote ?? null,
  };
}

async function attachProviderTopic(client, transaction) {
  const eventId = transaction?.webhook_event_id ?? transaction?.webhookEventId;
  if (!eventId) return transaction;
  const result = await client.query(
    "SELECT topic FROM kopokopo_webhook_events WHERE event_id = $1 LIMIT 1",
    [eventId]
  );
  transaction.provider_topic = result.rows[0]?.topic || null;
  return transaction;
}

function transactionCanAllocate(transaction) {
  if (transactionPurpose(transaction) === "stock_funding") return false;
  const topic = String(transaction?.provider_topic ?? transaction?.providerTopic ?? "").trim().toLowerCase();
  if (!topic) return true; // Legacy verified rows predate persisted webhook topics.
  return ["buygoods_transaction_received", "b2b_transaction_received"].includes(topic);
}

function configuredTransactionBranch(transaction) {
  const tillNumber = String(transaction?.till_number ?? transaction?.tillNumber ?? "").trim();
  if (!tillNumber) return null;
  const matches = [...new Set(kopokopoConfigs()
    .map((config) => branchForTill(tillNumber, config))
    .filter(Boolean))];
  return matches.length === 1 ? matches[0] : null;
}

function transactionBelongsToBranch(transaction, branchId) {
  const configuredBranchId = configuredTransactionBranch(transaction);
  if (configuredBranchId) return configuredBranchId === branchId;
  return (transaction?.branch_id ?? transaction?.branchId) === branchId;
}

async function repairTransactionBranch(client, transaction, branchId) {
  if (!transactionBelongsToBranch(transaction, branchId)) return false;
  const storedBranchId = transaction?.branch_id ?? transaction?.branchId;
  if (storedBranchId !== branchId && configuredTransactionBranch(transaction) === branchId) {
    await client.query(
      `UPDATE kopokopo_transactions
          SET branch_id = $2, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [transaction.id, branchId]
    );
    transaction.branch_id = branchId;
    transaction.branchId = branchId;
  }
  return true;
}

function transactionStatusAvailable(transaction, acceptedStatuses = ["received"]) {
  const status = String(transaction?.status || "").trim().toLowerCase();
  const accepted = new Set(acceptedStatuses.map((value) => String(value).trim().toLowerCase()));
  if (accepted.has("received")) {
    ["complete", "completed", "success"].forEach((value) => accepted.add(value));
  }
  return accepted.has(status) && !transaction?.reversed_at && !transaction?.reversedAt;
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

function ledgerBranchStarts(value) {
  if (!value) return [];
  if (String(value).length > 4096) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 25) return null;
    const normalized = entries.map(([branchId, timestamp]) => {
      const normalizedBranchId = identifier(branchId);
      const normalizedTimestamp = ledgerTimestamp(timestamp);
      return normalizedBranchId && normalizedTimestamp ? [normalizedBranchId, normalizedTimestamp] : null;
    });
    return normalized.every(Boolean) ? normalized : null;
  } catch (_) {
    return null;
  }
}

function ledgerBranchPeriods(value) {
  if (!value) return [];
  if (String(value).length > 8192) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    const entries = Object.entries(parsed);
    if (entries.length < 1 || entries.length > 25) return null;
    const normalized = entries.map(([branchId, period]) => {
      const normalizedBranchId = identifier(branchId);
      if (!period || Array.isArray(period) || typeof period !== "object") return null;
      const from = ledgerTimestamp(period.from);
      const to = ledgerTimestamp(period.to);
      if (!normalizedBranchId || !from || !to || from >= to) return null;
      return [normalizedBranchId, { from, to }];
    });
    return normalized.every(Boolean) ? normalized : null;
  } catch (_) {
    return null;
  }
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

function publicOffset(row, invoicePayload = null) {
  const payload = invoicePayload || {};
  const invoiceId = row.invoice_id ?? row.invoiceId;
  return {
    id: row.id,
    invoiceId,
    invoiceNumber: payload.number || payload.invoiceNumber || payload.receiptNo || invoiceId,
    amountCents: Number(row.amount_cents ?? row.amountCents ?? 0),
    reason: row.reason || "cash_to_till",
    note: row.note || null,
    status: row.status || "active",
    offsetByName: row.offset_by_name ?? row.offsetByName ?? null,
    offsetAt: row.offset_at ?? row.offsetAt ?? null,
  };
}

function publicInvoiceOffset(row, invoicePayload = null) {
  const referenceLast4 = String(row.reference_last4 ?? row.referenceLast4 ?? "").trim().toUpperCase();
  const reversedAt = row.reversed_at ?? row.reversedAt ?? null;
  return {
    ...publicOffset(row, invoicePayload),
    transactionId: row.transaction_id ?? row.transactionId,
    referenceLast4,
    referenceMasked: referenceLast4 ? `****${referenceLast4}` : null,
    tillNumber: row.till_number ?? row.tillNumber ?? null,
    currency: row.currency || "KES",
    transactionTime: row.origination_time ?? row.originationTime ?? null,
    reversedAt,
    status: reversedAt ? "reversed" : (row.status || "active"),
  };
}

function offsetRequestFingerprint({ transactionId, branchId, offsets }) {
  return crypto.createHash("sha256").update(JSON.stringify({ transactionId, branchId, offsets })).digest("hex");
}

function offsetRowKeys(idempotencyKey, offsets) {
  if (offsets.length === 1) return [idempotencyKey];
  return offsets.map((entry, index) => crypto.createHash("sha256")
    .update(`${idempotencyKey}\u0000${index}\u0000${entry.invoiceId}`)
    .digest("hex"));
}

async function publicOffsetRows(client, rows) {
  const payloadByInvoiceId = new Map();
  for (const row of rows) {
    const invoiceId = row.invoice_id ?? row.invoiceId;
    if (payloadByInvoiceId.has(invoiceId)) continue;
    const invoice = await client.query("SELECT payload FROM events WHERE id = $1 AND type = 'invoice'", [invoiceId]);
    payloadByInvoiceId.set(invoiceId, invoice.rows[0]?.payload || {});
  }
  return rows.map((row) => publicOffset(row, payloadByInvoiceId.get(row.invoice_id ?? row.invoiceId)));
}

async function createKopokopoCashOffsets({ transactionId, offsets, branchId, note, idempotencyKey, account }) {
  const canonicalOffsets = [...offsets].sort((left, right) => left.invoiceId.localeCompare(right.invoiceId));
  const totalAmountCents = canonicalOffsets.reduce((sum, entry) => sum + entry.amountCents, 0);
  const fingerprint = offsetRequestFingerprint({ transactionId, branchId, offsets: canonicalOffsets });
  const rowKeys = offsetRowKeys(idempotencyKey, canonicalOffsets);
  return tx(async (client) => {
    const locked = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
    const transaction = locked.rows[0];
    if (!transaction) return { conflict: "kopokopo_transaction_not_found" };
    if (transactionPurpose(transaction) === "stock_funding") return { conflict: "kopokopo_transaction_is_stock_funding" };
    await attachProviderTopic(client, transaction);
    if (!transactionCanAllocate(transaction)) return { conflict: "kopokopo_transaction_not_allocatable" };

    const priorBatch = await client.query(
      "SELECT * FROM kopokopo_offset_batches WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    if (priorBatch.rows[0]) {
      const batch = priorBatch.rows[0];
      const same = (batch.transaction_id ?? batch.transactionId) === transactionId
        && (batch.branch_id ?? batch.branchId) === branchId
        && (batch.request_fingerprint ?? batch.requestFingerprint) === fingerprint;
      if (!same) return { conflict: "idempotency_key_reused" };
      const placeholders = rowKeys.map((_, index) => `$${index + 1}`).join(", ");
      const priorRows = await client.query(
        `SELECT * FROM kopokopo_offsets WHERE idempotency_key IN (${placeholders}) ORDER BY idempotency_key`,
        rowKeys
      );
      if (priorRows.rows.length !== canonicalOffsets.length) return { conflict: "kopokopo_offset_batch_incomplete" };
      const publicOffsets = await publicOffsetRows(client, priorRows.rows);
      return {
        duplicate: true,
        transaction: publicTransaction(transaction),
        offsets: publicOffsets,
        offset: publicOffsets[0] || null,
      };
    }

    const legacyPrior = await client.query(
      "SELECT * FROM kopokopo_offsets WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    if (legacyPrior.rows[0]) {
      if (canonicalOffsets.length !== 1) return { conflict: "idempotency_key_reused" };
      const row = legacyPrior.rows[0];
      const entry = canonicalOffsets[0];
      const same = (row.transaction_id ?? row.transactionId) === transactionId
        && (row.invoice_id ?? row.invoiceId) === entry.invoiceId
        && (row.branch_id ?? row.branchId) === branchId
        && Number(row.amount_cents ?? row.amountCents) === entry.amountCents;
      if (!same) return { conflict: "idempotency_key_reused" };
      const publicOffsets = await publicOffsetRows(client, [row]);
      return {
        duplicate: true,
        transaction: publicTransaction(transaction),
        offsets: publicOffsets,
        offset: publicOffsets[0] || null,
      };
    }

    if (!await repairTransactionBranch(client, transaction, branchId)) return { conflict: "kopokopo_branch_mismatch" };
    if (!transactionStatusAvailable(transaction)) {
      return { conflict: "kopokopo_transaction_unavailable" };
    }
    if (String(transaction.currency || "").toUpperCase() !== "KES") return { conflict: "kopokopo_currency_unsupported" };
    const transactionRemaining = Number(transaction.amount_cents ?? transaction.amountCents) - Number(transaction.allocated_cents ?? transaction.allocatedCents);
    if (totalAmountCents > transactionRemaining) {
      return { conflict: "kopokopo_amount_exceeds_balance", remainingCents: Math.max(0, transactionRemaining) };
    }

    const relatedEvents = await client.query(
      `SELECT id, type, payload
         FROM events
        WHERE type IN ('payment', 'invoiceVoidDecision')
          AND (branch_id = $1 OR branch_id IS NULL)`,
      [branchId]
    );
    const cashByInvoiceId = new Map();
    const voidedInvoiceIds = new Set();
    for (const row of relatedEvents.rows) {
      const payload = row.payload || {};
      const relatedInvoiceId = String(payload.invoiceId || payload.orderId || "").trim();
      if (!relatedInvoiceId) continue;
      if (row.type === "invoiceVoidDecision") {
        if (String(payload.decision || "").toLowerCase() === "approved") voidedInvoiceIds.add(relatedInvoiceId);
        continue;
      }
      if (String(payload.status || "captured").toLowerCase() !== "captured") continue;
      if (String(payload.method || "").trim().toLowerCase() !== "cash") continue;
      cashByInvoiceId.set(
        relatedInvoiceId,
        Number(cashByInvoiceId.get(relatedInvoiceId) || 0) + payloadCents(payload, "amountCents", "amount")
      );
    }

    const invoicePayloadById = new Map();
    for (const entry of canonicalOffsets) {
      const invoiceResult = await client.query(
        "SELECT id, branch_id, payload FROM events WHERE id = $1 AND type = 'invoice' FOR UPDATE",
        [entry.invoiceId]
      );
      const invoice = invoiceResult.rows[0];
      if (!invoice) return { conflict: "kopokopo_invoice_not_found", invoiceId: entry.invoiceId };
      const invoicePayload = invoice.payload || {};
      invoicePayloadById.set(entry.invoiceId, invoicePayload);
      const invoiceBranchId = String(invoice.branch_id ?? invoice.branchId ?? invoicePayload.branchId ?? "").trim();
      if (!invoiceBranchId || invoiceBranchId !== branchId) {
        return { conflict: "kopokopo_invoice_branch_mismatch", invoiceId: entry.invoiceId };
      }
      if (String(invoicePayload.status || "").toLowerCase() === "voided" || voidedInvoiceIds.has(entry.invoiceId)) {
        return { conflict: "kopokopo_invoice_voided", invoiceId: entry.invoiceId };
      }
      const cashCapturedCents = Number(cashByInvoiceId.get(entry.invoiceId) || 0);
      if (cashCapturedCents <= 0) {
        return { conflict: "kopokopo_invoice_has_no_cash_payment", invoiceId: entry.invoiceId, cashRemainingCents: 0 };
      }
      const priorOffsets = await client.query(
        `SELECT COALESCE(SUM(amount_cents), 0) AS offset_cents
           FROM kopokopo_offsets
          WHERE invoice_id = $1
            AND lower(status) = 'active'`,
        [entry.invoiceId]
      );
      const alreadyOffsetCents = Number(priorOffsets.rows[0]?.offset_cents ?? priorOffsets.rows[0]?.offsetCents ?? 0);
      const cashRemainingCents = Math.max(0, cashCapturedCents - alreadyOffsetCents);
      if (entry.amountCents > cashRemainingCents) {
        return { conflict: "kopokopo_offset_exceeds_cash_payment", invoiceId: entry.invoiceId, cashRemainingCents };
      }
    }

    await client.query(
      `INSERT INTO kopokopo_offset_batches
        (idempotency_key, transaction_id, branch_id, request_fingerprint, note, offset_by, offset_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [idempotencyKey, transactionId, branchId, fingerprint, note || null, account?.id || null, account?.name || null]
    );
    const insertedOffsets = [];
    for (let index = 0; index < canonicalOffsets.length; index += 1) {
      const entry = canonicalOffsets[index];
      const offsetId = `kpo_${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO kopokopo_offsets
          (id, transaction_id, invoice_id, branch_id, amount_cents, reason, note, offset_by, offset_by_name, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'cash_to_till', $6, $7, $8, $9)`,
        [offsetId, transactionId, entry.invoiceId, branchId, entry.amountCents, note || null, account?.id || null, account?.name || null, rowKeys[index]]
      );
      insertedOffsets.push(publicOffset({
        id: offsetId,
        invoice_id: entry.invoiceId,
        amount_cents: entry.amountCents,
        reason: "cash_to_till",
        note: note || null,
        offset_by_name: account?.name || null,
        status: "active",
        offset_at: new Date().toISOString(),
      }, invoicePayloadById.get(entry.invoiceId)));
    }
    await client.query(
      `UPDATE kopokopo_transactions
          SET allocated_cents = allocated_cents + $2, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [transactionId, totalAmountCents]
    );
    const updated = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1", [transactionId]);
    return {
      duplicate: false,
      transaction: publicTransaction(updated.rows[0]),
      offsets: insertedOffsets,
      offset: insertedOffsets[0] || null,
    };
  });
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
      if (!transaction.rows[0] || !transactionBelongsToBranch(transaction.rows[0], branchId)) {
        return { conflict: "idempotency_key_reused" };
      }
      return { duplicate: true, transaction: publicTransaction(transaction.rows[0]), allocations: prior.rows };
    }

    const locked = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
    const transaction = locked.rows[0];
    if (!transaction) return { conflict: "kopokopo_transaction_not_found" };
    if (transactionPurpose(transaction) === "stock_funding") return { conflict: "kopokopo_transaction_is_stock_funding" };
    await attachProviderTopic(client, transaction);
    if (!transactionCanAllocate(transaction)) return { conflict: "kopokopo_transaction_not_allocatable" };
    if (!await repairTransactionBranch(client, transaction, branchId)) return { conflict: "kopokopo_branch_mismatch" };
    if (!transactionStatusAvailable(transaction, [...acceptedStatuses])) {
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
    const branchStarts = ledgerBranchStarts(req.query.branchStarts);
    const branchPeriods = ledgerBranchPeriods(req.query.branchPeriods);
    const validStatuses = new Set(["all", "received", "available", "partial", "allocated", "reversed", "funding"]);

    if (!requestedBranchId || search.length > 80 || !validStatuses.has(status)) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_filters" });
    }
    if ((req.query.from && !from)
      || (req.query.to && !to)
      || branchStarts === null
      || branchPeriods === null
      || (from && to && from > to)
      || (branchStarts.length && (from || to || branchPeriods.length))
      || (branchPeriods.length && (from || to))) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_dates" });
    }
    if (branchStarts.length && !allBranches && branchStarts.some(([branchId]) => branchId !== requestedBranchId)) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_dates" });
    }
    if (branchPeriods.length && !allBranches && branchPeriods.some(([branchId]) => branchId !== requestedBranchId)) {
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
    if (branchStarts.length) {
      const branchStartClauses = branchStarts.map(([branchId, timestamp]) => (
        `(branch_id = ${addValue(branchId)} AND COALESCE(origination_time, created_at) >= ${addValue(timestamp)})`
      ));
      clauses.push(`(${branchStartClauses.join(" OR ")})`);
    }
    if (branchPeriods.length) {
      const branchPeriodClauses = branchPeriods.map(([branchId, period]) => (
        `(branch_id = ${addValue(branchId)} AND COALESCE(origination_time, created_at) > ${addValue(period.from)} AND COALESCE(origination_time, created_at) <= ${addValue(period.to)})`
      ));
      clauses.push(`(${branchPeriodClauses.join(" OR ")})`);
    }
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
        OR id IN (
          SELECT search_offset.transaction_id
            FROM kopokopo_offsets search_offset
            JOIN events search_invoice
              ON search_invoice.id = search_offset.invoice_id
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
    if (status === "received") clauses.push("lower(status) = 'received' AND reversed_at IS NULL AND purpose <> 'stock_funding'");
    if (status === "available") clauses.push("lower(status) = 'received' AND reversed_at IS NULL AND purpose <> 'stock_funding' AND allocated_cents < amount_cents");
    if (status === "partial") clauses.push("lower(status) = 'received' AND reversed_at IS NULL AND purpose <> 'stock_funding' AND allocated_cents > 0 AND allocated_cents < amount_cents");
    if (status === "allocated") clauses.push("reversed_at IS NULL AND purpose <> 'stock_funding' AND allocated_cents >= amount_cents");
    if (status === "reversed") clauses.push("reversed_at IS NOT NULL");
    if (status === "funding") clauses.push("purpose = 'stock_funding' AND reversed_at IS NULL");
    const where = clauses.length ? clauses.join(" AND ") : "1 = 1";

    const summary = await q(
      `SELECT COUNT(*) AS page_count,
              COALESCE(SUM(CASE WHEN purpose <> 'stock_funding' THEN 1 ELSE 0 END), 0) AS total_count,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN amount_cents ELSE 0 END), 0) AS total_amount_cents,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN allocated_cents ELSE 0 END), 0) AS total_allocated_cents,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN GREATEST(amount_cents - allocated_cents, 0) ELSE 0 END), 0) AS total_available_cents
         FROM kopokopo_transactions
        WHERE ${where}`,
      values
    );
    const branchSummary = await q(
      `SELECT branch_id,
              COALESCE(SUM(CASE WHEN purpose <> 'stock_funding' THEN 1 ELSE 0 END), 0) AS transaction_count,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN amount_cents ELSE 0 END), 0) AS amount_cents,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN allocated_cents ELSE 0 END), 0) AS allocated_cents,
              COALESCE(SUM(CASE WHEN reversed_at IS NULL AND lower(status) <> 'reversed' AND purpose <> 'stock_funding' THEN GREATEST(amount_cents - allocated_cents, 0) ELSE 0 END), 0) AS available_cents
         FROM kopokopo_transactions
        WHERE ${where}
        GROUP BY branch_id
        ORDER BY branch_id`,
      values
    );
    const pageValues = [...values, limit, offset];
    const result = await q(
      `SELECT id, webhook_event_id, reference_last4, amount_cents, allocated_cents, currency, status, till_number,
              branch_id, payer_name, payer_phone_last4, origination_time, reversed_at, created_at,
              purpose, purpose_changed_at, purpose_changed_by_name, purpose_note
         FROM kopokopo_transactions
        WHERE ${where}
        ORDER BY COALESCE(origination_time, created_at) ${sort}, created_at ${sort}, id ${sort}
        LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    const transactionRows = result.rows;
    if (transactionRows.length) {
      const eventIds = [...new Set(transactionRows
        .map((row) => row.webhook_event_id ?? row.webhookEventId)
        .filter(Boolean))];
      if (eventIds.length) {
        const eventPlaceholders = eventIds.map((_, index) => `$${index + 1}`).join(", ");
        const eventResult = await q(
          `SELECT event_id, topic
             FROM kopokopo_webhook_events
            WHERE event_id IN (${eventPlaceholders})`,
          eventIds
        );
        const topicsByEventId = new Map(eventResult.rows.map((row) => [
          row.event_id ?? row.eventId,
          row.topic,
        ]));
        for (const row of transactionRows) {
          const eventId = row.webhook_event_id ?? row.webhookEventId;
          row.provider_topic = topicsByEventId.get(eventId) || null;
        }
      }
    }
    const allocationsByTransaction = new Map();
    const offsetsByTransaction = new Map();
    if (transactionRows.length) {
      const transactionIds = transactionRows.map((row) => row.id);
      const transactionPlaceholders = transactionIds.map((_, index) => `$${index + 1}`).join(", ");
      const [allocationResult, offsetResult] = await Promise.all([
        q(
          `SELECT id, transaction_id, invoice_id, amount_cents, status, allocated_by_name, allocated_at
             FROM kopokopo_allocations
            WHERE transaction_id IN (${transactionPlaceholders})
            ORDER BY allocated_at, id`,
          transactionIds
        ),
        q(
          `SELECT id, transaction_id, invoice_id, amount_cents, reason, note, status, offset_by_name, offset_at
             FROM kopokopo_offsets
            WHERE transaction_id IN (${transactionPlaceholders})
            ORDER BY offset_at, id`,
          transactionIds
        ),
      ]);
      const invoiceIds = [...new Set([
        ...allocationResult.rows,
        ...offsetResult.rows,
      ].map((row) => row.invoice_id ?? row.invoiceId).filter(Boolean))];
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
      for (const offsetRow of offsetResult.rows) {
        const transactionId = offsetRow.transaction_id ?? offsetRow.transactionId;
        const invoiceId = offsetRow.invoice_id ?? offsetRow.invoiceId;
        const current = offsetsByTransaction.get(transactionId) || [];
        current.push(publicOffset(offsetRow, invoicePayloadById.get(invoiceId)));
        offsetsByTransaction.set(transactionId, current);
      }
    }
    const totals = summary.rows[0] || {};
    const amountCents = Number(totals.total_amount_cents ?? totals.totalAmountCents ?? 0);
    const allocatedCents = Number(totals.total_allocated_cents ?? totals.totalAllocatedCents ?? 0);
    const availableCents = Number(totals.total_available_cents ?? totals.totalAvailableCents ?? 0);
    return res.json({
      enabled,
      branchId: allBranches ? "all" : requestedBranchId,
      providerRequired: allBranches ? null : branchRequiresVerifiedKopokopo(config, requestedBranchId),
      transactions: transactionRows.map((row) => ({
        ...publicTransaction(row),
        allocations: allocationsByTransaction.get(row.id) || [],
        offsets: offsetsByTransaction.get(row.id) || [],
      })),
      page: {
        total: Number(totals.page_count ?? totals.pageCount ?? 0),
        limit,
        offset,
      },
      summary: {
        transactionCount: Number(totals.total_count ?? totals.totalCount ?? 0),
        amountCents,
        allocatedCents,
        remainingCents: Math.max(0, availableCents),
        branches: branchSummary.rows.map((row) => {
          const branchAmountCents = Number(row.amount_cents ?? row.amountCents ?? 0);
          const branchAllocatedCents = Number(row.allocated_cents ?? row.allocatedCents ?? 0);
          const branchAvailableCents = Number(row.available_cents ?? row.availableCents ?? 0);
          return {
            branchId: row.branch_id ?? row.branchId ?? null,
            transactionCount: Number(row.transaction_count ?? row.transactionCount ?? 0),
            amountCents: branchAmountCents,
            allocatedCents: branchAllocatedCents,
            remainingCents: Math.max(0, branchAvailableCents),
          };
        }),
      },
    });
  } catch (error) {
    console.error("Kopo Kopo transaction ledger failed:", error);
    return res.status(500).json({ error: "kopokopo_transaction_ledger_failed" });
  }
});

router.get("/invoice-offsets", requireKopokopoViewer, async (req, res) => {
  try {
    const rawInvoiceIds = String(req.query.invoiceIds || "");
    if (!rawInvoiceIds || rawInvoiceIds.length > 8000) {
      return res.status(400).json({ error: "invalid_kopokopo_invoice_ids" });
    }
    const parsedInvoiceIds = rawInvoiceIds.split(",").map(identifier);
    const invoiceIds = [...new Set(parsedInvoiceIds)];
    if (invoiceIds.length < 1 || invoiceIds.length > 50 || parsedInvoiceIds.some((invoiceId) => !invoiceId)) {
      return res.status(400).json({ error: "invalid_kopokopo_invoice_ids" });
    }

    const invoicePlaceholders = invoiceIds.map((_, index) => `$${index + 1}`).join(", ");
    const invoiceResult = await q(
      `SELECT id, branch_id, payload
         FROM events
        WHERE type = 'invoice'
          AND id IN (${invoicePlaceholders})`,
      invoiceIds
    );
    if (invoiceResult.rows.some((invoice) => !accountCanAccessBranch(req.account, invoice.branch_id ?? invoice.branchId))) {
      return res.status(403).json({ error: "branch_not_authorized" });
    }

    const accessibleInvoiceIds = invoiceResult.rows.map((invoice) => invoice.id);
    const offsetsByInvoiceId = Object.fromEntries(invoiceIds.map((invoiceId) => [invoiceId, []]));
    if (!accessibleInvoiceIds.length) return res.json({ offsetsByInvoiceId });

    const accessiblePlaceholders = accessibleInvoiceIds.map((_, index) => `$${index + 1}`).join(", ");
    const offsetResult = await q(
      `SELECT offset_row.id, offset_row.transaction_id, offset_row.invoice_id,
              offset_row.amount_cents, offset_row.reason, offset_row.note, offset_row.status,
              offset_row.offset_by_name, offset_row.offset_at,
              transaction_row.reference_last4, transaction_row.till_number, transaction_row.currency,
              transaction_row.origination_time, transaction_row.reversed_at
         FROM kopokopo_offsets offset_row
         JOIN kopokopo_transactions transaction_row ON transaction_row.id = offset_row.transaction_id
        WHERE offset_row.invoice_id IN (${accessiblePlaceholders})
        ORDER BY offset_row.offset_at, offset_row.id`,
      accessibleInvoiceIds
    );
    const payloadByInvoiceId = new Map(invoiceResult.rows.map((invoice) => [invoice.id, invoice.payload || {}]));
    for (const offsetRow of offsetResult.rows) {
      const invoiceId = offsetRow.invoice_id ?? offsetRow.invoiceId;
      offsetsByInvoiceId[invoiceId].push(publicInvoiceOffset(offsetRow, payloadByInvoiceId.get(invoiceId)));
    }
    return res.json({ offsetsByInvoiceId });
  } catch (error) {
    console.error("Kopo Kopo invoice offset audit failed:", error);
    return res.status(500).json({ error: "kopokopo_invoice_offset_audit_failed" });
  }
});

router.post("/transactions/:id/purpose", requireOwnerOrAdmin, async (req, res) => {
  try {
    const transactionId = identifier(req.params.id);
    const purpose = String(req.body?.purpose || "").trim().toLowerCase();
    const note = String(req.body?.note || "").trim();
    if (!transactionId || !["customer_payment", "stock_funding"].includes(purpose) || note.length > 500) {
      return res.status(400).json({ error: "invalid_kopokopo_transaction_purpose" });
    }

    const result = await tx(async (client) => {
      const locked = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      const transaction = locked.rows[0];
      if (!transaction) return { notFound: true };
      const branchId = String(transaction.branch_id ?? transaction.branchId ?? "").trim();
      if (!accountCanAccessBranch(req.account, branchId)) return { forbidden: true };
      const previousPurpose = transactionPurpose(transaction);
      if (previousPurpose === purpose) {
        await attachProviderTopic(client, transaction);
        return { duplicate: true, branchId, transaction: publicTransaction(transaction) };
      }
      if (Number(transaction.allocated_cents ?? transaction.allocatedCents ?? 0) > 0) {
        return { conflict: "kopokopo_transaction_has_allocations" };
      }

      await client.query(
        `UPDATE kopokopo_transactions
            SET purpose = $2,
                purpose_changed_at = ${isMySql ? "NOW()" : "now()"},
                purpose_changed_by = $3,
                purpose_changed_by_name = $4,
                purpose_note = $5,
                updated_at = ${isMySql ? "NOW()" : "now()"}
          WHERE id = $1`,
        [transactionId, purpose, req.account?.id || null, req.account?.name || null, note || null]
      );
      await client.query(
        `INSERT INTO kopokopo_transaction_purpose_events
          (id, transaction_id, from_purpose, to_purpose, note, changed_by, changed_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [`kpp_${crypto.randomUUID()}`, transactionId, previousPurpose, purpose, note || null, req.account?.id || null, req.account?.name || null]
      );
      const updated = await client.query("SELECT * FROM kopokopo_transactions WHERE id = $1", [transactionId]);
      await attachProviderTopic(client, updated.rows[0]);
      return { duplicate: false, branchId, transaction: publicTransaction(updated.rows[0]) };
    });

    if (result.notFound) return res.status(404).json({ error: "kopokopo_transaction_not_found" });
    if (result.forbidden) return res.status(403).json({ error: "branch_not_authorized" });
    if (result.conflict) return res.status(409).json({ error: result.conflict });
    if (!result.duplicate) {
      publishRealtimeEvent("kopokopo", {
        source: "kopokopo",
        branchId: result.branchId,
        accepted: 1,
        types: ["kopokopoPurpose"],
      });
    }
    return res.json({ duplicate: result.duplicate, transaction: result.transaction });
  } catch (error) {
    console.error("Kopo Kopo transaction classification failed:", error);
    return res.status(500).json({ error: "kopokopo_transaction_classification_failed" });
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
      `SELECT transaction_row.id, transaction_row.webhook_event_id, transaction_row.reference_last4,
              transaction_row.amount_cents, transaction_row.allocated_cents, transaction_row.currency,
              transaction_row.status, transaction_row.till_number, transaction_row.branch_id,
              transaction_row.payer_name, transaction_row.payer_phone_last4, transaction_row.origination_time,
              transaction_row.reversed_at, transaction_row.purpose, event_row.topic AS provider_topic
         FROM kopokopo_transactions transaction_row
         LEFT JOIN kopokopo_webhook_events event_row ON event_row.event_id = transaction_row.webhook_event_id
        WHERE transaction_row.reference_last4 = $1
          AND lower(transaction_row.status) IN ('received', 'complete', 'completed', 'success')
          AND transaction_row.reversed_at IS NULL
          AND transaction_row.purpose <> 'stock_funding'
          AND transaction_row.allocated_cents < transaction_row.amount_cents
        ORDER BY transaction_row.origination_time DESC, transaction_row.created_at DESC
        LIMIT 100`,
      [last4]
    );
    const transactions = result.rows
      .filter((transaction) => transactionBelongsToBranch(transaction, branchId))
      .filter(transactionCanAllocate)
      .slice(0, 20)
      .map(publicTransaction);
    return res.json({ enabled: true, providerRequired, transactions });
  } catch (error) {
    console.error("Kopo Kopo lookup failed:", error);
    return res.status(500).json({ error: "kopokopo_lookup_failed" });
  }
});

router.post("/offsets", requireAdminOrSupervisor, async (req, res) => {
  try {
    if (!kopokopoEnabled()) return res.status(409).json({ error: "kopokopo_disabled" });
    const transactionId = identifier(req.body?.transactionId);
    const branchId = identifier(req.body?.branchId);
    const idempotencyKey = identifier(req.body?.idempotencyKey);
    const note = String(req.body?.note || "").trim();
    const requested = Array.isArray(req.body?.offsets)
      ? req.body.offsets
      : [{ invoiceId: req.body?.invoiceId, amountCents: req.body?.amountCents }];
    const offsets = requested.map((entry) => ({
      invoiceId: identifier(entry?.invoiceId),
      amountCents: integerCents(entry?.amountCents),
    }));
    const uniqueInvoiceIds = new Set(offsets.map((entry) => entry.invoiceId));
    const totalAmountCents = offsets.reduce((sum, entry) => sum + entry.amountCents, 0);
    if (!transactionId || !branchId || !idempotencyKey || note.length > 500
      || offsets.length < 1 || offsets.length > 50
      || offsets.some((entry) => !entry.invoiceId || !entry.amountCents)
      || uniqueInvoiceIds.size !== offsets.length
      || !Number.isSafeInteger(totalAmountCents)) {
      return res.status(400).json({ error: "invalid_kopokopo_offset_request" });
    }
    if (!accountCanAccessBranch(req.account, branchId)) return res.status(403).json({ error: "branch_not_authorized" });
    const result = await createKopokopoCashOffsets({
      transactionId,
      offsets,
      branchId,
      note,
      idempotencyKey,
      account: req.account,
    });
    if (result.conflict) {
      return res.status(409).json({
        error: result.conflict,
        remainingCents: result.remainingCents,
        invoiceId: result.invoiceId,
        cashRemainingCents: result.cashRemainingCents,
      });
    }
    if (!result.duplicate) {
      publishRealtimeEvent("kopokopo", {
        source: "kopokopo",
        branchId,
        accepted: 1,
        types: ["kopokopoOffset"],
      });
    }
    return res.json(result);
  } catch (error) {
    console.error("Kopo Kopo cash offset failed:", error);
    return res.status(500).json({ error: "kopokopo_offset_failed" });
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

