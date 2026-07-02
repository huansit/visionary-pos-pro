import { createContext, createElement, useCallback, useContext, useMemo, useState } from "react";
import {
  AUDIT_TARGETS,
  PRIVILEGED_ACTIONS,
  createAuditEntry,
  deriveDayState,
  invoiceBalance,
  normalizeInvoice,
  normalizeMoney,
  requireSupervisor,
} from "./adminRules.js";

/**
 * @typedef {import("./adminRules.js").AdminAuth} AdminAuth
 * @typedef {import("./adminRules.js").AdminInvoice} AdminInvoice
 * @typedef {import("./adminRules.js").PendingExpense} PendingExpense
 * @typedef {import("./adminRules.js").ExpenseCategory} ExpenseCategory
 * @typedef {import("./adminRules.js").DayState} DayState
 * @typedef {import("./adminRules.js").AuditEntry} AuditEntry
 * @typedef {{
 *   auth: AdminAuth,
 *   invoices: AdminInvoice[],
 *   pendingExpenses: PendingExpense[],
 *   expenseCategories: ExpenseCategory[],
 *   dayState: DayState,
 *   auditLog: AuditEntry[]
 * }} AdminState
 */

const AdminStateContext = createContext(null);

const isoNow = () => new Date().toISOString();

export const mockAdminState = normalizeAdminState({
  auth: { id: "sup_mock", name: "Supervisor", role: "supervisor" },
  invoices: [
    {
      id: "inv_open_1",
      receiptNo: "RCP-B_SIP-153987",
      customerName: "Victor M.",
      items: [{ id: "line_1", name: "KC GINGER 250ML", qty: 4, price: 35000, total: 140000 }],
      total: 650000,
      paid: 0,
      status: "open",
      issuedAt: new Date(Date.now() - 12 * 86400000).toISOString(),
      dueAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      soldBy: "babu",
    },
    {
      id: "inv_paid_1",
      receiptNo: "RCP-B_SIP-853781",
      customerName: "Walk-in",
      items: [{ id: "line_2", name: "ALL SEASONS 1L", qty: 1, price: 200000, total: 200000 }],
      total: 200000,
      paid: 200000,
      status: "paid",
      issuedAt: new Date().toISOString(),
      dueAt: new Date().toISOString(),
      soldBy: "babu",
      paymentMethod: "Cash",
    },
  ],
  pendingExpenses: [
    {
      id: "exp_pending_1",
      amount: 80000,
      source: "Cash till",
      category: "Repairs",
      note: "Fixed the chest freezer hinge",
      cashierName: "babu",
      createdAt: isoNow(),
      status: "pending",
    },
  ],
  expenseCategories: [
    { id: "cat_transport", name: "Transport", icon: "truck", active: true },
    { id: "cat_repairs", name: "Repairs", icon: "wrench", active: true },
    { id: "cat_supplies", name: "Supplies", icon: "package", active: true },
    { id: "cat_airtime", name: "Airtime", icon: "phone", active: true },
  ],
  dayState: { open: true, salesToday: 0, cashTotal: 0, mpesaTotal: 0, expenseTotal: 0, paidCount: 0, openCount: 0 },
  auditLog: [],
});

export const mockAdminApi = {
  async loadState() {
    return mockAdminState;
  },
  async recordAudit(entry) {
    return { ok: true, entry };
  },
  async mutate() {
    return { ok: true };
  },
};

export function normalizeAdminState(state) {
  const invoices = (state?.invoices || []).map((invoice) => normalizeInvoice(invoice));
  const pendingExpenses = (state?.pendingExpenses || []).map((expense) => ({
    id: String(expense.id),
    amount: normalizeMoney(expense.amount ?? expense.amountCents),
    source: expense.source || "Cash till",
    category: expense.category || "Uncategorised",
    note: expense.note || "",
    cashierName: expense.cashierName || expense.cashier || "",
    createdAt: new Date(expense.createdAt || expense.ts || Date.now()).toISOString(),
    status: expense.status || "pending",
  }));
  const expenseCategories = (state?.expenseCategories || []).map((category) => ({
    id: String(category.id),
    name: category.name || "Category",
    icon: category.icon || "wallet",
    active: category.active !== false,
  }));
  const open = state?.dayState?.open !== false;

  return {
    auth: state?.auth || { id: "sup_mock", name: "Supervisor", role: "supervisor" },
    invoices,
    pendingExpenses,
    expenseCategories,
    dayState: state?.dayState ? { ...deriveDayState(invoices, pendingExpenses, open), ...state.dayState } : deriveDayState(invoices, pendingExpenses, open),
    auditLog: Array.isArray(state?.auditLog) ? state.auditLog : [],
  };
}

