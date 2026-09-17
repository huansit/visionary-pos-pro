import { pool, q } from "../src/db.js";

const branchId = String(process.argv.find((argument) => argument.startsWith("--branch=")) || "").slice(9).trim();

function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}
function text(value) { return String(value ?? "").trim(); }
function timeOf(row, payload) {
  const value = Number(payload.reviewedAt || payload.ts || row.client_ts || row.server_ts || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

try {
  const [debtsResult, reviewsResult, paymentsResult] = await Promise.all([
    q("SELECT id, branch_id, client_ts, server_ts, payload FROM events WHERE type = 'cashierJointDebt' ORDER BY server_ts DESC, id DESC"),
    q("SELECT id, branch_id, client_ts, server_ts, payload FROM events WHERE type = 'cashierJointDebtReview' ORDER BY server_ts DESC, id DESC"),
    q("SELECT id, branch_id, client_ts, server_ts, payload FROM events WHERE type = 'cashierJointDebtPayment' ORDER BY server_ts DESC, id DESC"),
  ]);
  const reviewsByDebt = new Map();
  for (const row of reviewsResult.rows) {
    const payload = payloadOf(row);
    const debtId = text(payload.debtId);
    const decision = text(payload.decision).toLowerCase();
    const reviewedAt = timeOf(row, payload);
    if (!debtId || !["approved", "written_off"].includes(decision)) continue;
    const current = reviewsByDebt.get(debtId);
    if (!current || reviewedAt >= current.reviewedAt) reviewsByDebt.set(debtId, { decision, reviewedAt, reviewedBy: text(payload.reviewedBy) || "Unknown" });
  }
  const paidByDebt = new Map();
  for (const row of paymentsResult.rows) {
    const payload = payloadOf(row);
    if (text(payload.status || "captured").toLowerCase() !== "captured") continue;
    const debtId = text(payload.debtId);
    const amountCents = Math.max(0, Number(payload.amountCents) || 0);
    if (debtId && amountCents) paidByDebt.set(debtId, (paidByDebt.get(debtId) || 0) + amountCents);
  }
  const rows = debtsResult.rows.map((row) => {
    const payload = payloadOf(row);
    const id = text(row.id);
    const review = reviewsByDebt.get(id);
    const originalStatus = text(payload.status || "open").toLowerCase();
    const effectiveStatus = review?.decision || originalStatus;
    const totalCents = Math.max(0, Number(payload.totalCents) || 0);
    const paidCents = Math.min(totalCents, paidByDebt.get(id) || 0);
    return {
      id,
      branchId: text(row.branch_id || payload.branchId),
      stockCountCode: text(payload.stockCountCode) || "-",
      source: text(payload.source) || "stock_count",
      originalStatus,
      effectiveStatus,
      chargeable: ["open", "approved"].includes(effectiveStatus),
      totalCents,
      paidCents,
      outstandingCents: Math.max(0, totalCents - paidCents),
      cashiers: Array.isArray(payload.shares) ? payload.shares.map((share) => text(share.cashierName || share.cashierId)).filter(Boolean) : [],
      createdBy: text(payload.createdBy) || "Unknown",
      createdAt: timeOf(row, payload) ? new Date(timeOf(row, payload)).toISOString() : "unknown",
      review: review ? { decision: review.decision, reviewedBy: review.reviewedBy, reviewedAt: new Date(review.reviewedAt).toISOString() } : null,
    };
  }).filter((row) => !branchId || row.branchId === branchId);
  const summary = rows.reduce((totals, row) => ({
    records: totals.records + 1,
    chargeableOutstandingCents: totals.chargeableOutstandingCents + (row.chargeable ? row.outstandingCents : 0),
    awaitingReviewCents: totals.awaitingReviewCents + (row.effectiveStatus === "pending_review" ? row.outstandingCents : 0),
    legacyAutomaticOpenCents: totals.legacyAutomaticOpenCents + (row.originalStatus === "open" && !row.review && ["stock_count", "quick_inventory"].includes(row.source) ? row.outstandingCents : 0),
  }), { records: 0, chargeableOutstandingCents: 0, awaitingReviewCents: 0, legacyAutomaticOpenCents: 0 });
  console.log(JSON.stringify({ mode: "read-only", branchId: branchId || "all", summary, debts: rows }, null, 2));
  console.log("No debts, stock movements, or payments were changed.");
} finally {
  await pool.end();
}
