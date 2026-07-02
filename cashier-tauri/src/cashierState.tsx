import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { pullCatalog, pushExpense } from "./api";
import { cashierRuleSnapshot, classifyExpense, type ExpenseDecision } from "./cashierRules";
import type { Account, Branch, CartLine, Invoice, TerminalCredentials } from "./types";

export type CashierSessionState = {
  businessName: string;
  cashierName: string;
  dateTime: number;
  online: boolean;
  branchName?: string;
  terminalName?: string;
};

export type SalesTodayState = {
  total: number;
  paidCount: number;
  openCount: number;
  pendingCount: number;
};

export type CashierInvoiceSummary = {
  id: string;
  receiptNo: string;
  customerName: string;
  amount: number;
  openedAt: number;
};

export type CashierDebt = {
  id: string;
  receiptNo: string;
  customerName: string;
  amount: number;
  ageDays: number;
  carriedOver: boolean;
};

export type CashierCartItem = {
  id: string;
  name: string;
  sku?: string;
  qty: number;
  price: number;
  lineTotal: number;
};

export type CashierCartCustomer = {
  name: string;
  outstandingDebt: number;
};

export type CashierCartState = {
  items: CashierCartItem[];
  customer: CashierCartCustomer;
  subtotal: number;
  total: number;
};

export type CashierUpdateState = "idle" | "downloading" | "ready";

export type CashierState = {
  session: CashierSessionState;
  salesToday: SalesTodayState;
  openInvoicesToday: CashierInvoiceSummary[];
  debts: CashierDebt[];
  cart: CashierCartState;
  updateState: CashierUpdateState;
  branch: Branch | null;
  loading: boolean;
  error: string;
};

type CashierStateSource = {
  businessName?: string;
  terminal?: TerminalCredentials | null;
  account?: Account | null;
  branches?: Branch[];
  invoices?: Invoice[];
  cartLines?: CartLine[];
  customerName?: string;
  online?: boolean;
  updateState?: CashierUpdateState;
};

export type CashierStateContextValue = {
  state: CashierState;
  rules: ReturnType<typeof cashierRuleSnapshot>;
  refresh: () => Promise<void>;
  submitExpense: (expense: { category: string; amountCents: number; note?: string }) => Promise<ExpenseDecision>;
  setUpdateState: (state: CashierUpdateState) => void;
};

const CashierStateContext = createContext<CashierStateContextValue | null>(null);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUSINESS_NAME = "VisionPOS";

function invoiceOutstanding(invoice: Invoice) {
  return Math.max(0, Number(invoice.totalCents || 0) - Number(invoice.paidCents || 0));
}

function invoiceTs(invoice: Invoice) {
  return Number(invoice.ts || 0);
}

function startOfToday(ts = Date.now()) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isToday(ts?: number) {
  const value = Number(ts || 0);
  return value >= startOfToday() && value < startOfToday() + DAY_MS;
}

function ageDays(ts?: number) {
  if (!ts) return 0;
  const diff = Date.now() - Number(ts);
  return Math.max(0, Math.floor(diff / DAY_MS));
}

function isPendingInvoice(invoice: Invoice) {
  const status = String(invoice.status || "").toLowerCase();
  return status === "pending" || status === "pending_approval" || status === "approval_pending";
}

function customerKey(value?: string) {
  return String(value || "").trim().toLowerCase();
}

function toInvoiceSummary(invoice: Invoice): CashierInvoiceSummary {
  return {
    id: invoice.id,
    receiptNo: invoice.number || invoice.id,
    customerName: invoice.customerName || "Walk-in",
    amount: invoiceOutstanding(invoice),
    openedAt: invoiceTs(invoice)
  };
}

function toDebt(invoice: Invoice): CashierDebt {
  return {
    id: invoice.id,
    receiptNo: invoice.number || invoice.id,
    customerName: invoice.customerName || "Walk-in",
    amount: invoiceOutstanding(invoice),
    ageDays: ageDays(invoiceTs(invoice)),
    carriedOver: Boolean(invoice.carriedOver)
  };
}

