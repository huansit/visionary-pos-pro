const positiveNumber = (value) => Math.max(0, Number(value) || 0);

const stockKey = (branchId, productId) => `${branchId || ""}::${productId || ""}`;
const transferKey = (transferId, productId) => `${transferId || ""}::${productId || ""}`;

function purchaseReference(purchase, movement) {
  return String(
    movement?.purchaseBatchNo
    || purchase?.batchNo
    || purchase?.purchaseNumber
    || purchase?.orderNumber
    || purchase?.id
    || movement?.purchaseId
    || "Purchase"
  );
}

function cloneLot(lot, qtyRemaining = lot.qtyRemaining) {
  return { ...lot, qtyRemaining };
}

function aggregateLots(lots = []) {
  const grouped = new Map();
  for (const lot of lots) {
    if (!(positiveNumber(lot?.qtyRemaining) > 0)) continue;
    const key = lot.tracked
      ? `${lot.purchaseId || ""}::${lot.reference || "Purchase"}`
      : "__legacy_untracked__";
    const current = grouped.get(key);
    if (current) {
      current.qtyRemaining += positiveNumber(lot.qtyRemaining);
      current.qtyReceived += positiveNumber(lot.qtyReceived);
      continue;
    }
    grouped.set(key, cloneLot(lot));
  }
  return [...grouped.values()].sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
}

function consumeLots(queue, requestedQty) {
  let remaining = positiveNumber(requestedQty);
  const consumed = [];
  while (remaining > 0 && queue.length) {
    const lot = queue[0];
    const available = positiveNumber(lot.qtyRemaining);
    if (!(available > 0)) {
      queue.shift();
      continue;
    }
    const qty = Math.min(available, remaining);
    consumed.push({ ...lot, qty, qtyRemaining: qty });
    lot.qtyRemaining = available - qty;
    remaining -= qty;
    if (!(lot.qtyRemaining > 0)) queue.shift();
  }
  if (remaining > 0) {
    consumed.push({ tracked: false, reference: "Legacy/untracked stock", qty: remaining, qtyRemaining: remaining });
  }
  return consumed;
}

export function buildPurchaseLotTrace(data = {}) {
  const purchases = new Map((data.purchases || []).map((purchase) => [purchase.id, purchase]));
  const queues = new Map();
  const allocations = new Map();
  const transferCargo = new Map();
  const movements = (data.stockMovements || [])
    .map((movement, index) => ({ movement, index }))
    .sort((a, b) => Number(a.movement.ts || 0) - Number(b.movement.ts || 0)
      || (Number(a.movement.qty || 0) < 0 ? -1 : 1) - (Number(b.movement.qty || 0) < 0 ? -1 : 1)
      || a.index - b.index);

  const queueFor = (branchId, productId) => {
    const key = stockKey(branchId, productId);
    if (!queues.has(key)) queues.set(key, []);
    return queues.get(key);
  };

  for (const { movement } of movements) {
    const qty = Number(movement.qty || 0);
    if (!qty) continue;
    const queue = queueFor(movement.branchId, movement.productId);

    if (qty < 0) {
      const consumed = consumeLots(queue, Math.abs(qty));
      allocations.set(movement.id, consumed);
      if (movement.transferId) {
        transferCargo.set(transferKey(movement.transferId, movement.productId), consumed.map((lot) => cloneLot(lot, lot.qty)));
      }
      continue;
    }

    if (movement.transferId) {
      const cargo = transferCargo.get(transferKey(movement.transferId, movement.productId)) || [];
      let carried = 0;
      const received = [];
      for (const sourceLot of cargo) {
        if (carried >= qty) break;
        const amount = Math.min(positiveNumber(sourceLot.qty), qty - carried);
        if (!(amount > 0)) continue;
        const transferredLot = { ...sourceLot, qty: amount, qtyReceived: amount, qtyRemaining: amount, transferredAt: movement.ts };
        queue.push(transferredLot);
        received.push({ ...transferredLot });
        carried += amount;
      }
      if (carried < qty) {
        const untracked = { tracked: false, reference: "Legacy/untracked stock", qty: qty - carried, qtyReceived: qty - carried, qtyRemaining: qty - carried, receivedAt: movement.ts };
        queue.push(untracked);
        received.push({ ...untracked });
      }
      allocations.set(movement.id, received);
      continue;
    }

    if (movement.purchaseId) {
      const purchase = purchases.get(movement.purchaseId);
      queue.push({
        tracked: true,
        purchaseId: movement.purchaseId,
        purchaseBatchId: movement.purchaseBatchId || purchase?.batchId || null,
        reference: purchaseReference(purchase, movement),
        supplierName: purchase?.supplierName || "",
        receivedAt: Number(purchase?.receivedAt || movement.ts || purchase?.ts || 0),
        unitCostCents: Number(movement.costCents || movement.unitCostCents || purchase?.costCents || 0),
        qtyReceived: qty,
        qtyRemaining: qty,
      });
      continue;
    }

    queue.push({
      tracked: false,
      reference: "Legacy/untracked stock",
      receivedAt: Number(movement.ts || 0),
      qtyReceived: qty,
      qtyRemaining: qty,
    });
  }

  return {
    activeLotsFor(productId, branchId) {
      return aggregateLots(queues.get(stockKey(branchId, productId)) || []);
    },
    allocationsForMovement(movementId) {
      return (allocations.get(movementId) || []).map((lot) => ({ ...lot }));
    },
    referencesForMovement(movementId) {
      return aggregateLots((allocations.get(movementId) || []).map((lot) => ({ ...lot, qtyRemaining: lot.qty })));
    },
  };
}

export function formatPurchaseLotStamp(lots = []) {
  return lots
    .filter((lot) => positiveNumber(lot?.qtyRemaining) > 0)
    .map((lot) => lot.tracked
      ? `${lot.reference} (${positiveNumber(lot.qtyRemaining)})`
      : `Legacy/untracked (${positiveNumber(lot.qtyRemaining)})`)
    .join(", ");
}

export function nextPurchaseOrderNumber(purchases = []) {
  const highest = purchases.reduce((max, purchase) => {
    const match = /^PO-(\d+)$/i.exec(String(purchase?.batchNo || "").trim());
    return match ? Math.max(max, Number(match[1]) || 0) : max;
  }, 0);
  return `PO-${String(highest + 1).padStart(4, "0")}`;
}
