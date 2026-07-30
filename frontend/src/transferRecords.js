function productIndex(products) {
  if (products instanceof Map) return products;
  return new Map((products || []).filter((product) => product?.id).map((product) => [String(product.id), product]));
}

export function normalizedTransferItems(transfer, products = []) {
  const productsById = productIndex(products);
  const sourceItems = Array.isArray(transfer?.items) && transfer.items.length > 0
    ? transfer.items
    : (transfer?.productId || transfer?.productName || Number(transfer?.qty || 0) !== 0)
      ? [{
          productId: transfer?.productId,
          productName: transfer?.productName,
          sku: transfer?.sku,
          qty: transfer?.qty,
          costCents: transfer?.costCents,
          valueCents: transfer?.valueCents,
        }]
      : [];

  return sourceItems.map((item) => {
    const product = productsById.get(String(item?.productId || ""));
    return {
      ...(item || {}),
      productId: item?.productId || product?.id || "",
      productName: String(item?.productName || product?.name || "Unknown product").trim(),
      sku: String(item?.sku || product?.sku || "").trim(),
      qty: Number(item?.qty || 0),
    };
  });
}

export function transferUnitCount(transfer, products = []) {
  return normalizedTransferItems(transfer, products)
    .reduce((total, item) => total + Number(item.qty || 0), 0);
}

export function nextTransferNumber(transfers = []) {
  const lastNumber = transfers.reduce((max, transfer) => {
    const explicit = Number(transfer?.transferSequence || 0);
    if (Number.isSafeInteger(explicit) && explicit > 0) return Math.max(max, explicit);
    const match = /^TRF-(\d{6,9})$/.exec(String(transfer?.number || "").trim());
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `TRF-${String(lastNumber + 1).padStart(6, "0")}`;
}

export function rankStockTransferSuggestions(candidates = [], { days = 30, limit = 20 } = {}) {
  const analysisDays = Math.max(1, Number(days) || 30);
  const prepared = (candidates || []).map((candidate) => {
    const sourceStock = Math.max(0, Math.floor(Number(candidate?.sourceStock) || 0));
    const destinationStock = Math.max(0, Math.floor(Number(candidate?.destinationStock) || 0));
    const sourceSold = Math.max(0, Number(candidate?.sourceSold) || 0);
    const destinationSold = Math.max(0, Number(candidate?.destinationSold) || 0);
    const sourceDailySales = sourceSold / analysisDays;
    const destinationDailySales = destinationSold / analysisDays;
    const sourceReserve = Math.max(1, Math.ceil(sourceDailySales * 30));
    const sourceSurplus = Math.max(0, sourceStock - sourceReserve);
    const destinationTarget = Math.max(2, Math.ceil(destinationDailySales * 21));
    const destinationNeed = Math.max(0, destinationTarget - destinationStock);
    const sourceIsStagnant = sourceSold <= destinationSold * 0.25;

    if (destinationSold < 2 || !sourceIsStagnant || sourceSurplus <= 0 || destinationNeed <= 0) return null;
    return {
      ...candidate,
      sourceStock,
      destinationStock,
      sourceSold,
      destinationSold,
      sourceReserve,
      sourceSurplus,
      destinationTarget,
      destinationNeed,
      requestedQty: Math.min(sourceSurplus, destinationNeed),
      confidence: sourceSold === 0 && destinationSold >= 5 ? "High" : "Medium",
      score: destinationSold * 10 + destinationNeed * 2 - sourceSold,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score || b.requestedQty - a.requestedQty);

  const remainingSourceStock = new Map();
  const suggestions = [];
  prepared.forEach((candidate) => {
    if (suggestions.length >= Math.max(1, Number(limit) || 20)) return;
    const sourceKey = `${candidate.productKey || candidate.productId || candidate.productName}:${candidate.sourceBranchId}`;
    const remaining = remainingSourceStock.has(sourceKey)
      ? remainingSourceStock.get(sourceKey)
      : candidate.sourceSurplus;
    const suggestedQty = Math.min(candidate.requestedQty, remaining);
    if (suggestedQty <= 0) return;
    remainingSourceStock.set(sourceKey, remaining - suggestedQty);
    suggestions.push({ ...candidate, suggestedQty });
  });
  return suggestions;
}