function buildCart(cartLines: CartLine[], customerName: string, invoices: Invoice[]): CashierCartState {
  const items = cartLines.map((line) => ({
    id: line.product.id,
    name: line.product.name,
    sku: line.product.sku,
    qty: line.qty,
    price: line.product.priceCents,
    lineTotal: line.qty * line.product.priceCents
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const key = customerKey(customerName);
  const outstandingDebt = key
    ? invoices
        .filter((invoice) => customerKey(invoice.customerName) === key)
        .reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0)
    : 0;

  return {
    items,
    customer: {
      name: customerName,
      outstandingDebt
    },
    subtotal,
    total: subtotal
  };
}

export function deriveCashierState(source: CashierStateSource): CashierState {
  const branches = source.branches || [];
  const invoices = source.invoices || [];
  const branch = branches.find((item) => item.id === source.terminal?.branchId || item.id === source.account?.branchId) || null;
  const visibleInvoices = source.account?.id
    ? invoices.filter((invoice) => !invoice.cashierId || invoice.cashierId === source.account?.id)
    : invoices;

  const todaysInvoices = visibleInvoices.filter((invoice) => isToday(invoiceTs(invoice)));
  const openInvoicesToday = todaysInvoices
    .filter((invoice) => invoiceOutstanding(invoice) > 0 && !invoice.carriedOver)
    .map(toInvoiceSummary);
  const debts = visibleInvoices
    .filter((invoice) => invoiceOutstanding(invoice) > 0 && invoice.carriedOver)
    .map(toDebt);

  const cart = buildCart(source.cartLines || [], source.customerName || "", visibleInvoices);

  return {
    session: {
      businessName: source.businessName || DEFAULT_BUSINESS_NAME,
      cashierName: source.account?.name || "Cashier",
      dateTime: Date.now(),
      online: source.online ?? true,
      branchName: branch?.name || source.terminal?.branchId || source.account?.branchId || "",
      terminalName: source.terminal?.terminalName || ""
    },
    salesToday: {
      total: todaysInvoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0),
      paidCount: todaysInvoices.filter((invoice) => invoiceOutstanding(invoice) === 0).length,
      openCount: openInvoicesToday.length,
      pendingCount: todaysInvoices.filter(isPendingInvoice).length
    },
    openInvoicesToday,
    debts,
    cart,
    updateState: source.updateState || "idle",
    branch,
    loading: false,
    error: ""
  };
}

export const mockCashierState: CashierState = deriveCashierState({
  businessName: DEFAULT_BUSINESS_NAME,
  online: true,
  updateState: "idle",
  terminal: {
    id: "mock-terminal",
    uuid: "mock-terminal",
    branchId: "b_sip",
    terminalName: "SIPCITY Till",
    terminalSecret: "mock",
    status: "ACTIVE"
  },
  account: {
    id: "mock-cashier",
    kind: "cashier",
    role: "Cashier",
    name: "babu",
    branchId: "b_sip",
    rights: ["sell"]
  },
  branches: [{ id: "b_sip", name: "SIPCITY" }],
  invoices: [
    {
      id: "mock-open-1",
      number: "RCP-B_SIP-153987",
      branchId: "b_sip",
      cashierId: "mock-cashier",
      cashierName: "babu",
      customerName: "Victor M.",
      totalCents: 650000,
      paidCents: 0,
      carriedOver: false,
      status: "open",
      ts: Date.now() - 2 * 60 * 60 * 1000
    },
    {
      id: "mock-debt-1",
      number: "SIP-904329",
      branchId: "b_sip",
      cashierId: "mock-cashier",
      cashierName: "babu",
      customerName: "Naomi W.",
      totalCents: 70000,
      paidCents: 0,
      carriedOver: true,
      status: "open",
      ts: Date.now() - DAY_MS
    }
  ],
  cartLines: [],
  customerName: ""
});

function withLoading(state: CashierState): CashierState {
  return { ...state, loading: true, error: "" };
}

function withError(state: CashierState, error: unknown): CashierState {
  return {
    ...state,
    loading: false,
    error: error instanceof Error ? error.message : String(error || "Unable to load cashier data")
  };
}

export async function fetchCashierStateFromApi(source: CashierStateSource): Promise<CashierState> {
  if (!source.terminal) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    return deriveCashierState({
      ...source,
      branches: mockCashierState.branch ? [mockCashierState.branch] : [],
      invoices: [
        ...mockCashierState.openInvoicesToday.map((invoice) => ({
          id: invoice.id,
          number: invoice.receiptNo,
          branchId: "b_sip",
          customerName: invoice.customerName,
          totalCents: invoice.amount,
          paidCents: 0,
          carriedOver: false,
          ts: invoice.openedAt
        })),
        ...mockCashierState.debts.map((debt) => ({
          id: debt.id,
          number: debt.receiptNo,
          branchId: "b_sip",
          customerName: debt.customerName,
          totalCents: debt.amount,
          paidCents: 0,
          carriedOver: true,
          ts: Date.now() - debt.ageDays * DAY_MS
        }))
      ]
    });
  }

  const catalog = await pullCatalog(source.terminal);
  return deriveCashierState({
    ...source,
    branches: catalog.branches,
    invoices: catalog.invoices
  });
}

