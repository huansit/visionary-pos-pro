import { buildPurchaseLotTrace } from "./purchaseLotTraceability.js";
import { analyzeStockMovements } from "./stockMovementAnalyzer.js";

const DAY_MS = 86400000;

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const positive = (value) => Math.max(0, number(value));
const purchaseKey = (purchase) => String(purchase?.batchId || purchase?.id || "");
const purchaseNumber = (purchase) => String(purchase?.batchNo || purchase?.purchaseNumber || purchase?.orderNumber || purchase?.id || "Purchase");

function purchaseUnitCostCents(purchase) {
  const quantity = positive(purchase?.qty);
  const lineTotal = positive(purchase?.lineTotalCents);
  if (quantity > 0 && lineTotal > 0) return lineTotal / quantity;
  return positive(purchase?.costCents);
}

function invoiceOutstanding(invoice) {
  return Math.max(0, positive(invoice?.totalCents) - positive(invoice?.paidCents));
}

function lastBranchClose(data, branchId) {
  const configured = number(data?.settings?.lastEndDayByBranch?.[branchId]);
  const recorded = (data?.endOfDays || [])
    .filter((entry) => entry.branchId === branchId)
    .reduce((latest, entry) => Math.max(latest, number(entry.periodEndedAt || entry.closedAt || entry.ts)), 0);
  return Math.max(configured, recorded);
}

function latestVoidStatus(data, invoiceId) {
  const requests = (data?.invoiceVoidRequests || [])
    .filter((entry) => entry.invoiceId === invoiceId)
    .sort((left, right) => number(right.requestedAt || right.ts) - number(left.requestedAt || left.ts));
  const request = requests[0];
  if (!request) return "none";
  const decisions = (data?.invoiceVoidDecisions || [])
    .filter((entry) => entry.invoiceId === invoiceId && (!entry.requestId || entry.requestId === request.id))
    .sort((left, right) => number(right.decidedAt || right.ts) - number(left.decidedAt || left.ts));
  return decisions[0]?.decision || "pending";
}

function invoiceUnitRevenueCents(invoice, productId) {
  const items = Array.isArray(invoice?.items) ? invoice.items : [];
  const matching = items.filter((item) => String(item?.productId || "") === String(productId || ""));
  const matchingQty = matching.reduce((sum, item) => sum + positive(item?.qty ?? item?.quantity), 0);
  if (matchingQty > 0) {
    const revenue = matching.reduce((sum, item) => {
      const qty = positive(item?.qty ?? item?.quantity);
      return sum + qty * positive(item?.priceCents ?? item?.unitPriceCents);
    }, 0);
    if (revenue > 0) return revenue / matchingQty;
  }
  const totalQty = items.reduce((sum, item) => sum + positive(item?.qty ?? item?.quantity), 0);
  return totalQty > 0 ? positive(invoice?.totalCents) / totalQty : 0;
}

function movementKind(movement) {
  const reason = String(movement?.reason || "").trim();
  const quantity = number(movement?.qty);
  if (movement?.purchaseId && quantity > 0) return "received";
  if (movement?.transferId) return quantity < 0 ? "transfer_out" : "transfer_in";
  if (/^sale\s+/i.test(reason) && quantity < 0) return "sale";
  if (/^loss\/damage/i.test(reason) && quantity < 0) return "loss";
  if (movement?.mode === "count" || /^(inventory count|stock count|quick inventory|count amendment)/i.test(reason)) return quantity < 0 ? "shrinkage" : "count_gain";
  if (movement?.mode === "correction" || /^stock correction/i.test(reason)) return quantity < 0 ? "correction_out" : "correction_in";
  return quantity < 0 ? "adjustment_out" : "adjustment_in";
}

function displayMovementKind(kind, voided = false) {
  if (voided) return "Voided sale";
  return ({
    received: "Received",
    transfer_out: "Transfer out",
    transfer_in: "Transfer in",
    sale: "Sale",
    loss: "Loss / damage",
    shrinkage: "Count shortage",
    count_gain: "Count gain",
    correction_out: "Correction out",
    correction_in: "Correction in",
    adjustment_out: "Adjustment out",
    adjustment_in: "Adjustment in",
  })[kind] || "Movement";
}

