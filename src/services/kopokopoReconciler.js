import { ready } from "../db.js";
import {
  kopokopoConfig,
  kopokopoConfigs,
  kopokopoEnabled,
  kopokopoTransactionEvent,
  parseKopokopoWebhook,
  pollKopokopoTransactions,
} from "./kopokopo.js";
import { storeKopokopoEvent } from "./kopokopoLedger.js";

const startupLookbackMs = 24 * 60 * 60 * 1000;
const overlapMs = 5 * 60 * 1000;
let intervalTimer = null;
let startupTimer = null;
let activeRun = null;
const lastCompletedAt = new Map();

export async function ingestKopokopoPollingTransactions(transactions, config = kopokopoConfig()) {
  const polledAt = new Date().toISOString();
  const summary = { received: Array.isArray(transactions) ? transactions.length : 0, stored: 0, duplicates: 0, ignored: 0 };
  for (const [index, transaction] of (Array.isArray(transactions) ? transactions : []).entries()) {
    const body = kopokopoTransactionEvent(transaction, { index, eventTime: polledAt });
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
  const configs = kopokopoConfigs().filter((config) => config.enabled);
  if (!configs.length) return { skipped: true, reason: "disabled" };
  await ready;
  const to = new Date();
  const total = { received: 0, stored: 0, duplicates: 0, ignored: 0, accounts: [] };
  for (const config of configs) {
    const fallbackFrom = new Date(to.getTime() - Math.max(overlapMs, Number(lookbackMs) || startupLookbackMs));
    const previous = lastCompletedAt.get(config.accountId);
    const from = previous ? new Date(previous.getTime() - overlapMs) : fallbackFrom;
    const polled = await pollKopokopoTransactions({
      fromTime: from.toISOString(),
      toTime: to.toISOString(),
      timeoutMs: Number(process.env.KOPOKOPO_POLL_TIMEOUT_MS || 300_000),
    }, config);
    const summary = await ingestKopokopoPollingTransactions(polled.transactions, config);
    for (const key of ["received", "stored", "duplicates", "ignored"]) total[key] += Number(summary[key] || 0);
    total.accounts.push({ accountId: config.accountId, ...summary });
    lastCompletedAt.set(config.accountId, to);
  }
  return { ...total, toTime: to.toISOString() };
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
  if (intervalTimer || startupTimer || !kopokopoEnabled() || process.env.KOPOKOPO_POLLING_ENABLED !== "1" || process.env.NODE_ENV === "test") return;
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
