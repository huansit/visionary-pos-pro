const MOVEMENT_PRIORITY = Object.freeze({ fast: 0, medium: 1 });

function whole(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function supplierQuotesForProduct(productId, supplierPrices = [], suppliers = []) {
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  return supplierPrices
    .filter((quote) => quote.productId === productId && supplierById.has(quote.supplierId))
    .map((quote) => ({ ...quote, supplier: supplierById.get(quote.supplierId) }))
    .sort((a, b) => Number(a.costCents || 0) - Number(b.costCents || 0));
}

export function preparePurchaseOrderLines(recommendations = [], options = {}) {
  const branchId = String(options.branchId || "");
  const movementFilter = String(options.movementFilter || "active");
  const supplierPrices = options.supplierPrices || [];
  const suppliers = options.suppliers || [];
  const defaultSupplierId = options.defaultSupplierId || suppliers[0]?.id || "";

  return (recommendations || [])
    .filter((entry) => entry.branchId === branchId
      && whole(entry.reorderQty) > 0
      && (entry.tier === "fast" || entry.tier === "medium")
      && (movementFilter === "active" || entry.tier === movementFilter))
    .map((entry) => {
      const quotes = supplierQuotesForProduct(entry.productId, supplierPrices, suppliers);
      const recommendedQuote = quotes[0] || null;
      const averageCostCents = Math.max(0, Number(entry.costCents) || 0);
      const orderCostCents = Math.max(0, Number(recommendedQuote?.costCents) || averageCostCents);
      return {
        productId: entry.productId,
        name: entry.productName,
        sku: entry.sku,
        tier: entry.tier,
        selected: true,
        onHand: whole(entry.onHand),
        weeklyDemand: Math.max(0, Number(entry.weeklyDemand) || 0),
        targetStock: whole(entry.targetStock),
        incomingQty: whole(entry.incomingApplied),
        transferQty: whole(entry.transferQty),
        qty: whole(entry.reorderQty),
        supplierId: recommendedQuote?.supplierId || defaultSupplierId,
        averageCostCents,
        costCents: orderCostCents,
        hasQuote: Boolean(recommendedQuote),
        quotes,
      };
    })
    .sort((a, b) => MOVEMENT_PRIORITY[a.tier] - MOVEMENT_PRIORITY[b.tier]
      || b.weeklyDemand - a.weeklyDemand
      || String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true }));
}

export function addPurchaseOrderProduct(lines = [], product, options = {}) {
  if (!product?.id || (lines || []).some((line) => line.productId === product.id)) return lines;

  const suppliers = options.suppliers || [];
  const quotes = supplierQuotesForProduct(product.id, options.supplierPrices || [], suppliers);
  const recommendedQuote = quotes[0] || null;
  const averageCostCents = Math.max(0, Number(options.averageCostCents) || 0);

  return [
    ...(lines || []),
    {
      productId: product.id,
      name: product.name || "Product",
      sku: product.sku || "",
      tier: "manual",
      manuallyAdded: true,
      selected: true,
      onHand: whole(options.onHand),
      weeklyDemand: 0,
      targetStock: whole(options.onHand),
      incomingQty: 0,
      transferQty: 0,
      qty: Math.max(1, whole(options.qty) || 1),
      supplierId: recommendedQuote?.supplierId || options.defaultSupplierId || suppliers[0]?.id || "",
      averageCostCents,
      costCents: Math.max(0, Number(recommendedQuote?.costCents) || averageCostCents),
      hasQuote: Boolean(recommendedQuote),
      quotes,
    },
  ];
}

export function selectedPurchaseOrderLines(lines = []) {
  return (lines || []).filter((line) => line.selected !== false && whole(line.qty) > 0);
}

export function purchaseOrderLineTotalCents(line) {
  return whole(line?.qty) * Math.max(0, Number(line?.costCents) || 0);
}

export function purchaseOrderTotalCents(lines = []) {
  return selectedPurchaseOrderLines(lines).reduce((sum, line) => sum + purchaseOrderLineTotalCents(line), 0);
}

export function purchaseOrderExportText(lines = []) {
  return [
    "Products-Amount",
    ...selectedPurchaseOrderLines(lines).map((line) => `${String(line.name || "").replace(/,/g, "").trim()}-${whole(line.qty)}`),
  ].join("\r\n");
}
