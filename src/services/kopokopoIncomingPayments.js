import crypto from "node:crypto";
import { isMySql, q, ready, tx } from "../db.js";
import {
  branchForTill,
  kopokopoConfig,
  maxIncomingPaymentCents,
  normalizeKopokopoCallback,
  parseKopokopoWebhook,
  readKopokopoIncomingPayment,
  requestKopokopoAccessToken,
  requestKopokopoIncomingPayment,
  tillForBranch,
} from "./kopokopo.js";
import { storeKopokopoEvent } from "./kopokopoLedger.js";

const requestLifetimeMs = 30 * 60 * 1000;
const terminalStatuses = new Set(["completed", "failed", "expired"]);
const permanentRecoveryErrors = new Set([
  "invalid_kopokopo_incoming_payment_result",
  "kopokopo_result_branch_mismatch",
  "kopokopo_result_till_mismatch",
  "kopokopo_result_amount_mismatch",
  "kopokopo_result_currency_unsupported",
]);
let intervalTimer = null;
let startupTimer = null;
let activeRun = null;

function text(value) {
  return String(value ?? "").trim();
}

function rowValue(row, snake, camel) {
  return row?.[snake] ?? row?.[camel] ?? null;
}

function publicRequest(row) {
  return {
    id: row?.id,
    branchId: rowValue(row, "branch_id", "branchId"),
    tillNumber: rowValue(row, "till_number", "tillNumber"),
    amountCents: Number(rowValue(row, "amount_cents", "amountCents") || 0),
    currency: row?.currency || "KES",
    status: row?.status || "unknown",
    providerStatus: rowValue(row, "provider_status", "providerStatus"),
    providerRequestId: rowValue(row, "provider_request_id", "providerRequestId"),
    providerTransactionId: rowValue(row, "provider_transaction_id", "providerTransactionId"),
    attempts: Number(row?.attempts || 0),
    createdAt: rowValue(row, "created_at", "createdAt"),
    updatedAt: rowValue(row, "updated_at", "updatedAt"),
    completedAt: rowValue(row, "completed_at", "completedAt"),
  };
}