function withAudit(state, action, targetType, targetId, before, after, meta) {
  const auditEntry = createAuditEntry(state.auth, action, targetType, targetId, before, after, meta);
  return {
    state: { ...state, auditLog: [auditEntry, ...state.auditLog] },
    auditEntry,
  };
}

function recalculate(state, dayOpen = state.dayState.open) {
  return { ...state, dayState: deriveDayState(state.invoices, state.pendingExpenses, dayOpen) };
}

function applyInvoiceMutation(state, invoiceId, action, mutator, meta) {
  requireSupervisor(state.auth, action);
  const before = state.invoices.find((invoice) => invoice.id === invoiceId);
  if (!before) throw Object.assign(new Error("Invoice not found."), { code: "INVOICE_NOT_FOUND", invoiceId });
  const after = normalizeInvoice(mutator(before));
  const invoices = state.invoices.map((invoice) => (invoice.id === invoiceId ? after : invoice));
  const { state: auditedState, auditEntry } = withAudit({ ...state, invoices }, action, AUDIT_TARGETS.INVOICE, invoiceId, before, after, meta);
  return { state: recalculate(auditedState), auditEntry, result: after };
}

function applyExpenseMutation(state, expenseId, action, status, meta) {
  requireSupervisor(state.auth, action);
  const before = state.pendingExpenses.find((expense) => expense.id === expenseId);
  if (!before) throw Object.assign(new Error("Expense not found."), { code: "EXPENSE_NOT_FOUND", expenseId });
  const after = { ...before, status };
  const pendingExpenses = state.pendingExpenses.map((expense) => (expense.id === expenseId ? after : expense));
  const { state: auditedState, auditEntry } = withAudit({ ...state, pendingExpenses }, action, AUDIT_TARGETS.EXPENSE, expenseId, before, after, meta);
  return { state: recalculate(auditedState), auditEntry, result: after };
}

export function createAdminApiClient({ apiBaseUrl = "", fetcher = fetch, deviceToken, sessionToken } = {}) {
  const headers = () => ({
    "Content-Type": "application/json",
    ...(deviceToken ? { "X-Device-Token": deviceToken } : {}),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  });

  async function request(path, options = {}) {
    const response = await fetcher(`${apiBaseUrl}${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Admin API ${path} failed with ${response.status}`);
    return response.json();
  }

  return {
    async loadState() {
      return request("/api/admin/state", { method: "GET" });
    },
    async mutate(action, payload) {
      return request("/api/admin/mutations", { method: "POST", body: JSON.stringify({ action, payload }) });
    },
    async recordAudit(entry) {
      return request("/api/admin/audit", { method: "POST", body: JSON.stringify(entry) });
    },
  };
}

