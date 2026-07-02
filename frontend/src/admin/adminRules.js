const SUPERVISOR_ROLE = "supervisor";

export const PRIVILEGED_ACTIONS = Object.freeze({
  SETTLE_INVOICE: "settle_invoice",
  CLEAR_INVOICE: "clear_invoice",
  APPROVE_EXPENSE: "approve_expense",
  REJECT_EXPENSE: "reject_expense",
  CLOSE_DAY: "close_day",
  MANAGE_CATEGORIES: "manage_categories",
  EXTEND_CREDIT: "extend_credit",
});

export const AUDIT_TARGETS = Object.freeze({
  INVOICE: "invoice",
  EXPENSE: "expense",
  EXPENSE_CATEGORY: "expense_category",
  DAY: "day",
  CREDIT: "credit",
});

/**
 * @typedef {"supervisor"} SupervisorRole
 * @typedef {{ id: string, name: string, role: SupervisorRole }} AdminAuth
 * @typedef {{ id: string, name: string, qty: number, price: number, total: number }} AdminInvoiceItem
 * @typedef {{
 *   id: string,
 *   receiptNo: string,
 *   customerName: string,
 *   items: AdminInvoiceItem[],
 *   total: number,
 *   paid: number,
 *   balance: number,
 *   status: "open" | "paid",
 *   issuedAt: string,
 *   dueAt: string,
 *   soldBy: string,
 *   ageDays: number
 * }} AdminInvoice
 * @typedef {{
 *   id: string,
 *   amount: number,
 *   source: string,
 *   category: string,
 *   note: string,
 *   cashierName: string,
 *   createdAt: string,
 *   status: "pending" | "approved" | "rejected"
 * }} PendingExpense
 * @typedef {{ id: string, name: string, icon: string, active: boolean }} ExpenseCategory
 * @typedef {{
 *   open: boolean,
 *   salesToday: number,
 *   cashTotal: number,
 *   mpesaTotal: number,
 *   expenseTotal: number,
 *   paidCount: number,
 *   openCount: number
 * }} DayState
 * @typedef {{
 *   id: string,
 *   action: string,
 *   targetType: string,
 *   targetId: string,
 *   actorId: string,
 *   actorName: string,
 *   at: string,
 *   before?: unknown,
 *   after?: unknown,
 *   meta?: Record<string, unknown>
 * }} AuditEntry
 */

export function isSupervisor(auth) {
  return Boolean(auth && auth.role === SUPERVISOR_ROLE);
}

export function canPerformPrivilegedAction(auth, action) {
  return isSupervisor(auth) && Object.values(PRIVILEGED_ACTIONS).includes(action);
}

export function requireSupervisor(auth, action) {
  if (canPerformPrivilegedAction(auth, action)) return true;
  const error = new Error("Supervisor role required for this action.");
  error.code = "SUPERVISOR_REQUIRED";
  error.action = action;
  throw error;
}

export function calculateAgeDays(fromDate, now = new Date()) {
  const start = new Date(fromDate).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / 86400000));
}

export function normalizeMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function invoiceBalance(invoice) {
  return Math.max(0, normalizeMoney(invoice?.total) - normalizeMoney(invoice?.paid));
}

export function invoiceStatus(invoice) {
  return invoiceBalance(invoice) > 0 ? "open" : "paid";
}

export function createAuditEntry(auth, action, targetType, targetId, before, after, meta = {}) {
  requireSupervisor(auth, action);
  return {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    action,
    targetType,
    targetId,
    actorId: auth.id,
    actorName: auth.name,
    at: new Date().toISOString(),
    before,
    after,
    meta,
  };
}

export function deriveDayState(invoices = [], pendingExpenses = [], open = true) {
  const paidInvoices = invoices.filter((invoice) => invoice.status === "paid" || invoiceBalance(invoice) === 0);
  const openInvoices = invoices.filter((invoice) => invoice.status === "open" || invoiceBalance(invoice) > 0);
  const approvedExpenses = pendingExpenses.filter((expense) => expense.status === "approved");

  return {
    open,
    salesToday: paidInvoices.reduce((sum, invoice) => sum + normalizeMoney(invoice.total), 0),
    cashTotal: paidInvoices
      .filter((invoice) => invoice.paymentMethod === "Cash")
      .reduce((sum, invoice) => sum + normalizeMoney(invoice.total), 0),
    mpesaTotal: paidInvoices
      .filter((invoice) => invoice.paymentMethod === "M-Pesa")
      .reduce((sum, invoice) => sum + normalizeMoney(invoice.total), 0),
    expenseTotal: approvedExpenses.reduce((sum, expense) => sum + normalizeMoney(expense.amount), 0),
    paidCount: paidInvoices.length,
    openCount: openInvoices.length,
  };
}

export function normalizeInvoice(invoice, now = new Date()) {
  const total = normalizeMoney(invoice.total ?? invoice.totalCents);
  const paid = normalizeMoney(invoice.paid ?? invoice.paidCents);
  const issuedAt = invoice.issuedAt || invoice.ts || new Date().toISOString();
  const dueAt = invoice.dueAt || issuedAt;

  return {
    id: String(invoice.id),
    receiptNo: invoice.receiptNo || invoice.number || invoice.id,
    customerName: invoice.customerName || invoice.customer || "Walk-in",
    items: Array.isArray(invoice.items) ? invoice.items : [],
    total,
    paid,
    balance: Math.max(0, total - paid),
    status: total - paid > 0 ? "open" : "paid",
    issuedAt: new Date(issuedAt).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    soldBy: invoice.soldBy || invoice.cashier || invoice.cashierName || "",
    ageDays: invoice.ageDays ?? calculateAgeDays(issuedAt, now),
  };
}
