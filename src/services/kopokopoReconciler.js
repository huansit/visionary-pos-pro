import { ready } from "../db.js";
import {
  kopokopoConfig,
  parseKopokopoWebhook,
  pollKopokopoTransactions,
} from "./kopokopo.js";
import { storeKopokopoEvent } from "./kopokopoLedger.js";

const startupLookbackMs = 24 * 60 * 60 * 1000;
const overlapMs = 5 * 60 * 1000;
let intervalTimer = null;
let startupTimer = null;
let activeRun = null;
let lastCompletedAt = null;

function providerEvent(transaction, index, polledAt) {
  const resource = transaction?.resource;
  if (String(transaction?.type || "").trim().toLowerCase() !== "buygoods transaction" || !resource?.id) {
    return null;
  }
  const status = String(resource.status || "").trim().toLowerCase();
  if (status !== "received" && status !== "reversed") return null;
  const reversed = status === "reversed";
  return {
    topic: reversed ? "buygoods_transaction_reversed" : "buygoods_transaction_received",
    id: `poll:${resource.id}:${status}`,
    created_at: resource.origination_time || polledAt,
    event: {
      type: transaction.type,
      resource,
    },
    _links: { source: "kopokopo_polling", index },
  };
}

export async function ingestKopokopoPollingTransactions(transactions, config = kopokopoConfig()) {
  const polledAt = new Date().toISOString();
  const summary = { received: Array.isArray(transactions) ? transactions.length : 0, stored: 0, duplicates: 0, ignored: 0 };
  for (const [index, transaction] of (Array.isArray(transactions) ? transactions : []).entries()) {
    const body = providerEvent(transaction, index, polledAt);
    if (!body) {
      summary.ignored += 1;
      continue;
    }
    const parsed = parseKopokopoWebhook(body, config);
    if (!parsed.supported || !parsed.valid) {
      summary.ignored += 1;
      continue;
    }
    const result = await storeKopokopoEvent(parsed, body);
    if (result.duplicate) summary.duplicates += 1;
    else summary.stored += 1;
  }
  return summary;
}

async function runReconciliation({ lookbackMs } = {}) {
  const config = kopokopoConfig();
  if (!config.enabled) return { skipped: true, reason: "disabled" };
  await ready;
  const to = new Date();
  const fallbackFrom = new Date(to.getTime() - Math.max(overlapMs, Number(lookbackMs) || startupLookbackMs));
  const from = lastCompletedAt
    ? new Date(lastCompletedAt.getTime() - overlapMs)
    : fallbackFrom;
  const polled = await pollKopokopoTransactions({
    fromTime: from.toISOString(),
    toTime: to.toISOString(),
  }, config);
  const summary = await ingestKopokopoPollingTransactions(polled.transactions, config);
  lastCompletedAt = to;
  return { ...summary, fromTime: from.toISOString(), toTime: to.toISOString() };
}

export function reconcileKopokopoTransactions(options = {}) {
  if (activeRun) return activeRun;
  activeRun = runReconciliation(options).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

async function scheduledReconciliation() {
  try {
    const summary = await reconcileKopokopoTransactions();
    if (summary.stored > 0) {
      console.log(`[kopokopo] polling recovered ${summary.stored} transaction(s)`);
    }
  } catch (error) {
    console.error("[kopokopo] polling recovery failed:", error.message, error.providerStatus || "", error.providerMessage || "");
  }
}

export function startKopokopoReconciler() {
  const config = kopokopoConfig();
  if (intervalTimer || startupTimer || !config.enabled || process.env.KOPOKOPO_POLLING_ENABLED === "0" || process.env.NODE_ENV === "test") return;
  const requestedInterval = Number(process.env.KOPOKOPO_POLL_INTERVAL_MS || 120_000);
  const intervalMs = Math.max(60_000, Math.min(Number.isFinite(requestedInterval) ? requestedInterval : 120_000, 15 * 60_000));
  startupTimer = setTimeout(() => {
    startupTimer = null;
    scheduledReconciliation();
  }, 5_000);
  startupTimer.unref?.();
  intervalTimer = setInterval(scheduledReconciliation, intervalMs);
  intervalTimer.unref?.();
}

export function stopKopokopoReconciler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
}