export function AdminStateProvider({ children, initialState = mockAdminState, apiClient = mockAdminApi }) {
  const [state, setState] = useState(() => normalizeAdminState(initialState));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const commit = useCallback(async (operationName, operation) => {
    let mutation;
    setError("");
    setState((current) => {
      mutation = operation(current);
      return mutation.state;
    });
    if (mutation?.auditEntry) await apiClient.recordAudit?.(mutation.auditEntry).catch(() => null);
    await apiClient.mutate?.(operationName, mutation?.result).catch(() => null);
    return mutation?.result;
  }, [apiClient]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await apiClient.loadState?.();
      if (next) setState(normalizeAdminState(next));
    } catch (err) {
      setError(err?.message || "Could not load supervisor data.");
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  const actions = useMemo(() => ({
    refresh,
    settleInvoice: (invoiceId, paidAmount) => commit(PRIVILEGED_ACTIONS.SETTLE_INVOICE, (current) => applyInvoiceMutation(
      current,
      invoiceId,
      PRIVILEGED_ACTIONS.SETTLE_INVOICE,
      (invoice) => {
        const paid = normalizeMoney(paidAmount ?? invoiceBalance(invoice));
        const nextPaid = Math.min(normalizeMoney(invoice.total), normalizeMoney(invoice.paid) + paid);
        return { ...invoice, paid: nextPaid, balance: Math.max(0, normalizeMoney(invoice.total) - nextPaid) };
      },
      { paidAmount: normalizeMoney(paidAmount) }
    )),
    clearInvoice: (invoiceId) => commit(PRIVILEGED_ACTIONS.CLEAR_INVOICE, (current) => applyInvoiceMutation(
      current,
      invoiceId,
      PRIVILEGED_ACTIONS.CLEAR_INVOICE,
      (invoice) => ({ ...invoice, paid: normalizeMoney(invoice.total), balance: 0, status: "paid" }),
      { cleared: true }
    )),
    approveExpense: (expenseId) => commit(PRIVILEGED_ACTIONS.APPROVE_EXPENSE, (current) => applyExpenseMutation(
      current,
      expenseId,
      PRIVILEGED_ACTIONS.APPROVE_EXPENSE,
      "approved"
    )),
    rejectExpense: (expenseId) => commit(PRIVILEGED_ACTIONS.REJECT_EXPENSE, (current) => applyExpenseMutation(
      current,
      expenseId,
      PRIVILEGED_ACTIONS.REJECT_EXPENSE,
      "rejected"
    )),
    closeDay: () => commit(PRIVILEGED_ACTIONS.CLOSE_DAY, (current) => {
      requireSupervisor(current.auth, PRIVILEGED_ACTIONS.CLOSE_DAY);
      const before = current.dayState;
      const after = { ...deriveDayState(current.invoices, current.pendingExpenses, false), open: false };
      const audited = withAudit({ ...current, dayState: after }, PRIVILEGED_ACTIONS.CLOSE_DAY, AUDIT_TARGETS.DAY, "current", before, after);
      return { state: audited.state, auditEntry: audited.auditEntry, result: after };
    }),
    upsertExpenseCategory: (category) => commit(PRIVILEGED_ACTIONS.MANAGE_CATEGORIES, (current) => {
      requireSupervisor(current.auth, PRIVILEGED_ACTIONS.MANAGE_CATEGORIES);
      const before = current.expenseCategories.find((item) => item.id === category.id) || null;
      const after = {
        id: category.id || `cat_${Date.now()}`,
        name: category.name,
        icon: category.icon || "wallet",
        active: category.active !== false,
      };
      const expenseCategories = before
        ? current.expenseCategories.map((item) => (item.id === after.id ? after : item))
        : [...current.expenseCategories, after];
      const audited = withAudit({ ...current, expenseCategories }, PRIVILEGED_ACTIONS.MANAGE_CATEGORIES, AUDIT_TARGETS.EXPENSE_CATEGORY, after.id, before, after);
      return { state: audited.state, auditEntry: audited.auditEntry, result: after };
    }),
    extendCredit: (invoiceId, amount) => commit(PRIVILEGED_ACTIONS.EXTEND_CREDIT, (current) => applyInvoiceMutation(
      current,
      invoiceId,
      PRIVILEGED_ACTIONS.EXTEND_CREDIT,
      (invoice) => ({ ...invoice, total: normalizeMoney(invoice.total) + normalizeMoney(amount), balance: invoiceBalance(invoice) + normalizeMoney(amount), status: "open" }),
      { amount: normalizeMoney(amount) }
    )),
  }), [commit, refresh]);

  const value = useMemo(() => ({ ...state, loading, error, actions }), [actions, error, loading, state]);
  return createElement(AdminStateContext.Provider, { value }, children);
}

export function useAdminState() {
  const value = useContext(AdminStateContext);
  if (!value) throw new Error("useAdminState must be used inside AdminStateProvider.");
  return value;
}
