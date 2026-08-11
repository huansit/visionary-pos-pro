const normalizedStatus = (value) => String(value || "").trim().toLowerCase();

const preciseCents = (value, fractionDigits = 6) => {
  const numeric = Math.max(0, Number(value) || 0);
  const factor = 10 ** fractionDigits;
  return Math.round(numeric * factor) / factor;
};

export function purchaseRepairUnitCostCents(line) {
  const quantity = Math.max(0, Number(line?.qty) || 0);
  const total = Number(line?.lineTotalCents ?? line?.valueCents);
  if (quantity > 0 && Number.isFinite(total) && total >= 0) return preciseCents(total / quantity);
  return preciseCents(line?.costCents ?? line?.unitCostCents ?? 0);
}

export function purchaseRepairStockQuantity(data, productId, branchId) {
  return (data?.stockMovements || [])
    .filter((movement) => movement.productId === productId && movement.branchId === branchId)
    .reduce((total, movement) => total + (Number(movement.qty) || 0), 0);
}

function supplierNameFromMovement(movement) {
  return String(movement?.reason || "").replace(/^Purchase\s*/i, "").trim();
}

export function recoverableDeletedPurchaseLines(data, batchId) {
  if (!batchId) return [];
  const purchases = data?.purchases || [];
  const activePurchaseIds = new Set(purchases.map((purchase) => purchase.id));
  const productsById = new Map((data?.products || []).map((product) => [product.id, product]));
  const branchesById = new Map((data?.branches || []).map((branch) => [branch.id, branch]));
  const seenPurchaseIds = new Set();

  return (data?.stockMovements || [])
    .filter((movement) => movement.purchaseBatchId === batchId
      && movement.purchaseId
      && !activePurchaseIds.has(movement.purchaseId)
      && Number(movement.qty || 0) > 0
      && normalizedStatus(movement.adjustmentType) !== "purchase_cost_correction")
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .filter((movement) => {
      if (seenPurchaseIds.has(movement.purchaseId)) return false;
      seenPurchaseIds.add(movement.purchaseId);
      return true;
    })
    .map((movement) => {
      const product = productsById.get(movement.productId);
      const supplierName = supplierNameFromMovement(movement);
      return {
        movement,
        movementId: movement.id,
        purchaseId: movement.purchaseId,
        batchId: movement.purchaseBatchId,
        productId: movement.productId,
        productName: product?.name || movement.productName || movement.productId,
        branchId: movement.branchId,
        branchName: branchesById.get(movement.branchId)?.name || "Branch",
        supplierName,
        quantity: Number(movement.qty || 0),
        originalUnitCostCents: purchaseRepairUnitCostCents(movement),
        originalLineTotalCents: Math.round(Math.max(0, Number(movement.valueCents) || (Number(movement.qty || 0) * Number(movement.costCents || 0)))),
        receivedAt: Number(movement.ts || 0),
      };
    });
}

export function replayBranchMovingAverageCost(data, productId, branchId) {
  const purchaseCosts = new Map(
    (data?.purchases || [])
      .filter((purchase) => purchase.productId === productId
        && purchase.branchId === branchId
        && normalizedStatus(purchase.status) === "received")
      .map((purchase) => [purchase.id, purchaseRepairUnitCostCents(purchase)])
  );
  const movements = (data?.stockMovements || [])
    .filter((movement) => movement.productId === productId
      && movement.branchId === branchId
      && normalizedStatus(movement.adjustmentType) !== "purchase_cost_correction")
    .map((movement, index) => ({ movement, index }))
    .sort((a, b) => (Number(a.movement.ts || 0) - Number(b.movement.ts || 0)) || (a.index - b.index));

  let quantity = 0;
  let averageCostCents = 0;
  for (const { movement } of movements) {
    const movementQuantity = Number(movement.qty || 0);
    if (movementQuantity > 0) {
      const storedValue = Number(movement.valueCents);
      const incomingCost = purchaseCosts.get(movement.purchaseId)
        ?? preciseCents(movement.costCents ?? movement.unitCostCents
          ?? (Number.isFinite(storedValue) ? storedValue / movementQuantity : averageCostCents));
      const valuedQuantity = Math.max(0, quantity);
      averageCostCents = valuedQuantity > 0
        ? preciseCents(((valuedQuantity * averageCostCents) + (movementQuantity * incomingCost)) / (valuedQuantity + movementQuantity))
        : preciseCents(incomingCost);
      quantity += movementQuantity;
      continue;
    }
    if (movementQuantity < 0) {
      quantity += movementQuantity;
      if (quantity <= 0) averageCostCents = 0;
    }
  }

  if (quantity > 0 && averageCostCents > 0) return averageCostCents;
  const latestPurchaseCost = [...purchaseCosts.values()].at(-1);
  return preciseCents(latestPurchaseCost || 0);
}

