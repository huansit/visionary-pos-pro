import type { Account } from "./types";

export type PaymentMethod = "cash" | "mpesa" | "credit";

export type RuleResult = {
  allowed: boolean;
  reason?: string;
};

export type ExpenseDecision = {
  status: "approved" | "pending";
  requiresApproval: boolean;
  message: string;
};

export type CashierCustomerDebt = {
  name?: string;
  outstandingDebt?: number;
};

export const EXPENSE_APPROVAL_LIMIT_CENTS = 50000;

export function normalizeRole(account?: Pick<Account, "role" | "kind"> | null) {
  return String(account?.role || account?.kind || "").trim().toLowerCase();
}

export function isSupervisorRole(account?: Pick<Account, "role" | "kind"> | null) {
  const role = normalizeRole(account);
  return role === "supervisor" || role === "manager" || role === "admin" || role === "owner";
}

export function cashierCannotSettleInvoices(): RuleResult {
  return {
    allowed: false,
    reason: "Cashiers cannot settle or clear invoices. A supervisor or admin must do this."
  };
}

export function cashierCannotRecordPayments(): RuleResult {
  return {
    allowed: false,
    reason: "Cashiers cannot record invoice payments. Payments are supervisor-only on the admin side."
  };
}

export function cashierCannotCloseDay(): RuleResult {
  return {
    allowed: false,
    reason: "Day close is supervisor-only and is not available on the cashier screen."
  };
}

export function cashierCanApplyUpdates(): RuleResult {
  return { allowed: true };
}

export function offlineBlockRule(online: boolean): RuleResult {
  if (online) return { allowed: true };
  return {
    allowed: false,
    reason: "VisionPOS is web-based and must be online to continue selling."
  };
}

export function hasOutstandingDebt(customer?: CashierCustomerDebt | null) {
  return Number(customer?.outstandingDebt || 0) > 0;
}

export function allowedPaymentMethods(customer?: CashierCustomerDebt | null): PaymentMethod[] {
  return hasOutstandingDebt(customer) ? ["cash", "mpesa"] : ["cash", "mpesa", "credit"];
}

export function canUsePaymentMethod(method: PaymentMethod, customer?: CashierCustomerDebt | null): RuleResult {
  if (method === "credit" && hasOutstandingDebt(customer)) {
    return {
      allowed: false,
      reason: "This customer has outstanding debt. Credit and hold are disabled; use cash or M-Pesa."
    };
  }
  return { allowed: true };
}

export function canHoldSale(customer?: CashierCustomerDebt | null): RuleResult {
  if (hasOutstandingDebt(customer)) {
    return {
      allowed: false,
      reason: "This customer has outstanding debt. Hold is disabled until the debt is cleared."
    };
  }
  return { allowed: true };
}

export function classifyExpense(amountCents: number): ExpenseDecision {
  const safeAmount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (safeAmount <= EXPENSE_APPROVAL_LIMIT_CENTS) {
    return {
      status: "approved",
      requiresApproval: false,
      message: "Expense will be recorded instantly."
    };
  }
  return {
    status: "pending",
    requiresApproval: true,
    message: "Expense is over KES 500 and must be approved by a supervisor."
  };
}

export function assertCashierOnline(online: boolean) {
  const result = offlineBlockRule(online);
  if (!result.allowed) throw new Error(result.reason);
}

export function cashierRuleSnapshot(customer: CashierCustomerDebt | null | undefined, online: boolean) {
  return {
    online: offlineBlockRule(online),
    settleInvoices: cashierCannotSettleInvoices(),
    recordPayments: cashierCannotRecordPayments(),
    closeDay: cashierCannotCloseDay(),
    holdSale: canHoldSale(customer),
    applyUpdates: cashierCanApplyUpdates(),
    paymentMethods: allowedPaymentMethods(customer)
  };
}
