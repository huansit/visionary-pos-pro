import { q } from "../db.js";

const DAY = 24 * 60 * 60 * 1000;

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value) {
  return n(value);
}

function money(centsValue) {
  return "KES " + Math.round(cents(centsValue) / 100).toLocaleString("en-KE");
}

function payload(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : {};
}

function rowBranch(row) {
  return row.branch_id ?? row.branchId ?? payload(row).branchId ?? null;
}

function rowTs(row) {
  return n(payload(row).ts || row.client_ts || row.clientTs || row.server_ts || row.serverTs || Date.now());
}

function outstanding(inv) {
  return Math.max(0, cents(inv.totalCents ?? inv.total ?? inv.amountCents) - cents(inv.paidCents ?? inv.paid ?? 0));
}

function productPrice(product) {
  return cents(product.priceCents ?? product.sellingPriceCents ?? product.selling_price ?? product.price ?? 0);
}

function productCost(product) {
  return cents(product.costCents ?? product.costPriceCents ?? product.cost_price ?? product.cost ?? 0);
}

export async function loadSnapshot() {
  const [records, events] = await Promise.all([
    q("SELECT id, type, branch_id, deleted, payload, server_ts FROM records"),
    q("SELECT id, type, branch_id, client_ts, server_ts, payload FROM events"),
  ]);
  const byType = (type) => records.rows
    .filter((row) => row.type === type && !row.deleted)
    .map((row) => ({ id: row.id, branchId: rowBranch(row), ...payload(row) }));
  return {
    branches: byType("branch"),
    products: byType("product"),
    customers: byType("customer"),
    users: byType("user"),
    invoices: events.rows.filter((row) => row.type === "invoice").map((row) => ({ id: row.id, branchId: rowBranch(row), ts: rowTs(row), ...payload(row) })),
    payments: events.rows.filter((row) => row.type === "payment").map((row) => ({ id: row.id, branchId: rowBranch(row), ts: rowTs(row), ...payload(row) })),
    expenses: events.rows.filter((row) => row.type === "expense").map((row) => ({ id: row.id, branchId: rowBranch(row), ts: rowTs(row), ...payload(row) })),
    stockMovements: events.rows.filter((row) => row.type === "stockMovement").map((row) => ({ id: row.id, branchId: rowBranch(row), ts: rowTs(row), ...payload(row) })),
  };
}

function branchName(snapshot, branchId) {
  return snapshot.branches.find((b) => b.id === branchId)?.name || branchId || "All branches";
}

function inRange(item, start, end = Date.now()) {
  const ts = rowTs(item);
  return ts >= start && ts <= end;
}

function invoiceTotal(inv) {
  return cents(inv.totalCents ?? inv.total ?? inv.amountCents);
}

export async function reportSales({ days = 1 } = {}) {
  const snapshot = await loadSnapshot();
  const start = Date.now() - days * DAY;
  const invoices = snapshot.invoices.filter((inv) => inRange(inv, start));
  const total = invoices.reduce((sum, inv) => sum + invoiceTotal(inv), 0);
  const byBranch = new Map();
  invoices.forEach((inv) => byBranch.set(inv.branchId || "all", (byBranch.get(inv.branchId || "all") || 0) + invoiceTotal(inv)));
  const lines = [...byBranch.entries()].map(([branchId, value]) => `- ${branchName(snapshot, branchId)}: ${money(value)}`);
  return [`Sales ${days === 1 ? "today" : `last ${days} days`}`, `Transactions: ${invoices.length}`, `Total: ${money(total)}`, ...lines].join("\n");
}

export async function reportOutstandingInvoices() {
  const snapshot = await loadSnapshot();
  const open = snapshot.invoices.filter((inv) => outstanding(inv) > 0);
  const total = open.reduce((sum, inv) => sum + outstanding(inv), 0);
  const top = open.slice(0, 10).map((inv) => `- ${inv.number || inv.id}: ${money(outstanding(inv))} (${inv.customerName || "Customer"})`);
  return ["Outstanding invoices", `Open: ${open.length}`, `Total outstanding: ${money(total)}`, ...top].join("\n");
}