function requiredReason(reason) {
  const value = String(reason || "").trim();
  if (value.length < 3) throw new Error("Enter a clear correction reason.");
  return value;
}

function actorFields(actor) {
  return {
    actorId: String(actor?.id || actor?.userId || ""),
    actorName: String(actor?.name || actor?.displayName || "Admin"),
  };
}

function makeId(prefix, idFactory) {
  if (typeof idFactory === "function") return idFactory(prefix);
  return `${prefix}_${Math.random().toString(36).slice(2, 11)}`;
}

function correctionAudit({ purchase, previousUnitCostCents, correctedUnitCostCents, reason, actor, correctedAt, idFactory }) {
  return {
    id: makeId("pca", idFactory),
    previousUnitCostCents,
    previousLineTotalCents: Math.round(Number(purchase.qty || 0) * previousUnitCostCents),
    correctedUnitCostCents,
    correctedLineTotalCents: Math.round(Number(purchase.qty || 0) * correctedUnitCostCents),
    reason,
    correctedAt,
    ...actorFields(actor),
  };
}

function correctionMovement({ purchase, audit, correctedAt, idFactory }) {
  return {
    id: makeId("mv", idFactory),
    purchaseId: purchase.id,
    purchaseBatchId: purchase.batchId || null,
    productId: purchase.productId,
    branchId: purchase.branchId,
    qty: 0,
    costCents: audit.correctedUnitCostCents,
    valueCents: audit.correctedLineTotalCents - audit.previousLineTotalCents,
    valueAdjustmentCents: audit.correctedLineTotalCents - audit.previousLineTotalCents,
    previousCostCents: audit.previousUnitCostCents,
    correctedCostCents: audit.correctedUnitCostCents,
    adjustmentType: "purchase_cost_correction",
    correctionAuditId: audit.id,
    reason: `Purchase cost correction ${purchase.batchNo || purchase.id}: ${audit.reason}`,
    ts: correctedAt,
    synced: false,
  };
}

export function correctReceivedPurchaseCost(data, options = {}) {
  const purchase = (data?.purchases || []).find((entry) => entry.id === options.purchaseId);
  if (!purchase) throw new Error("Purchase line was not found.");
  if (normalizedStatus(purchase.status) !== "received") throw new Error("Only received purchase costs can be corrected.");
  const reason = requiredReason(options.reason);
  const correctedUnitCostCents = preciseCents(options.correctedUnitCostCents);
  if (!(correctedUnitCostCents > 0)) throw new Error("Enter a valid corrected unit cost.");
  const previousUnitCostCents = purchaseRepairUnitCostCents(purchase);
  if (Math.abs(correctedUnitCostCents - previousUnitCostCents) < 0.000001) throw new Error("The corrected cost is unchanged.");
  const correctedAt = Number(options.correctedAt || Date.now());
  const audit = correctionAudit({ purchase, previousUnitCostCents, correctedUnitCostCents, reason, actor: options.actor, correctedAt, idFactory: options.idFactory });
  const correctedPurchase = {
    ...purchase,
    costCents: correctedUnitCostCents,
    lineTotalCents: audit.correctedLineTotalCents,
    costCorrections: [...(purchase.costCorrections || []), audit],
    updatedAt: correctedAt,
    synced: false,
  };
  const movement = correctionMovement({ purchase: correctedPurchase, audit, correctedAt, idFactory: options.idFactory });
  const correctedData = {
    ...data,
    purchases: data.purchases.map((entry) => entry.id === purchase.id ? correctedPurchase : entry),
    stockMovements: [...(data.stockMovements || []), movement],
  };
  return {
    data: correctedData,
    purchase: correctedPurchase,
    audit,
    movement,
    branchCostCents: replayBranchMovingAverageCost(correctedData, purchase.productId, purchase.branchId),
  };
}

