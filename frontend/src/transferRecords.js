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