export async function reportExpenses({ days = 1 } = {}) {
  const snapshot = await loadSnapshot();
  const start = Date.now() - days * DAY;
  const expenses = snapshot.expenses.filter((exp) => inRange(exp, start) && exp.status !== "pending");
  const total = expenses.reduce((sum, exp) => sum + cents(exp.amountCents ?? exp.amount), 0);
  const byCategory = new Map();
  expenses.forEach((exp) => byCategory.set(exp.category || "Other", (byCategory.get(exp.category || "Other") || 0) + cents(exp.amountCents ?? exp.amount)));
  return ["Expense summary", `Entries: ${expenses.length}`, `Total: ${money(total)}`, ...[...byCategory.entries()].map(([cat, value]) => `- ${cat}: ${money(value)}`)].join("\n");
}

export async function reportLowStock() {
  const snapshot = await loadSnapshot();
  const stock = new Map();
  snapshot.stockMovements.forEach((mv) => stock.set(mv.productId, (stock.get(mv.productId) || 0) + n(mv.qty ?? mv.quantity)));
  const rows = snapshot.products
    .map((p) => ({ ...p, onHand: stock.get(p.id) || 0, reorder: n(p.reorderLevel ?? p.reorder_level ?? 4) }))
    .filter((p) => p.onHand <= p.reorder)
    .sort((a, b) => a.onHand - b.onHand)
    .slice(0, 20);
  return ["Low stock alerts", rows.length ? rows.map((p) => `- ${p.name}: ${p.onHand} left`).join("\n") : "No low stock items."].join("\n");
}

export async function reportBranchSummary() {
  const snapshot = await loadSnapshot();
  const start = Date.now() - DAY;
  const lines = snapshot.branches.map((branch) => {
    const invoices = snapshot.invoices.filter((inv) => inv.branchId === branch.id && inRange(inv, start));
    const total = invoices.reduce((sum, inv) => sum + invoiceTotal(inv), 0);
    return `- ${branch.name}: ${money(total)} (${invoices.length} invoices)`;
  });
  return ["Branch performance today", ...lines].join("\n");
}

export async function reportCashierPerformance() {
  const snapshot = await loadSnapshot();
  const start = Date.now() - DAY;
  const byCashier = new Map();
  snapshot.invoices.filter((inv) => inRange(inv, start)).forEach((inv) => {
    const key = inv.cashier || inv.cashierId || "Unknown cashier";
    const row = byCashier.get(key) || { count: 0, total: 0 };
    row.count += 1;
    row.total += invoiceTotal(inv);
    byCashier.set(key, row);
  });
  return ["Cashier performance today", ...[...byCashier.entries()].map(([name, row]) => `- ${name}: ${money(row.total)} (${row.count} invoices)`)].join("\n");
}

export async function searchProducts(term) {
  const snapshot = await loadSnapshot();
  const needle = String(term || "").trim().toLowerCase();
  const rows = snapshot.products
    .filter((p) => [p.name, p.sku, p.barcode].some((v) => String(v || "").toLowerCase().includes(needle)))
    .slice(0, 10)
    .map((p) => `- ${p.name} (${p.sku || p.id}) price ${money(productPrice(p))}, cost ${money(productCost(p))}`);
  return rows.length ? ["Product search", ...rows].join("\n") : `No product found for "${term}".`;
}

export async function searchCustomers(term) {
  const snapshot = await loadSnapshot();
  const needle = String(term || "").trim().toLowerCase();
  const rows = snapshot.customers
    .filter((c) => [c.name, c.phone, c.email].some((v) => String(v || "").toLowerCase().includes(needle)))
    .slice(0, 10)
    .map((c) => `- ${c.name || c.id}${c.phone ? ` (${c.phone})` : ""}`);
  return rows.length ? ["Customer search", ...rows].join("\n") : `No customer found for "${term}".`;
}

export async function generateReport(name) {
  const key = String(name || "").toLowerCase();
  if (key.includes("week")) return reportSales({ days: 7 });
  if (key.includes("month")) return reportSales({ days: 30 });
  if (key.includes("invoice")) return reportOutstandingInvoices();
  if (key.includes("expense")) return reportExpenses({ days: 7 });
  if (key.includes("low stock")) return reportLowStock();
  if (key.includes("cashier")) return reportCashierPerformance();
  if (key.includes("branch")) return reportBranchSummary();
  return reportSales({ days: 1 });
}