export function restoreDeletedPurchaseLine(data, options = {}) {
  const candidate = options.candidate;
  if (!candidate?.purchaseId || !candidate?.movementId) throw new Error("Deleted purchase movement was not found.");
  if ((data?.purchases || []).some((purchase) => purchase.id === candidate.purchaseId)) throw new Error("This purchase line has already been restored.");
  const sourceMovement = (data?.stockMovements || []).find((movement) => movement.id === candidate.movementId);
  if (!sourceMovement || Number(sourceMovement.qty || 0) <= 0) throw new Error("The original received stock movement is unavailable.");
  const reason = requiredReason(options.reason);
  const restoredAt = Number(options.restoredAt || Date.now());
  const originalUnitCostCents = purchaseRepairUnitCostCents(sourceMovement);
  const correctedUnitCostCents = preciseCents(options.correctedUnitCostCents || originalUnitCostCents);
  if (!(correctedUnitCostCents > 0)) throw new Error("Enter a valid purchase unit cost.");
  const product = (data.products || []).find((entry) => entry.id === sourceMovement.productId);
  if (!product) throw new Error("The deleted purchase product no longer exists.");
  const batchLine = (data.purchases || []).find((purchase) => purchase.batchId === sourceMovement.purchaseBatchId);
  const supplierName = candidate.supplierName || supplierNameFromMovement(sourceMovement) || batchLine?.supplierName || "";
  const supplier = (data.suppliers || []).find((entry) => String(entry.name || "").trim().toLowerCase() === supplierName.toLowerCase());
  const repairAudit = {
    id: makeId("pra", options.idFactory),
    type: "restore_deleted_received_line",
    sourceMovementId: sourceMovement.id,
    reason,
    restoredAt,
    ...actorFields(options.actor),
  };
  let restoredPurchase = {
    id: sourceMovement.purchaseId,
    batchId: sourceMovement.purchaseBatchId || batchLine?.batchId || null,
    batchNo: options.batchNo || batchLine?.batchNo || null,
    supplierId: supplier?.id || batchLine?.supplierId || null,
    supplierName,
    productId: sourceMovement.productId,
    productName: product.name || candidate.productName || sourceMovement.productId,
    qty: Number(sourceMovement.qty || 0),
    costCents: correctedUnitCostCents,
    lineTotalCents: Math.round(Number(sourceMovement.qty || 0) * correctedUnitCostCents),
    status: "received",
    branchId: sourceMovement.branchId,
    date: batchLine?.date || options.date || "",
    ts: Number(sourceMovement.ts || restoredAt),
    receivedAt: Number(sourceMovement.ts || restoredAt),
    restoredAt,
    restoredFromMovementId: sourceMovement.id,
    purchaseRepairs: [repairAudit],
    updatedAt: restoredAt,
    synced: false,
  };
  const additionalMovements = [];
  let costAudit = null;
  if (Math.abs(correctedUnitCostCents - originalUnitCostCents) >= 0.000001) {
    costAudit = correctionAudit({
      purchase: restoredPurchase,
      previousUnitCostCents: originalUnitCostCents,
      correctedUnitCostCents,
      reason,
      actor: options.actor,
      correctedAt: restoredAt,
      idFactory: options.idFactory,
    });
    restoredPurchase = { ...restoredPurchase, costCorrections: [costAudit] };
    additionalMovements.push(correctionMovement({ purchase: restoredPurchase, audit: costAudit, correctedAt: restoredAt, idFactory: options.idFactory }));
  }
  const restoredData = {
    ...data,
    purchases: [restoredPurchase, ...(data.purchases || [])],
    stockMovements: [...(data.stockMovements || []), ...additionalMovements],
  };
  return {
    data: restoredData,
    purchase: restoredPurchase,
    repairAudit,
    costAudit,
    branchCostCents: replayBranchMovingAverageCost(restoredData, restoredPurchase.productId, restoredPurchase.branchId),
  };
}