export type CashierStateProviderProps = CashierStateSource & {
  children: ReactNode;
};

export function CashierStateProvider({
  children,
  businessName = DEFAULT_BUSINESS_NAME,
  terminal = null,
  account = null,
  branches = [],
  invoices = [],
  cartLines = [],
  customerName = "",
  online,
  updateState = "idle"
}: CashierStateProviderProps) {
  const browserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
  const [currentOnline, setCurrentOnline] = useState(online ?? browserOnline);
  const [currentUpdateState, setCurrentUpdateState] = useState<CashierUpdateState>(updateState);
  const [state, setState] = useState<CashierState>(() =>
    deriveCashierState({
      businessName,
      terminal,
      account,
      branches,
      invoices,
      cartLines,
      customerName,
      online: online ?? browserOnline,
      updateState
    })
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setCurrentOnline(true);
    const handleOffline = () => setCurrentOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setState((prev) => ({
        ...prev,
        session: { ...prev.session, dateTime: Date.now(), online: currentOnline }
      }));
    }, 30000);
    return () => window.clearInterval(timer);
  }, [currentOnline]);

  const refresh = useCallback(async () => {
    setState((prev) => withLoading(prev));
    try {
      const next = await fetchCashierStateFromApi({
        businessName,
        terminal,
        account,
        branches,
        invoices,
        cartLines,
        customerName,
        online: currentOnline,
        updateState: currentUpdateState
      });
      setState(next);
    } catch (error) {
      setState((prev) => withError(prev, error));
    }
  }, [account, branches, businessName, cartLines, currentOnline, currentUpdateState, customerName, invoices, terminal]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const submitExpense = useCallback(
    async (expense: { category: string; amountCents: number; note?: string }) => {
      const decision = classifyExpense(expense.amountCents);
      if (terminal && account) {
        await pushExpense(terminal, account, expense);
        await refresh();
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      return decision;
    },
    [account, refresh, terminal]
  );

  const value = useMemo<CashierStateContextValue>(
    () => ({
      state,
      rules: cashierRuleSnapshot(state.cart.customer, state.session.online),
      refresh,
      submitExpense,
      setUpdateState: setCurrentUpdateState
    }),
    [refresh, state, submitExpense]
  );

  return <CashierStateContext.Provider value={value}>{children}</CashierStateContext.Provider>;
}

export function useCashierState() {
  const context = useContext(CashierStateContext);
  if (!context) throw new Error("useCashierState must be used inside CashierStateProvider");
  return context;
}
