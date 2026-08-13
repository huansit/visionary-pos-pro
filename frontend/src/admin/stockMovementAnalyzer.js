const DEFAULTS = Object.freeze({
  fastWeeklyUnits: 7,
  mediumWeeklyUnits: 2,
  fastCoverDays: 14,
  mediumCoverDays: 21,
  slowCoverDays: 28,
});

function whole(value, minimum = 0) {
  return Math.max(minimum, Math.floor(Number(value) || 0));
}

function movementTier(weeklyDemand, settings) {
  if (weeklyDemand >= settings.fastWeeklyUnits) return "fast";
  if (weeklyDemand >= settings.mediumWeeklyUnits) return "medium";
  return "slow";
}

function coverTargetDays(tier, settings) {
  if (tier === "fast") return settings.fastCoverDays;
  if (tier === "medium") return settings.mediumCoverDays;
  return settings.slowCoverDays;
}

function urgencyFor(row) {
  if (row.onHand <= 0 && row.soldUnits > 0) return "critical";
  if (row.daysCover !== null && row.daysCover <= 3) return "critical";
  if (row.onHand <= row.reorderLevel || (row.daysCover !== null && row.daysCover <= 7)) return "high";
  return "watch";
}

function urgencyScore(urgency) {
  if (urgency === "critical") return 3;
  if (urgency === "high") return 2;
  return 1;
}

export function analyzeStockMovements(rows = [], options = {}) {
  const settings = { ...DEFAULTS, ...(options.settings || {}) };
  const lookbackDays = Math.max(1, Number(options.lookbackDays) || 28);
  const prepared = (rows || []).map((source, index) => {
    const soldUnits = Math.max(0, Number(source?.soldUnits) || 0);
    const dailyDemand = soldUnits / lookbackDays;
    const weeklyDemand = dailyDemand * 7;
    const tier = movementTier(weeklyDemand, settings);
    const targetCoverDays = coverTargetDays(tier, settings);
    const reorderLevel = whole(source?.reorderLevel);
    const onHand = Math.floor(Number(source?.onHand) || 0);
    const purchaseIncomingQty = whole(source?.purchaseIncomingQty ?? source?.incomingQty);
    const pendingTransferIncomingQty = whole(source?.pendingTransferIncomingQty);
    const incomingQty = purchaseIncomingQty + pendingTransferIncomingQty;
    const reservedOutgoingQty = whole(source?.reservedOutgoingQty);
    const targetStock = Math.max(reorderLevel, Math.ceil(dailyDemand * targetCoverDays));
    const needQty = Math.max(0, targetStock - onHand);
    const daysCover = dailyDemand > 0 ? Math.max(0, onHand) / dailyDemand : null;
    const row = {
      ...source,
      id: String(source?.id || `${source?.productKey || source?.productId || index}:${source?.branchId || index}`),
      productKey: String(source?.productKey || source?.productId || index),
      onHand,
      incomingQty,
      purchaseIncomingQty,
      pendingTransferIncomingQty,
      reservedOutgoingQty,
      soldUnits,
      reorderLevel,
      dailyDemand,
      weeklyDemand,
      tier,
      targetCoverDays,
      targetStock,
      needQty,
      daysCover,
      costCents: Math.max(0, Number(source?.costCents) || 0),
    };
    return { ...row, urgency: urgencyFor(row) };
  });

  const remainingSurplus = new Map(prepared.map((row) => [
    row.id,
    Math.max(0, row.onHand - row.targetStock - row.reservedOutgoingQty),
  ]));
  const needs = prepared
    .filter((row) => (row.tier === "fast" || row.tier === "medium") && row.needQty > 0)
    .sort((a, b) => urgencyScore(b.urgency) - urgencyScore(a.urgency)
      || b.weeklyDemand - a.weeklyDemand
      || b.needQty - a.needQty);

  const recommendations = needs.map((destination) => {
    let remainingNeed = destination.needQty;
    const incomingApplied = Math.min(destination.incomingQty, remainingNeed);
    remainingNeed -= incomingApplied;
    const transfers = prepared
      .filter((source) => source.productKey === destination.productKey
        && source.branchId !== destination.branchId
        && (remainingSurplus.get(source.id) || 0) > 0)
      .sort((a, b) => (remainingSurplus.get(b.id) || 0) - (remainingSurplus.get(a.id) || 0))
      .map((source) => {
        const available = remainingSurplus.get(source.id) || 0;
        const qty = Math.min(available, remainingNeed);
        if (qty <= 0) return null;
        remainingSurplus.set(source.id, available - qty);
        remainingNeed -= qty;
        return {
          sourceBranchId: source.branchId,
          sourceBranchName: source.branchName,
          sourceProductId: source.productId,
          qty,
          sourceOnHand: source.onHand,
          sourceReserve: source.targetStock,
          sourceReservedOutgoingQty: source.reservedOutgoingQty,
          sourceAvailableBeforeTransfer: available,
          sourceAvailableAfterTransfer: available - qty,
          sourceWeeklyDemand: source.weeklyDemand,
          costCents: source.costCents,
        };
      })
      .filter(Boolean);

    const transferQty = transfers.reduce((sum, transfer) => sum + transfer.qty, 0);
    const reorderQty = Math.max(0, remainingNeed);
    const action = transferQty > 0 && reorderQty > 0
      ? "transfer_reorder"
      : transferQty > 0
        ? "transfer"
        : reorderQty > 0
          ? "reorder"
          : "incoming";
    return {
      ...destination,
      transfers,
      transferQty,
      incomingApplied,
      reorderQty,
      action,
      reorderCostCents: reorderQty * destination.costCents,
    };
  });

  return {
    lookbackDays,
    rows: prepared,
    recommendations,
    summary: {
      fastMovers: prepared.filter((row) => row.tier === "fast").length,
      mediumMovers: prepared.filter((row) => row.tier === "medium").length,
      atRisk: recommendations.length,
      transferUnits: recommendations.reduce((sum, row) => sum + row.transferQty, 0),
      reorderUnits: recommendations.reduce((sum, row) => sum + row.reorderQty, 0),
      incomingUnits: recommendations.reduce((sum, row) => sum + row.incomingApplied, 0),
    },
  };
}