async function findRequestById(id) {
  const result = await q("SELECT * FROM kopokopo_incoming_payment_requests WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] || null;
}

export async function getKopokopoIncomingPaymentRequest(id) {
  const row = await findRequestById(id);
  return row ? publicRequest(row) : null;
}

async function reserveRequest({ id, idempotencyKey, branchId, tillNumber, amountCents, createdBy, expiresAt }) {
  return tx(async (client) => {
    const existing = await client.query(
      "SELECT * FROM kopokopo_incoming_payment_requests WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    if (existing.rows[0]) return { inserted: false, row: existing.rows[0] };
    let inserted = false;
    if (isMySql) {
      const result = await client.query(
        `INSERT IGNORE INTO kopokopo_incoming_payment_requests
          (id, idempotency_key, branch_id, till_number, amount_cents, currency, status, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, 'KES', 'creating', $6, $7)`,
        [id, idempotencyKey, branchId, tillNumber, amountCents, expiresAt, createdBy || null]
      );
      inserted = Number(result.raw?.affectedRows || 0) === 1;
    } else {
      const result = await client.query(
        `INSERT INTO kopokopo_incoming_payment_requests
          (id, idempotency_key, branch_id, till_number, amount_cents, currency, status, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, 'KES', 'creating', $6, $7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [id, idempotencyKey, branchId, tillNumber, amountCents, expiresAt, createdBy || null]
      );
      inserted = Boolean(result.rows[0]);
    }
    const selected = await client.query(
      "SELECT * FROM kopokopo_incoming_payment_requests WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    return { inserted, row: selected.rows[0] || null };
  });
}

function validateRequestInput(input, config) {
  const idempotencyKey = text(input?.idempotencyKey);
  const branchId = text(input?.branchId);
  const tillNumber = tillForBranch(branchId, config);
  const amountCents = Number(input?.amountCents);
  if (!/^[A-Za-z0-9._:-]{8,191}$/.test(idempotencyKey)) throw new Error("invalid_kopokopo_idempotency_key");
  if (!branchId || !Number.isSafeInteger(amountCents)
      || amountCents <= 0 || amountCents > maxIncomingPaymentCents) {
    throw new Error("invalid_kopokopo_incoming_payment");
  }
  if (!tillNumber) throw new Error("kopokopo_branch_till_not_configured");
  if (branchForTill(tillNumber, config) !== branchId) throw new Error("kopokopo_till_branch_mismatch");
  return { idempotencyKey, branchId, tillNumber, amountCents };
}

export async function createTrackedKopokopoIncomingPayment(input, config = kopokopoConfig()) {
  const validated = validateRequestInput(input, config);
  await ready;
  const id = `kpr_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + requestLifetimeMs);
  const reserved = await reserveRequest({
    id,
    ...validated,
    createdBy: text(input?.createdBy),
    expiresAt,
  });
  if (!reserved.inserted) {
    const sameRequest = rowValue(reserved.row, "branch_id", "branchId") === validated.branchId
      && rowValue(reserved.row, "till_number", "tillNumber") === validated.tillNumber
      && Number(rowValue(reserved.row, "amount_cents", "amountCents")) === validated.amountCents;
    if (!sameRequest) throw new Error("kopokopo_idempotency_key_reused");
    return { duplicate: true, request: publicRequest(reserved.row) };
  }

  try {
    const provider = await requestKopokopoIncomingPayment({
      tillNumber: validated.tillNumber,
      phoneNumber: input?.phoneNumber,
      amountCents: validated.amountCents,
      firstName: input?.firstName,
      lastName: input?.lastName,
      reference: input?.reference || id,
      notes: input?.notes,
    }, config);
    await q(
      `UPDATE kopokopo_incoming_payment_requests
          SET status = 'pending', provider_status = 'Accepted', provider_location = $2,
              provider_request_id = $3, next_check_at = $4, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [id, provider.location, provider.providerRequestId, new Date()]
    );
    return { duplicate: false, request: publicRequest(await findRequestById(id)) };
  } catch (error) {
    await q(
      `UPDATE kopokopo_incoming_payment_requests
          SET status = 'failed', last_error = $2, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [id, text(error?.message).slice(0, 255) || "kopokopo_incoming_payment_request_failed"]
    );
    throw error;
  }
}

function recoveryEvent(attributes) {
  const callback = normalizeKopokopoCallback({
    data: {
      type: "incoming_payment",
      attributes,
    },
  });
  return callback.events[0] || null;
}

export async function ingestKopokopoIncomingPaymentStatus(attributes, expected = {}, config = kopokopoConfig()) {
  const body = recoveryEvent(attributes);
  if (!body) return { stored: false, pending: true, providerStatus: text(attributes?.status) || "Pending" };
  const parsed = parseKopokopoWebhook(body, config);
  if (!parsed.supported || !parsed.valid) throw new Error("invalid_kopokopo_incoming_payment_result");
  if (expected.branchId && parsed.branchId !== expected.branchId) throw new Error("kopokopo_result_branch_mismatch");
  if (expected.tillNumber && parsed.tillNumber !== expected.tillNumber) throw new Error("kopokopo_result_till_mismatch");
  if (expected.amountCents && parsed.amountCents !== Number(expected.amountCents)) throw new Error("kopokopo_result_amount_mismatch");
  if (parsed.currency !== "KES") throw new Error("kopokopo_result_currency_unsupported");
  const stored = await storeKopokopoEvent(parsed, body);
  return {
    stored: !stored.duplicate,
    duplicate: stored.duplicate,
    pending: false,
    providerStatus: text(attributes?.status) || parsed.status,
    transactionId: parsed.resourceId,
  };
}

function retryDelayMs(attempts) {
  return Math.min(60_000, 2_000 * (2 ** Math.min(Math.max(0, attempts), 5)));
}

export async function reconcileKopokopoIncomingPaymentRequest(id, config = kopokopoConfig(), suppliedAccessToken = "") {
  const request = await findRequestById(id);
  if (!request) throw new Error("kopokopo_incoming_payment_not_found");
  if (terminalStatuses.has(text(request.status).toLowerCase())) return publicRequest(request);
  const nextCheckAt = new Date(rowValue(request, "next_check_at", "nextCheckAt") || 0).getTime();
  if (Number.isFinite(nextCheckAt) && nextCheckAt > Date.now()) return publicRequest(request);
  const expiresAt = new Date(rowValue(request, "expires_at", "expiresAt") || 0).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await q(
      `UPDATE kopokopo_incoming_payment_requests
          SET status = 'expired', next_check_at = NULL, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [id]
    );
    return publicRequest(await findRequestById(id));
  }
  const location = rowValue(request, "provider_location", "providerLocation");
  if (!location) return publicRequest(request);
  const attempts = Number(request.attempts || 0) + 1;
  try {
    const attributes = await readKopokopoIncomingPayment(location, config, suppliedAccessToken);
    const providerStatus = text(attributes?.status) || "Pending";
    const providerFailed = providerStatus.toLowerCase() === "failed";
    if (providerFailed) {
      await q(
        `UPDATE kopokopo_incoming_payment_requests
            SET status = 'failed', provider_status = $2, attempts = $3, next_check_at = NULL,
                last_error = 'kopokopo_provider_payment_failed', updated_at = ${isMySql ? "NOW()" : "now()"}
          WHERE id = $1`,
        [id, providerStatus, attempts]
      );
      return publicRequest(await findRequestById(id));
    }
    const recovered = await ingestKopokopoIncomingPaymentStatus(attributes, {
      branchId: rowValue(request, "branch_id", "branchId"),
      tillNumber: rowValue(request, "till_number", "tillNumber"),
      amountCents: rowValue(request, "amount_cents", "amountCents"),
    }, config);
    if (!recovered.pending) {
      await q(
        `UPDATE kopokopo_incoming_payment_requests
            SET status = 'completed', provider_status = $2, provider_transaction_id = $3,
                attempts = $4, next_check_at = NULL, last_error = NULL,
                completed_at = ${isMySql ? "NOW()" : "now()"}, updated_at = ${isMySql ? "NOW()" : "now()"}
          WHERE id = $1`,
        [id, recovered.providerStatus, recovered.transactionId, attempts]
      );
      return publicRequest(await findRequestById(id));
    }
    await q(
      `UPDATE kopokopo_incoming_payment_requests
          SET status = 'pending', provider_status = $2, attempts = $3, next_check_at = $4,
              last_error = NULL, updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [id, providerStatus, attempts, new Date(Date.now() + retryDelayMs(attempts))]
    );
  } catch (error) {
    const permanentFailure = permanentRecoveryErrors.has(error?.message);
    await q(
      `UPDATE kopokopo_incoming_payment_requests
          SET status = $2, attempts = $3, next_check_at = $4, last_error = $5,
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [
        id,
        permanentFailure ? "failed" : "retrying",
        attempts,
        permanentFailure ? null : new Date(Date.now() + retryDelayMs(attempts)),
        text(error?.message).slice(0, 255),
      ]
    );
  }
  return publicRequest(await findRequestById(id));
}

async function dueRequestIds(limit = 10) {
  const result = await q(
    `SELECT id
       FROM kopokopo_incoming_payment_requests
      WHERE lower(status) IN ('pending', 'retrying')
        AND next_check_at IS NOT NULL
        AND next_check_at <= ${isMySql ? "NOW()" : "now()"}
        AND expires_at > ${isMySql ? "NOW()" : "now()"}
      ORDER BY next_check_at
      LIMIT ${Math.max(1, Math.min(Number(limit) || 10, 25))}`
  );
  return result.rows.map((row) => row.id);
}

export async function reconcilePendingKopokopoIncomingPayments(config = kopokopoConfig()) {
  if (!config.enabled) return { checked: 0 };
  await ready;
  const ids = await dueRequestIds();
  if (!ids.length) return { checked: 0 };
  const accessToken = await requestKopokopoAccessToken(config);
  for (const id of ids) {
    await reconcileKopokopoIncomingPaymentRequest(id, config, accessToken);
  }
  return { checked: ids.length };
}

async function scheduledReconciliation() {
  if (activeRun) return activeRun;
  activeRun = reconcilePendingKopokopoIncomingPayments()
    .catch((error) => {
      console.error("[kopokopo] incoming-payment recovery failed:", error.message);
    })
    .finally(() => {
      activeRun = null;
    });
  return activeRun;
}

export function startKopokopoIncomingPaymentReconciler() {
  const config = kopokopoConfig();
  if (intervalTimer || startupTimer || !config.enabled || process.env.NODE_ENV === "test") return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    scheduledReconciliation();
  }, 5_000);
  startupTimer.unref?.();
  intervalTimer = setInterval(scheduledReconciliation, 15_000);
  intervalTimer.unref?.();
}

export function stopKopokopoIncomingPaymentReconciler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
}

export { publicRequest as publicKopokopoIncomingPaymentRequest };