function saleInvoice(data, movement, invoiceByNumber) {
  if (movement?.invoiceId) return (data.invoices || []).find((invoice) => invoice.id === movement.invoiceId) || null;
  const reason = String(movement?.reason || "");
  return /^sale\s+/i.test(reason) ? invoiceByNumber.get(reason.replace(/^sale\s+/i, "").trim()) || null : null;
}

function movementReference(movement, invoice) {
  if (invoice) return invoice.number || invoice.receiptNo || invoice.id;
  return movement.transferNumber || movement.purchaseBatchNo || movement.reason || movement.id;
}

function emptyLine(purchase, product, branch) {
  const orderedQty = positive(purchase.qty);
  const unitCostCents = purchaseUnitCostCents(purchase);
  return {
    purchaseId: purchase.id,
    productId: purchase.productId,
    productName: purchase.productName || product?.name || "Product",
    sku: product?.sku || "",
    category: product?.category || "",
    supplierName: purchase.supplierName || "",
    orderedBranchId: purchase.branchId || "",
    orderedBranchName: branch?.name || "Unknown branch",
    status: String(purchase.status || "ordered").toLowerCase(),
    orderedQty,
    receivedQty: 0,
    soldQty: 0,
    recognizedSoldQty: 0,
    pendingSoldQty: 0,
    voidedSoldQty: 0,
    transferOutQty: 0,
    transferInQty: 0,
    lossQty: 0,
    shrinkageQty: 0,
    correctionOutQty: 0,
    otherOutQty: 0,
    availableQty: 0,
    availableByBranch: [],
    unitCostCents,
    orderedCostCents: orderedQty * unitCostCents,
    receivedCostCents: 0,
    recognizedRevenueCents: 0,
    recognizedCogsCents: 0,
    recognizedGrossProfitCents: 0,
    pendingRevenueCents: 0,
    pendingCogsCents: 0,
    pendingGrossProfitCents: 0,
    lossValueCents: 0,
    shrinkageValueCents: 0,
    availableValueCents: 0,
    sellThroughPct: 0,
    grossMarginPct: null,
    weeklyDemand: 0,
    tier: "slow",
    invoiceCount: 0,
    invoiceReferences: [],
    movements: [],
    issues: [],
  };
}

function sumLines(lines, field) {
  return lines.reduce((sum, line) => sum + number(line[field]), 0);
}

