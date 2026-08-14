import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPurchaseOrderReports,
  purchaseOrderReportCsv,
  searchPurchaseOrderReports,
} from "../frontend/src/admin/purchaseOrderReport.js";

const DAY = 86400000;
const referenceTime = Date.UTC(2026, 7, 14, 12);

function baseData() {
  return {
    settings: { lastEndDayByBranch: { cpt: referenceTime } },
    branches: [{ id: "cpt", name: "Cape Town" }, { id: "sip", name: "SIPCITY" }],
    products: [{ id: "p1", name: "Juice", sku: "J001", category: "Drinks" }],
    purchases: [{
      id: "po-line-1", batchId: "batch-43", batchNo: "PO-0043", supplierName: "Supplier One",
      productId: "p1", productName: "Juice", branchId: "cpt", qty: 10, costCents: 10000,
      lineTotalCents: 100000, status: "received", ts: referenceTime - 20 * DAY, receivedAt: referenceTime - 20 * DAY,
    }],
    invoices: [],
    invoiceVoidRequests: [],
    invoiceVoidDecisions: [],
    endOfDays: [{ id: "eod", branchId: "cpt", periodEndedAt: referenceTime }],
    stockMovements: [{
      id: "receive", purchaseId: "po-line-1", purchaseBatchId: "batch-43", purchaseBatchNo: "PO-0043",
      productId: "p1", branchId: "cpt", qty: 10, costCents: 10000, reason: "Purchase Supplier One", ts: referenceTime - 20 * DAY,
    }],
  };
}

test("purchase order report separates recognized profit, pending profit, losses, and remaining stock", () => {
  const data = baseData();
  data.invoices.push(
    { id: "paid", number: "RCP-001", branchId: "cpt", customerName: "Paid Customer", cashier: "Ann", totalCents: 45000, paidCents: 45000, ts: referenceTime - 5 * DAY, items: [{ productId: "p1", qty: 3, priceCents: 15000 }] },
    { id: "open", number: "RCP-002", branchId: "cpt", customerName: "Open Customer", cashier: "Bob", totalCents: 30000, paidCents: 0, ts: referenceTime - DAY, items: [{ productId: "p1", qty: 2, priceCents: 15000 }] },
  );
  data.stockMovements.push(
    { id: "sale-paid", productId: "p1", branchId: "cpt", qty: -3, reason: "Sale RCP-001", ts: referenceTime - 5 * DAY },
    { id: "sale-open", productId: "p1", branchId: "cpt", qty: -2, reason: "Sale RCP-002", ts: referenceTime - DAY },
    { id: "loss", productId: "p1", branchId: "cpt", qty: -1, reason: "Loss/Damage · Broken", ts: referenceTime - 12 * 60 * 60 * 1000 },
  );

  const [report] = buildPurchaseOrderReports(data, { referenceTime, lookbackDays: 28 });
  assert.equal(report.number, "PO-0043");
  assert.equal(report.receivedUnits, 10);
  assert.equal(report.soldUnits, 5);
  assert.equal(report.availableUnits, 4);
  assert.equal(report.lossUnits, 1);
  assert.equal(report.recognizedRevenueCents, 45000);
  assert.equal(report.recognizedCogsCents, 30000);
  assert.equal(report.recognizedGrossProfitCents, 15000);
  assert.equal(report.pendingRevenueCents, 30000);
  assert.equal(report.pendingGrossProfitCents, 10000);
  assert.equal(report.lossValueCents, 10000);
  assert.equal(report.availableValueCents, 40000);
  assert.equal(report.netContributionCents, 5000);
  assert.equal(report.lines[0].invoiceCount, 2);
});

test("branch transfer preserves the source purchase without counting the move as a sale or loss", () => {
  const data = baseData();
  data.stockMovements.push(
    { id: "transfer-out", transferId: "tr-1", transferNumber: "TRF-0001", productId: "p1", branchId: "cpt", qty: -4, reason: "Transfer to SIPCITY (TRF-0001)", ts: referenceTime - DAY },
    { id: "transfer-in", transferId: "tr-1", transferNumber: "TRF-0001", productId: "p1", branchId: "sip", qty: 4, reason: "Transfer from Cape Town (TRF-0001)", ts: referenceTime - DAY },
  );
  const [report] = buildPurchaseOrderReports(data, { referenceTime });
  assert.equal(report.soldUnits, 0);
  assert.equal(report.lossUnits, 0);
  assert.equal(report.availableUnits, 10);
  assert.deepEqual(report.lines[0].availableByBranch, [
    { branchId: "cpt", branchName: "Cape Town", qty: 6 },
    { branchId: "sip", branchName: "SIPCITY", qty: 4 },
  ]);
  assert.equal(report.movements.filter((movement) => movement.kind.startsWith("transfer")).length, 2);
});

test("voided invoice stock is flagged and excluded from profit", () => {
  const data = baseData();
  data.invoices.push({ id: "voided", number: "RCP-VOID", branchId: "cpt", totalCents: 15000, paidCents: 0, ts: referenceTime - DAY, items: [{ productId: "p1", qty: 1, priceCents: 15000 }] });
  data.invoiceVoidRequests.push({ id: "request", invoiceId: "voided", requestedAt: referenceTime - DAY });
  data.invoiceVoidDecisions.push({ id: "decision", invoiceId: "voided", requestId: "request", decision: "approved", decidedAt: referenceTime });
  data.stockMovements.push({ id: "void-sale", productId: "p1", branchId: "cpt", qty: -1, reason: "Sale RCP-VOID", ts: referenceTime - DAY });
  const [report] = buildPurchaseOrderReports(data, { referenceTime });
  assert.equal(report.soldUnits, 0);
  assert.equal(report.recognizedRevenueCents, 0);
  assert.equal(report.lines[0].voidedSoldQty, 1);
  assert.match(report.issues[0], /voided invoices/i);
});

test("purchase reports search PO number, product, supplier, branch, and export details", () => {
  const reports = buildPurchaseOrderReports(baseData(), { referenceTime });
  assert.equal(searchPurchaseOrderReports(reports, "0043").length, 1);
  assert.equal(searchPurchaseOrderReports(reports, "juice").length, 1);
  assert.equal(searchPurchaseOrderReports(reports, "supplier one").length, 1);
  assert.equal(searchPurchaseOrderReports(reports, "sipcity").length, 0);
  const csv = purchaseOrderReportCsv(reports[0]);
  assert.match(csv, /Purchase order,PO-0043/);
  assert.match(csv, /Recognized gross profit/);
  assert.match(csv, /Movement time/);
});