export function buildPurchaseOrderReports(data = {}, options = {}) {
  const purchases = data.purchases || [];
  const movements = data.stockMovements || [];
  const branches = data.branches || [];
  const products = data.products || [];
  const lookbackDays = Math.max(1, number(options.lookbackDays) || 28);
  const referenceTime = number(options.referenceTime) || Date.now();
  const trace = buildPurchaseLotTrace(data);
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const productById = new Map(products.map((product) => [product.id, product]));
  const invoiceByNumber = new Map((data.invoices || []).flatMap((invoice) => [invoice.number, invoice.receiptNo]
    .filter(Boolean).map((reference) => [String(reference), invoice])));
  const purchaseById = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const reportByKey = new Map();
  const lineByPurchaseId = new Map();

  purchases.forEach((purchase) => {
    const key = purchaseKey(purchase);
    if (!key) return;
    if (!reportByKey.has(key)) {
      reportByKey.set(key, {
        key,
        number: purchaseNumber(purchase),
        createdAt: number(purchase.ts),
        receivedAt: 0,
        status: "ordered",
        suppliers: new Set(),
        branchIds: new Set(),
        lines: [],
        movements: [],
        issues: [],
      });
    }
    const report = reportByKey.get(key);
    const line = emptyLine(purchase, productById.get(purchase.productId), branchById.get(purchase.branchId));
    report.lines.push(line);
    lineByPurchaseId.set(purchase.id, line);
    if (purchase.supplierName) report.suppliers.add(purchase.supplierName);
    if (purchase.branchId) report.branchIds.add(purchase.branchId);
    report.createdAt = report.createdAt ? Math.min(report.createdAt, number(purchase.ts) || report.createdAt) : number(purchase.ts);
    report.receivedAt = Math.max(report.receivedAt, number(purchase.receivedAt));
  });

  const currentSales = new Map();
  const velocityCutoff = referenceTime - lookbackDays * DAY_MS;
  movements.forEach((movement) => {
    if (number(movement.qty) >= 0 || number(movement.ts) < velocityCutoff || movementKind(movement) !== "sale") return;
    const invoice = saleInvoice(data, movement, invoiceByNumber);
    if (!invoice || latestVoidStatus(data, invoice.id) === "approved") return;
    currentSales.set(movement.productId, (currentSales.get(movement.productId) || 0) + Math.abs(number(movement.qty)));
  });
  const velocityRows = [...new Set(purchases.map((purchase) => purchase.productId).filter(Boolean))].map((productId) => ({
    id: productId,
    productId,
    productKey: productId,
    onHand: movements.filter((movement) => movement.productId === productId).reduce((sum, movement) => sum + number(movement.qty), 0),
    soldUnits: currentSales.get(productId) || 0,
    reorderLevel: 0,
  }));
  const velocityByProduct = new Map(analyzeStockMovements(velocityRows, { lookbackDays }).rows.map((row) => [row.productId, row]));

  movements.forEach((movement) => {
    const kind = movementKind(movement);
    if (kind === "received" && lineByPurchaseId.has(movement.purchaseId)) {
      const line = lineByPurchaseId.get(movement.purchaseId);
      const report = reportByKey.get(purchaseKey(purchaseById.get(movement.purchaseId)));
      const quantity = positive(movement.qty);
      const unitCostCents = positive(movement.costCents || movement.unitCostCents) || line.unitCostCents;
      line.receivedQty += quantity;
      line.receivedCostCents += quantity * unitCostCents;
      const row = {
        id: movement.id,
        ts: number(movement.ts),
        kind,
        label: displayMovementKind(kind),
        productId: movement.productId,
        productName: line.productName,
        branchId: movement.branchId,
        branchName: branchById.get(movement.branchId)?.name || "Unknown branch",
        qty: quantity,
        valueCents: quantity * unitCostCents,
        reference: movementReference(movement),
        customerName: "",
        cashierName: "",
        accountingStatus: "stock",
      };
      line.movements.push(row);
      report?.movements.push(row);
      return;
    }

    const groupedAllocations = new Map();
    trace.allocationsForMovement(movement.id).forEach((allocation) => {
      if (!allocation.tracked || !lineByPurchaseId.has(allocation.purchaseId)) return;
      const current = groupedAllocations.get(allocation.purchaseId) || { qty: 0, unitCostCents: 0 };
      const quantity = positive(allocation.qty || allocation.qtyRemaining);
      current.qty += quantity;
      current.unitCostCents = positive(allocation.unitCostCents) || current.unitCostCents;
      groupedAllocations.set(allocation.purchaseId, current);
    });
    groupedAllocations.forEach((allocation, purchaseId) => {
      const purchase = purchaseById.get(purchaseId);
      const line = lineByPurchaseId.get(purchaseId);
      const report = reportByKey.get(purchaseKey(purchase));
      if (!line || !report) return;
      const quantity = allocation.qty;
      const unitCostCents = allocation.unitCostCents || line.unitCostCents;
      const costValueCents = quantity * unitCostCents;
      const invoice = kind === "sale" ? saleInvoice(data, movement, invoiceByNumber) : null;
      const voided = invoice ? latestVoidStatus(data, invoice.id) === "approved" : false;
      const recognized = Boolean(invoice && !voided && invoiceOutstanding(invoice) <= 0
        && number(invoice.ts || invoice.issuedAt) <= lastBranchClose(data, invoice.branchId));
      const revenueCents = invoice && !voided ? quantity * invoiceUnitRevenueCents(invoice, movement.productId) : 0;

      if (kind === "sale") {
        line.soldQty += voided ? 0 : quantity;
        if (voided) line.voidedSoldQty += quantity;
        else if (recognized) {
          line.recognizedSoldQty += quantity;
          line.recognizedRevenueCents += revenueCents;
          line.recognizedCogsCents += costValueCents;
        } else {
          line.pendingSoldQty += quantity;
          line.pendingRevenueCents += revenueCents;
          line.pendingCogsCents += costValueCents;
        }
      } else if (kind === "transfer_out") line.transferOutQty += quantity;
      else if (kind === "transfer_in") line.transferInQty += quantity;
      else if (kind === "loss") {
        line.lossQty += quantity;
        line.lossValueCents += costValueCents;
      } else if (kind === "shrinkage") {
        line.shrinkageQty += quantity;
        line.shrinkageValueCents += costValueCents;
      } else if (kind === "correction_out") line.correctionOutQty += quantity;
      else if (kind === "adjustment_out") line.otherOutQty += quantity;

      const row = {
        id: `${movement.id}:${purchaseId}`,
        ts: number(movement.ts),
        kind: voided ? "voided_sale" : kind,
        label: displayMovementKind(kind, voided),
        productId: movement.productId,
        productName: line.productName,
        branchId: movement.branchId,
        branchName: branchById.get(movement.branchId)?.name || "Unknown branch",
        qty: quantity,
        valueCents: kind === "sale" ? revenueCents : costValueCents,
        costValueCents,
        reference: movementReference(movement, invoice),
        customerName: invoice?.customerName || "",
        cashierName: invoice?.cashier || invoice?.cashierName || "",
        accountingStatus: voided ? "voided" : kind === "sale" ? (recognized ? "recognized" : "pending") : "stock",
      };
      line.movements.push(row);
      report.movements.push(row);
    });
  });

  reportByKey.forEach((report) => {
    report.lines.forEach((line) => {
      const availableByBranch = branches.map((branch) => {
        const qty = trace.activeLotsFor(line.productId, branch.id)
          .filter((lot) => lot.purchaseId === line.purchaseId)
          .reduce((sum, lot) => sum + positive(lot.qtyRemaining), 0);
        return { branchId: branch.id, branchName: branch.name, qty };
      }).filter((entry) => entry.qty > 0);
      line.availableByBranch = availableByBranch;
      line.availableQty = availableByBranch.reduce((sum, entry) => sum + entry.qty, 0);
      line.availableValueCents = line.availableQty * line.unitCostCents;
      line.recognizedGrossProfitCents = line.recognizedRevenueCents - line.recognizedCogsCents;
      line.pendingGrossProfitCents = line.pendingRevenueCents - line.pendingCogsCents;
      line.sellThroughPct = line.receivedQty > 0 ? Math.min(100, line.soldQty / line.receivedQty * 100) : 0;
      line.grossMarginPct = line.recognizedRevenueCents > 0 ? line.recognizedGrossProfitCents / line.recognizedRevenueCents * 100 : null;
      const velocity = velocityByProduct.get(line.productId);
      line.weeklyDemand = velocity?.weeklyDemand || 0;
      line.tier = velocity?.tier || "slow";
      const invoiceReferences = line.movements.filter((entry) => entry.kind === "sale" && entry.reference).map((entry) => entry.reference);
      line.invoiceReferences = [...new Set(invoiceReferences)];
      line.invoiceCount = line.invoiceReferences.length;
      if (line.status === "received" && line.receivedQty <= 0) line.issues.push("Marked received but no linked stock receipt was found.");
      if (line.receivedQty > line.orderedQty) line.issues.push("Received quantity is greater than the ordered quantity.");
      if (line.voidedSoldQty > 0) line.issues.push(`${line.voidedSoldQty} unit(s) moved on voided invoices and require stock review.`);
      report.issues.push(...line.issues.map((issue) => `${line.productName}: ${issue}`));
    });
    report.movements.sort((left, right) => right.ts - left.ts || String(left.id).localeCompare(String(right.id)));
    report.suppliers = [...report.suppliers];
    report.branchIds = [...report.branchIds];
    report.branchNames = report.branchIds.map((branchId) => branchById.get(branchId)?.name || branchId);
    report.status = report.lines.every((line) => line.status === "received") ? "received"
      : report.lines.some((line) => line.status === "received") ? "partial" : "ordered";
    report.productCount = report.lines.length;
    report.orderedUnits = sumLines(report.lines, "orderedQty");
    report.receivedUnits = sumLines(report.lines, "receivedQty");
    report.soldUnits = sumLines(report.lines, "soldQty");
    report.availableUnits = sumLines(report.lines, "availableQty");
    report.lossUnits = sumLines(report.lines, "lossQty") + sumLines(report.lines, "shrinkageQty");
    report.orderedCostCents = sumLines(report.lines, "orderedCostCents");
    report.receivedCostCents = sumLines(report.lines, "receivedCostCents");
    report.recognizedRevenueCents = sumLines(report.lines, "recognizedRevenueCents");
    report.recognizedCogsCents = sumLines(report.lines, "recognizedCogsCents");
    report.recognizedGrossProfitCents = sumLines(report.lines, "recognizedGrossProfitCents");
    report.pendingRevenueCents = sumLines(report.lines, "pendingRevenueCents");
    report.pendingGrossProfitCents = sumLines(report.lines, "pendingGrossProfitCents");
    report.lossValueCents = sumLines(report.lines, "lossValueCents") + sumLines(report.lines, "shrinkageValueCents");
    report.availableValueCents = sumLines(report.lines, "availableValueCents");
    report.netContributionCents = report.recognizedGrossProfitCents - report.lossValueCents;
    report.sellThroughPct = report.receivedUnits > 0 ? Math.min(100, report.soldUnits / report.receivedUnits * 100) : 0;
    report.grossMarginPct = report.recognizedRevenueCents > 0 ? report.recognizedGrossProfitCents / report.recognizedRevenueCents * 100 : null;
    report.tiers = {
      fast: report.lines.filter((line) => line.tier === "fast").length,
      medium: report.lines.filter((line) => line.tier === "medium").length,
      slow: report.lines.filter((line) => line.tier === "slow").length,
    };
    report.searchText = [report.number, ...report.suppliers, ...report.branchNames, ...report.lines.flatMap((line) => [line.productName, line.sku, line.category])]
      .join(" ").toLowerCase();
  });

  return [...reportByKey.values()].sort((left, right) => right.createdAt - left.createdAt || right.number.localeCompare(left.number));
}

export function searchPurchaseOrderReports(reports = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return reports;
  return (reports || []).filter((report) => String(report.searchText || "").includes(needle));
}

export function purchaseOrderReportCsv(report) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    ["Purchase order", report.number],
    ["Status", report.status],
    ["Suppliers", report.suppliers.join(" / ")],
    ["Branches", report.branchNames.join(" / ")],
    [],
    ["Product", "SKU", "Movement", "Ordered", "Received", "Sold", "Available", "Loss / shortage", "Unit cost", "Recognized revenue", "Recognized gross profit", "Pending revenue", "Stock value", "Sell-through %"],
    ...report.lines.map((line) => [
      line.productName, line.sku, line.tier, line.orderedQty, line.receivedQty, line.soldQty, line.availableQty,
      line.lossQty + line.shrinkageQty, line.unitCostCents / 100, line.recognizedRevenueCents / 100,
      line.recognizedGrossProfitCents / 100, line.pendingRevenueCents / 100, line.availableValueCents / 100,
      Math.round(line.sellThroughPct * 10) / 10,
    ]),
    [],
    ["Movement time", "Type", "Product", "Branch", "Quantity", "Reference", "Customer", "Cashier", "Accounting status", "Value"],
    ...report.movements.map((movement) => [
      new Date(movement.ts).toISOString(), movement.label, movement.productName, movement.branchName, movement.qty,
      movement.reference, movement.customerName, movement.cashierName, movement.accountingStatus, movement.valueCents / 100,
    ]),
  ];
  return rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
