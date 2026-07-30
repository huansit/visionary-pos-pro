import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  Barcode,
  Boxes,
  Building2,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  Delete,
  Download,
  FileText,
  Fingerprint,
  Grid2X2,
  Heart,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  MonitorCheck,
  Pencil,
  Search,
  Server,
  ShieldCheck,
  ShoppingCart,
  Send,
  UserRound,
  WalletCards,
  Wine,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import {
  APP_VERSION,
  activateTerminal,
  clearFingerprintTemplateCache,
  connectSyncStream,
  dedupeCatalogProducts,
  type SyncVersionChange,
  loginCashier,
  loginCashierWithFingerprint,
  logout,
  patchInvoiceNote,
  preloadCashierFingerprintTemplate,
  pullCatalog,
  pushCheckout,
  pushExpense,
  requestInvoiceVoid,
  resolveBarcode,
  isTerminalRegistrationError,
  verifyCashierFingerprint,
  verifyCheckoutWithSupervisorPin
} from "./api";
import { clearTerminalCredentials, loadTerminalCredentials, saveTerminalCredentials } from "./secureStore";
import type { Account, Branch, CartLine, CashierJointDebt, ExpenseCategory, Invoice, Product, Receipt, TerminalCredentials } from "./types";

const LAST_CATALOG_KEY = "visionpos:cashier:last-catalog:v2";
const LAST_FINGERPRINT_USER_KEY_PREFIX = "visionpos:cashier:last-fingerprint-user:v1:";
const UPDATE_LOG_KEY = "visionpos:cashier:update-log:v1";
const LEFT_RAIL_COLLAPSED_KEY = "visionpos:cashier:left-rail-collapsed:v2";
const DEFAULT_CASHIER_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { id: "excat_police", name: "Police", icon: "shield", active: true, order: 50 },
  { id: "excat_utilities", name: "Utilities", icon: "zap", active: true, order: 60 },
  { id: "excat_other", name: "Other", icon: "circle", active: true, order: 999 }
];
const CASHIER_EXPENSE_CATEGORY_IDS = new Set(DEFAULT_CASHIER_EXPENSE_CATEGORIES.map((category) => category.id));
const CASHIER_EXPENSE_CATEGORY_NAMES = new Set(DEFAULT_CASHIER_EXPENSE_CATEGORIES.map((category) => category.name.toLowerCase()));
const CASHIER_INACTIVITY_LOGOUT_MS = 15 * 60 * 1000;

type UpdatePrompt = {
  version: string;
  currentVersion: string;
  releaseNotes: string[];
  nativeUpdate: NonNullable<Awaited<ReturnType<typeof check>>>;
};

type CashierUpdateState = "idle" | "downloading" | "ready";
type DrawerSide = "left" | "right";
type InvoiceListMode = "invoices" | "debts";

type CashierJointDebtEntry = {
  debt: CashierJointDebt;
  outstandingCents: number;
};

function money(cents: number) {
  return "KES " + Math.round(cents / 100).toLocaleString();
}

function middleReceipt(receiptNo: string, maxLength = 16) {
  const value = String(receiptNo || "").trim();
  if (value.length <= maxLength) return value;
  const keepStart = Math.max(4, Math.floor((maxLength - 1) / 2));
  const keepEnd = Math.max(6, maxLength - keepStart - 1);
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}

function logUpdateEvent(event: string, details: Record<string, unknown> = {}) {
  const entry = { ts: Date.now(), event, ...details };
  try {
    const current = JSON.parse(localStorage.getItem(UPDATE_LOG_KEY) || "[]");
    const next = Array.isArray(current) ? [entry, ...current].slice(0, 60) : [entry];
    localStorage.setItem(UPDATE_LOG_KEY, JSON.stringify(next));
  } catch {
    localStorage.setItem(UPDATE_LOG_KEY, JSON.stringify([entry]));
  }
  console.info("[visionpos:update]", entry);
}


function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function lastFingerprintUserKey(terminal: TerminalCredentials) {
  return `${LAST_FINGERPRINT_USER_KEY_PREFIX}${terminal.uuid}`;
}

function readLastFingerprintUserId(terminal: TerminalCredentials) {
  try {
    return localStorage.getItem(lastFingerprintUserKey(terminal)) || "";
  } catch {
    return "";
  }
}

function writeLastFingerprintUserId(terminal: TerminalCredentials, accountId: string) {
  try {
    localStorage.setItem(lastFingerprintUserKey(terminal), accountId);
  } catch {
    // Login must keep working even when localStorage is unavailable.
  }
}

function productStock(product: Product) {
  const stock = Number(product.stockQty ?? 0);
  return Number.isFinite(stock) ? stock : 0;
}

function productSaleBlockReason(product: Product, currentQty = 0) {
  const stock = productStock(product);
  if (stock <= 0) return `${product.name} is out of stock and cannot be added.`;
  if (currentQty >= stock) return `Only ${stock} available for ${product.name}.`;
  if (product.priceCents <= 0) return `${product.name} has no selling price set.`;
  if (product.costCents > 0 && product.priceCents < product.costCents) {
    return `${product.name} selling price is below buying price. Edit price before selling.`;
  }
  return "";
}

function productStatusText(product: Product, reservedQty = 0) {
  const stock = Math.max(0, productStock(product) - reservedQty);
  if (stock <= 0) return "Out";
  if (product.priceCents <= 0) return "No price";
  if (product.costCents > 0 && product.priceCents < product.costCents) return "Below cost";
  if (stock <= 5) return "Low";
  return `${stock} in`;
}

function productStatusClass(product: Product, reservedQty = 0) {
  const stock = Math.max(0, productStock(product) - reservedQty);
  if (productSaleBlockReason(product, reservedQty)) return "out";
  if (stock <= 5) return "low";
  return "ok";
}

function productStockLabel(product: Product, reservedQty = 0) {
  const stock = Math.max(0, productStock(product) - reservedQty);
  return `${stock} stock`;
}

function categoryAccentClass(category: string) {
  const value = category.toLowerCase();
  if (value.includes("beer")) return " beer";
  if (value.includes("spirit") || value.includes("whisky") || value.includes("vodka") || value.includes("gin")) return " spirits";
  if (value.includes("wine")) return " wine";
  if (value.includes("mixer") || value.includes("soft") || value.includes("soda")) return " mixers";
  return "";
}

function receiptPageHeightMm(receipt: Receipt) {
  const itemLines = receipt.items.reduce((total, item) => total + Math.max(2, Math.ceil(item.name.length / 30)), 0);
  const noteLines = receipt.note ? Math.max(1, Math.ceil(receipt.note.length / 34)) : 0;
  return Math.max(120, Math.min(1000, 78 + itemLines * 7 + noteLines * 6));
}

function receiptPrintHtml(receipt: Receipt) {
  const pageHeightMm = receiptPageHeightMm(receipt);
  const lines = receipt.items.map((item) => `
    <div class="line">
      <strong>${escapeHtml(item.name)}</strong>
      <div class="line-detail">
        <span>${escapeHtml(String(item.qty))} x ${escapeHtml(money(item.priceCents))}</span>
        <b>${escapeHtml(money(item.qty * item.priceCents))}</b>
      </div>
    </div>
  `).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt ${escapeHtml(receipt.number)}</title>
  <style>
    @page { size: 80mm ${pageHeightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html { width: 80mm; background: #fff; }
    body {
      margin: 0;
      width: 80mm;
      min-height: 1px;
      padding: 3mm;
      color: #000;
      background: #fff;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      writing-mode: horizontal-tb;
    }
    .receipt { width: 74mm; }
    h1 { margin: 0 0 6px; text-align: center; font-size: 20px; line-height: 1.15; font-weight: 900; }
    p { margin: 2px 0; text-align: center; }
    hr { border: 0; border-top: 1px dashed #000; margin: 7px 0; }
    .line {
      display: block;
      padding: 3px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .line strong { display: block; font-weight: 700; }
    .line-detail, .total {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 3mm;
    }
    .line-detail { margin-top: 1px; }
    .line-detail span { min-width: 0; }
    .line-detail b, .total b { white-space: nowrap; text-align: right; }
    .total { margin-top: 2px; font-size: 18px; line-height: 1.2; font-weight: 900; }
    @media print {
      html, body { width: 80mm; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <main class="receipt">
  <h1>${escapeHtml(receipt.branchName)}</h1>
  <p>${escapeHtml(new Date(receipt.ts).toLocaleString())}</p>
  <p>Receipt: ${escapeHtml(receipt.number)}</p>
  <p>Cashier: ${escapeHtml(receipt.cashierName)}</p>
  <p>Customer: ${escapeHtml(receipt.customerName)}</p>
  ${receipt.note ? `<p>Note: ${escapeHtml(receipt.note)}</p>` : ""}
  <hr />
  ${lines}
  <hr />
  <div class="total"><span>Total</span><b>${escapeHtml(money(receipt.totalCents))}</b></div>
  <p>Open invoice - not paid at checkout.</p>
  <p>Thank you.</p>
  </main>
</body>
</html>`;
}

const THERMAL_RECEIPT_COLUMNS = 42;

function thermalCenter(value: string) {
  const text = value.trim().slice(0, THERMAL_RECEIPT_COLUMNS);
  return `${" ".repeat(Math.max(0, Math.floor((THERMAL_RECEIPT_COLUMNS - text.length) / 2)))}${text}`;
}

function thermalLine(left: string, right: string) {
  const amount = right.trim();
  const available = Math.max(1, THERMAL_RECEIPT_COLUMNS - amount.length - 1);
  const label = left.trim().slice(0, available);
  return `${label}${" ".repeat(Math.max(1, THERMAL_RECEIPT_COLUMNS - label.length - amount.length))}${amount}`;
}

function thermalWrap(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > THERMAL_RECEIPT_COLUMNS) {
      if (current) lines.push(current);
      for (let index = 0; index < word.length; index += THERMAL_RECEIPT_COLUMNS) {
        lines.push(word.slice(index, index + THERMAL_RECEIPT_COLUMNS));
      }
      current = "";
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > THERMAL_RECEIPT_COLUMNS) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function thermalItemLines(item: Receipt["items"][number]) {
  return [
    ...thermalWrap(item.name),
    thermalLine(`  ${item.qty} x ${money(item.priceCents)}`, money(item.qty * item.priceCents)),
  ];
}

function receiptPrintText(receipt: Receipt) {
  const separator = "-".repeat(THERMAL_RECEIPT_COLUMNS);
  return [
    thermalCenter(receipt.branchName),
    thermalCenter(new Date(receipt.ts).toLocaleString()),
    "",
    `Receipt: ${receipt.number}`,
    `Cashier: ${receipt.cashierName}`,
    `Customer: ${receipt.customerName}`,
    ...(receipt.note ? [`Note: ${receipt.note}`] : []),
    separator,
    ...receipt.items.flatMap(thermalItemLines),
    separator,
    thermalLine("TOTAL", money(receipt.totalCents)),
    "",
    thermalCenter("OPEN INVOICE - NOT PAID"),
    thermalCenter("Thank you"),
  ].join("\n");
}

function printReceiptWithDialog(receipt: Receipt) {
  const frame = document.createElement("iframe");
  frame.title = "Receipt print";
  frame.style.position = "fixed";
  frame.style.left = "-10000px";
  frame.style.top = "0";
  frame.style.width = "80mm";
  frame.style.height = `${receiptPageHeightMm(receipt)}mm`;
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  let printed = false;
  let cleanupTimer = 0;
  const cleanup = () => {
    if (cleanupTimer) window.clearTimeout(cleanupTimer);
    frame.remove();
  };

  frame.onload = async () => {
    if (printed) return;
    printed = true;
    const printWindow = frame.contentWindow;
    const printDocument = frame.contentDocument;
    if (!printWindow || !printDocument) {
      cleanup();
      return;
    }

    await printDocument.fonts?.ready.catch(() => undefined);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });

    printWindow.addEventListener("afterprint", cleanup, { once: true });
    printWindow.focus();
    printWindow.print();
    cleanupTimer = window.setTimeout(cleanup, 30_000);
  };

  frame.srcdoc = receiptPrintHtml(receipt);
  document.body.appendChild(frame);
}

async function printReceipt(receipt: Receipt) {
  try {
    await invoke<string>("print_thermal_receipt", { receiptText: receiptPrintText(receipt) });
  } catch (error) {
    console.warn("Direct receipt printing unavailable; opening the system print dialog.", error);
    printReceiptWithDialog(receipt);
  }
}

function saveCatalog(
  branches: Branch[],
  products: Product[],
  invoices: Invoice[],
  cashierJointDebts: CashierJointDebt[],
  expenseCategories: ExpenseCategory[],
  dayClosedAt: number | null
) {
  const savedAt = Date.now();
  localStorage.setItem(LAST_CATALOG_KEY, JSON.stringify({
    branches,
    products: dedupeCatalogProducts(products),
    invoices,
    cashierJointDebts,
    expenseCategories,
    dayClosedAt,
    savedAt
  }));
  return savedAt;
}

function loadCatalog(): {
  branches: Branch[];
  products: Product[];
  invoices: Invoice[];
  cashierJointDebts: CashierJointDebt[];
  expenseCategories: ExpenseCategory[];
  dayClosedAt: number | null;
  savedAt?: number;
} {
  try {
    const raw = localStorage.getItem(LAST_CATALOG_KEY);
    if (!raw) return { branches: [], products: [], invoices: [], cashierJointDebts: [], expenseCategories: DEFAULT_CASHIER_EXPENSE_CATEGORIES, dayClosedAt: null };
    const parsed = JSON.parse(raw);
    const products = dedupeCatalogProducts(Array.isArray(parsed.products) ? parsed.products : []);
    const parsedClose = Number(parsed.dayClosedAt || 0);
    const repaired = {
      branches: parsed.branches || [],
      products,
      invoices: parsed.invoices || [],
      cashierJointDebts: Array.isArray(parsed.cashierJointDebts) ? parsed.cashierJointDebts : [],
      expenseCategories: Array.isArray(parsed.expenseCategories) && parsed.expenseCategories.length ? parsed.expenseCategories : DEFAULT_CASHIER_EXPENSE_CATEGORIES,
      dayClosedAt: Number.isFinite(parsedClose) && parsedClose > 0 ? parsedClose : null,
      savedAt: parsed.savedAt
    };
    localStorage.setItem(LAST_CATALOG_KEY, JSON.stringify(repaired));
    return repaired;
  } catch {
    return { branches: [], products: [], invoices: [], cashierJointDebts: [], expenseCategories: DEFAULT_CASHIER_EXPENSE_CATEGORIES, dayClosedAt: null };
  }
}

function cashierManagedExpenseCategories(categories: ExpenseCategory[]) {
  const scoped = (categories || [])
    .filter((category) => category.active !== false)
    .filter((category) => CASHIER_EXPENSE_CATEGORY_IDS.has(category.id) || CASHIER_EXPENSE_CATEGORY_NAMES.has(category.name.toLowerCase()))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));
  return scoped.length ? scoped : DEFAULT_CASHIER_EXPENSE_CATEGORIES;
}

function syncLabel(ts?: number) {
  if (!ts) return "Not synced yet";
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  return new Date(ts).toLocaleString();
}

function outstanding(invoice: Invoice) {
  return Math.max(0, Number(invoice.totalCents || 0) - Number(invoice.paidCents || 0));
}

function isToday(ts?: number) {
  if (!ts) return false;
  const date = new Date(ts);
  const today = new Date();
  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}

function isPendingVoidInvoice(invoice: Invoice) {
  return invoice.voidRequestStatus === "pending";
}

function timeShort(ts?: number) {
  if (!ts) return "--:--";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function railDateLabel(ts: number) {
  return new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function railTimeLabel(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function invoiceCustomerLabel(invoice: Invoice) {
  const name = String(invoice.customerName || "").trim();
  return name.length > 1 ? name : invoice.number || "Open invoice";
}

function avatarInitial(label: string) {
  return (label.trim().charAt(0) || "I").toUpperCase();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function invoiceAgeDays(invoice: Invoice) {
  if (!invoice.ts) return 0;
  return Math.max(0, Math.floor((Date.now() - Number(invoice.ts)) / DAY_MS));
}

function isOverdueOpenInvoice(invoice: Invoice) {
  return outstanding(invoice) > 0 && !invoice.carriedOver && invoiceAgeDays(invoice) >= 1;
}

function invoiceDueDate(invoice: Invoice) {
  if (!invoice.ts) return "Not set";
  if (invoice.carriedOver) return "Carried at end of day";
  return new Date(Number(invoice.ts) + DAY_MS).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function invoiceAgeText(invoice: Invoice) {
  const ageDays = invoiceAgeDays(invoice);
  if (invoice.carriedOver) return "Cashier debt";
  if (isOverdueOpenInvoice(invoice)) return `${Math.max(1, ageDays)}d overdue`;
  if (ageDays <= 0) return "Due today";
  return `${ageDays}d old`;
}

function cashierJointDebtEntries(debts: CashierJointDebt[], account: Account | null, branchId?: string): CashierJointDebtEntry[] {
  if (!account) return [];
  const accountName = normalize(account.name || "");
  return debts.flatMap((debt) => {
    if (branchId && debt.branchId !== branchId) return [];
    const share = debt.shares.find((entry) => entry.cashierId === account.id)
      || debt.shares.find((entry) => accountName && normalize(entry.cashierName || "") === accountName);
    if (!share) return [];
    const outstandingCents = Math.max(0, Number(share.amountCents || 0) - Number(share.paidCents || 0));
    return outstandingCents > 0 ? [{ debt, outstandingCents }] : [];
  }).sort((a, b) => Number(b.debt.ts || 0) - Number(a.debt.ts || 0));
}

function invoiceSearchText(invoice: Invoice) {
  const extra = invoice as Invoice & { customerPhone?: string; phone?: string; customerId?: string };
  return [
    invoice.customerName,
    invoice.number,
    extra.customerPhone,
    extra.phone,
    extra.customerId
  ].filter(Boolean).join(" ").toLowerCase();
}

function invoiceDate(invoice: Invoice) {
  return invoice.ts ? new Date(invoice.ts).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not dated";
}

function useScanner(onScan: (barcode: string) => void, enabled = true) {
  const buffer = useRef("");
  const lastAt = useRef(0);
  const lastScan = useRef({ code: "", at: 0 });

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (["F1", "F2", "F3", "F4", "F5", "F6", "Escape", "Delete"].includes(event.key)) return;
      const now = Date.now();
      if (now - lastAt.current > 80) buffer.current = "";
      lastAt.current = now;

      if (event.key === "Enter" || event.key === "Tab") {
        const code = buffer.current.trim();
        buffer.current = "";
        if (code.length >= 4) {
          if (lastScan.current.code === code && now - lastScan.current.at < 900) return;
          lastScan.current = { code, at: now };
          event.preventDefault();
          onScan(code);
        }
        return;
      }

      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        buffer.current += event.key;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, onScan]);
}

export default function App() {
  const [terminal, setTerminal] = useState<TerminalCredentials | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [cashierJointDebts, setCashierJointDebts] = useState<CashierJointDebt[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategory[]>(DEFAULT_CASHIER_EXPENSE_CATEGORIES);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All Products");
  const [customerName, setCustomerName] = useState("");
  const [status, setStatus] = useState("Starting VISIONPOS Cashier...");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  const [checkoutFingerprintOpen, setCheckoutFingerprintOpen] = useState(false);
  const [scannerOn, setScannerOn] = useState(true);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [invoiceListMode, setInvoiceListMode] = useState<InvoiceListMode | null>(null);
  const [invoiceDetail, setInvoiceDetail] = useState<{ invoice: Invoice; side: DrawerSide } | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<UpdatePrompt | null>(null);
  const [updateState, setUpdateState] = useState<CashierUpdateState>("idle");
  const [updateInstallOpen, setUpdateInstallOpen] = useState(false);
  const [updateToastDismissed, setUpdateToastDismissed] = useState(false);
  const [restartWhenCartEmpty, setRestartWhenCartEmpty] = useState(false);
  const [latestUpdateNotice, setLatestUpdateNotice] = useState(false);
  const [dayClosedAt, setDayClosedAt] = useState<number | null>(null);
  const [dayCloseNoticeAt, setDayCloseNoticeAt] = useState<number | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return localStorage.getItem(LEFT_RAIL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [now, setNow] = useState(Date.now());
  const [realtimeState, setRealtimeState] = useState<"connected" | "reconnecting">("reconnecting");
  const [lastSyncAt, setLastSyncAt] = useState<number | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const catalogSyncInFlight = useRef(false);
  const catalogSyncPending = useRef(false);
  const updateCheckInFlight = useRef(false);
  const updateStateRef = useRef<CashierUpdateState>("idle");
  const dayClosedAtRef = useRef<number | null>(null);

  const branch = branches.find((item) => item.id === terminal?.branchId) || null;
  const cartLines = Object.values(cart);
  const totalCents = cartLines.reduce((sum, line) => sum + line.qty * line.product.priceCents, 0);
  const itemCount = cartLines.reduce((sum, line) => sum + line.qty, 0);
  const myInvoices = useMemo(() => {
    if (!account?.id) return [];
    const accountName = normalize(account.name || "");
    return invoices.filter((invoice) => {
      if (invoice.cashierId === account.id) return true;
      const invoiceCashierName = normalize(invoice.cashierName || "");
      if (accountName && invoiceCashierName === accountName) return true;
      // Keep legacy invoices that predate cashier identity fields visible.
      return !invoice.cashierId && !invoiceCashierName;
    });
  }, [account?.id, account?.name, invoices]);
  const businessDayInvoices = useMemo(() => myInvoices.map((invoice) => {
    const invoiceTs = Number(invoice.ts || 0);
    return dayClosedAt && invoiceTs > 0 && invoiceTs <= dayClosedAt && outstanding(invoice) > 0
      ? { ...invoice, carriedOver: true }
      : invoice;
  }), [dayClosedAt, myInvoices]);
  const openInvoices = useMemo(() => businessDayInvoices.filter((invoice) => outstanding(invoice) > 0 && !invoice.carriedOver && invoice.voidRequestStatus !== "approved"), [businessDayInvoices]);
  const overdueInvoices = useMemo(() => openInvoices.filter(isOverdueOpenInvoice), [openInvoices]);
  const currentOpenInvoices = useMemo(() => openInvoices.filter((invoice) => !isOverdueOpenInvoice(invoice)), [openInvoices]);
  const carriedDebts = useMemo(() => businessDayInvoices.filter((invoice) => outstanding(invoice) > 0 && invoice.carriedOver && invoice.voidRequestStatus !== "approved"), [businessDayInvoices]);
  const inventoryDebtEntries = useMemo(
    () => cashierJointDebtEntries(cashierJointDebts, account, terminal?.branchId),
    [account, cashierJointDebts, terminal?.branchId]
  );
  const activeTodayInvoices = useMemo(
    () => businessDayInvoices.filter((invoice) => (
      invoice.voidRequestStatus !== "approved"
      && (dayClosedAt ? Number(invoice.ts || 0) > dayClosedAt : isToday(invoice.ts))
    )),
    [businessDayInvoices, dayClosedAt]
  );
  const openInvoicesToday = useMemo(() => activeTodayInvoices.filter((invoice) => outstanding(invoice) > 0 && !invoice.carriedOver && invoice.voidRequestStatus !== "approved"), [activeTodayInvoices]);
  const paidTodayCount = activeTodayInvoices.filter((invoice) => outstanding(invoice) <= 0).length;
  const pendingTodayCount = activeTodayInvoices.filter(isPendingVoidInvoice).length;
  const ordinaryOpenTodayCount = openInvoicesToday.filter((invoice) => !isPendingVoidInvoice(invoice)).length;
  const openInvoiceTotal = openInvoices.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const carriedDebtTotal = carriedDebts.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const inventoryDebtTotal = inventoryDebtEntries.reduce((sum, entry) => sum + entry.outstandingCents, 0);
  const debtTrackerTotal = carriedDebtTotal + inventoryDebtTotal;
  const cashierDebtCount = carriedDebts.length + inventoryDebtEntries.length;
  const salesInvoiceTotal = activeTodayInvoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0);
  const customerDebtInvoices = useMemo(() => {
    const customerKey = normalize(customerName);
    if (customerKey.length < 2) return [];
    return carriedDebts.filter((invoice) => {
      const invoiceCustomer = normalize(invoice.customerName || "");
      return invoiceCustomer === customerKey;
    });
  }, [carriedDebts, customerName]);
  const customerOutstandingDebt = customerDebtInvoices.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const creditLocked = customerOutstandingDebt > 0;
  const canCompleteSale = cartLines.length > 0
    && Boolean(customerName.trim())
    && !creditLocked;
  const updateStatusLabelRaw = updatePrompt
    ? `v${updatePrompt.version} available`
    : updateState === "downloading"
      ? `v${APP_VERSION} · downloading`
      : `v${APP_VERSION} · up to date`;
  const updateStatusLabel = updateStatusLabelRaw
    .replace("· downloading", "- checking")
    .replace("· up to date", "- up to date");
  const session = useMemo(() => ({
    businessName: "VisionPOS",
    cashierName: account?.name || "Cashier",
    dateTime: now,
    online
  }), [account?.name, now, online]);

  const categories = useMemo(() => {
    const names = Array.from(new Set(products.map((product) => product.category || "Uncategorised").filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return ["All Products", ...names.slice(0, 5)];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = normalize(query);
    const scoped = selectedCategory === "All Products"
      ? products
      : products.filter((product) => (product.category || "Uncategorised") === selectedCategory);
    if (!q) return scoped;
    return scoped.filter((product) => {
      const haystack = [product.name, product.sku, product.barcode, product.category, ...(product.barcodes || [])].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [products, query, selectedCategory]);

  const focusSearch = () => setTimeout(() => searchRef.current?.focus(), 20);

  function retainLatestDayClose(candidate: number | null | undefined) {
    const parsed = Number(candidate || 0);
    const current = Number(dayClosedAtRef.current || 0);
    const latest = Math.max(current, Number.isFinite(parsed) ? parsed : 0);
    dayClosedAtRef.current = latest > 0 ? latest : null;
    setDayClosedAt(dayClosedAtRef.current);
    return dayClosedAtRef.current;
  }

  async function resetInvalidTerminalRegistration() {
    await clearTerminalCredentials();
    clearFingerprintTemplateCache();
    setTerminal(null);
    setAccount(null);
    setSessionToken("");
    setBranches([]);
    setProducts([]);
    setInvoices([]);
    setCashierJointDebts([]);
    setExpenseCategories(DEFAULT_CASHIER_EXPENSE_CATEGORIES);
    dayClosedAtRef.current = null;
    setDayClosedAt(null);
    resetCashierSessionUi();
    catalogSyncPending.current = false;
    setStatus("Terminal registration reset.");
    setError("This terminal is no longer registered. Enter a new activation code.");
  }

  useEffect(() => {
    loadTerminalCredentials().then((stored) => {
      const cached = loadCatalog();
      setBranches(cached.branches);
      setProducts(cached.products);
      setInvoices(cached.invoices);
      setCashierJointDebts(cached.cashierJointDebts);
      setExpenseCategories(cashierManagedExpenseCategories(cached.expenseCategories));
      retainLatestDayClose(cached.dayClosedAt);
      setLastSyncAt(cached.savedAt);
      if (stored) {
        setTerminal(stored);
        setStatus("Terminal registered.");
        refreshCatalog(stored);
      } else {
        setStatus("Register this terminal with an activation code.");
      }
    }).catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    if (account) focusSearch();
  }, [account]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleResize = () => {
      if (window.innerWidth < 900) setLeftCollapsed(true);
    };
    handleResize();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_RAIL_COLLAPSED_KEY, leftCollapsed ? "1" : "0");
    } catch {
      // Local storage is best-effort. The layout still works without persistence.
    }
  }, [leftCollapsed]);

  useEffect(() => {
    updateStateRef.current = updateState;
  }, [updateState]);

  async function checkForUpdates(manual = false) {
    if (updateCheckInFlight.current) return;
    if (updateStateRef.current === "ready") {
      if (manual && updatePrompt) setStatus(`Update ${updatePrompt.version} is available.`);
      return;
    }
    updateCheckInFlight.current = true;
    setUpdateState("downloading");
    if (manual) setStatus("Checking for desktop updates...");
    try {
      logUpdateEvent("check_started", { manual, currentVersion: APP_VERSION });
      const update = await check({ timeout: 5_000 });

      if (!update) {
        logUpdateEvent("already_current", { manual, currentVersion: APP_VERSION });
        setUpdatePrompt(null);
        setUpdateToastDismissed(false);
        setUpdateState("idle");
        if (manual) {
          setStatus(`VISIONPOS Cashier ${APP_VERSION} is up to date.`);
          setLatestUpdateNotice(true);
        }
        return;
      }

      logUpdateEvent("update_available", { currentVersion: APP_VERSION, version: update.version });
      setUpdatePrompt({
        version: update.version,
        currentVersion: APP_VERSION,
        releaseNotes: update.body ? update.body.split(/\r?\n/).filter(Boolean) : [],
        nativeUpdate: update
      });
      setUpdateToastDismissed(false);
      setUpdateState("ready");
      setStatus(`Update ${update.version} is available. Install it when the cart is clear.`);
    } catch (err) {
      const message = String(err);
      logUpdateEvent("check_failed", { manual, currentVersion: APP_VERSION, message });
      setUpdateState("idle");
      if (manual) setError(`Update check failed: ${message}`);
    } finally {
      updateCheckInFlight.current = false;
    }
  }

  useEffect(() => {
    checkForUpdates(false);
    const intervalId = window.setInterval(() => checkForUpdates(false), 30 * 60 * 1000);
    const onFocus = () => checkForUpdates(false);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (!account && updatePrompt && updateState === "ready") {
      setUpdateToastDismissed(true);
      setUpdateInstallOpen(true);
    }
  }, [account, updatePrompt, updateState]);

  useEffect(() => {
    if (restartWhenCartEmpty && updateState === "ready" && cartLines.length === 0) {
      void restartForUpdate();
    }
  }, [cartLines.length, restartWhenCartEmpty, updateState]);

  useEffect(() => {
    if (!terminal) return;
    const syncQuietly = () => refreshCatalog(terminal, { silent: true });
    let realtimeTimer: number | undefined;
    const scheduleRealtimeSync = (change?: SyncVersionChange) => {
      const marker = JSON.stringify(change || {}).toLowerCase();
      if (marker.includes("day_closed") || marker.includes("endofday") || marker.includes("end_of_day")) {
        const nestedPayload = change?.payload || {};
        const nestedChange = change?.change || {};
        const tsValue = Number(
          change?.ts ||
          nestedPayload.ts ||
          nestedPayload.closedAt ||
          nestedChange.ts ||
          nestedChange.closedAt ||
          Date.now()
        );
        handleDayClosed(Number.isFinite(tsValue) ? tsValue : Date.now());
      }
      window.clearTimeout(realtimeTimer);
      realtimeTimer = window.setTimeout(syncQuietly, 150);
    };
    const disconnectStream = connectSyncStream(terminal, scheduleRealtimeSync, setRealtimeState);
    const intervalId = window.setInterval(syncQuietly, 30000);
    const onFocus = () => syncQuietly();
    const onOnline = () => syncQuietly();
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncQuietly();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disconnectStream();
      window.clearTimeout(realtimeTimer);
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [terminal?.uuid]);

  useScanner((barcode) => handleScan(barcode), Boolean(account) && scannerOn);

  useEffect(() => {
    if (!account) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        focusSearch();
      }
      if (event.key === "F4") {
        event.preventDefault();
        completeSale();
      }
      if (event.key === "F6") {
        event.preventDefault();
        if (cartLines.length) {
          setCart({});
          setCustomerName("");
          setStatus("Sale held. Start a new invoice when ready.");
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery("");
        focusSearch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [account, cartLines.length, customerName, totalCents]);

  useEffect(() => {
    if (!account) return;
    let timer: number | undefined;
    let endingSession = false;
    let lastActivityAt = Date.now();
    const expireSession = () => {
      if (endingSession) return;
      endingSession = true;
      if (timer) window.clearTimeout(timer);
      void handleLogout("inactivity");
    };
    const checkIdle = () => {
      if (endingSession) return;
      const remaining = CASHIER_INACTIVITY_LOGOUT_MS - (Date.now() - lastActivityAt);
      if (remaining <= 0) {
        expireSession();
        return;
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(checkIdle, remaining);
    };
    const recordActivity = (event: Event) => {
      if (endingSession || event.isTrusted === false) return;
      if (Date.now() - lastActivityAt >= CASHIER_INACTIVITY_LOGOUT_MS) {
        expireSession();
        return;
      }
      lastActivityAt = Date.now();
      checkIdle();
    };
    const verifyActiveSession = () => {
      if (!document.hidden) checkIdle();
    };
    const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "pointerdown", "wheel", "scroll"];
    checkIdle();
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));
    window.addEventListener("focus", verifyActiveSession);
    window.addEventListener("pageshow", verifyActiveSession);
    document.addEventListener("visibilitychange", verifyActiveSession);
    return () => {
      if (timer) window.clearTimeout(timer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
      window.removeEventListener("focus", verifyActiveSession);
      window.removeEventListener("pageshow", verifyActiveSession);
      document.removeEventListener("visibilitychange", verifyActiveSession);
    };
  }, [account?.id, sessionToken]);

  async function refreshCatalog(nextTerminal = terminal, options: { silent?: boolean } = {}) {
    if (!nextTerminal) return;
    if (catalogSyncInFlight.current) {
      catalogSyncPending.current = true;
      return;
    }
    catalogSyncInFlight.current = true;
    try {
      do {
        catalogSyncPending.current = false;
        try {
          if (!options.silent) setStatus("Syncing products...");
          const pulled = await pullCatalog(nextTerminal);
          const effectiveDayClosedAt = retainLatestDayClose(pulled.dayClosedAt);
          const effectiveInvoices = pulled.invoices.map((invoice) => {
            const invoiceTs = Number(invoice.ts || 0);
            return effectiveDayClosedAt && invoiceTs > 0 && invoiceTs <= effectiveDayClosedAt && outstanding(invoice) > 0
              ? { ...invoice, carriedOver: true }
              : invoice;
          });
          setBranches(pulled.branches);
          setProducts(pulled.products);
          setInvoices(effectiveInvoices);
          setCashierJointDebts(pulled.cashierJointDebts);
          const currentExpenseCategories = cashierManagedExpenseCategories(pulled.expenseCategories);
          setExpenseCategories(currentExpenseCategories);
          setLastSyncAt(saveCatalog(
            pulled.branches,
            pulled.products,
            effectiveInvoices,
            pulled.cashierJointDebts,
            currentExpenseCategories,
            effectiveDayClosedAt
          ));
          setStatus(`Connected. Synced ${pulled.products.length} products, ${effectiveInvoices.length} invoices and ${pulled.cashierJointDebts.length} inventory debts.`);
          setError("");
        } catch (err) {
          if (isTerminalRegistrationError(err)) {
            await resetInvalidTerminalRegistration();
            return;
          }
          if (!options.silent) setStatus("Using last cached catalog.");
          setError(String(err));
        }
      } while (catalogSyncPending.current);
    } finally {
      catalogSyncInFlight.current = false;
    }
  }

  async function handleScan(barcode: string) {
    setQuery(barcode);
    const local = products.find((product) => {
      const codes = [product.barcode, product.sku, ...(product.barcodes || [])].filter(Boolean).map((value) => normalize(String(value)));
      return codes.includes(normalize(barcode));
    });
    if (local) {
      if (addToCart(local)) setStatus(`Added ${local.name}`);
      focusSearch();
      return;
    }
    if (!terminal) return;
    try {
      const remote = await resolveBarcode(terminal, barcode);
      if (!remote) {
        setError("This product is not available in this branch.");
        focusSearch();
        return;
      }
      setProducts((current) => [...current.filter((item) => item.id !== remote.id), remote].sort((a, b) => a.name.localeCompare(b.name)));
      if (addToCart(remote)) setStatus(`Added ${remote.name}`);
    } catch (err) {
      setError(String(err));
    } finally {
      focusSearch();
    }
  }

  function addToCart(product: Product) {
    const currentQty = cart[product.id]?.qty || 0;
    const blocked = productSaleBlockReason(product, currentQty);
    if (blocked) {
      setError(blocked);
      setStatus("Sale blocked.");
      setQuery("");
      focusSearch();
      return false;
    }
    setCart((current) => ({
      ...current,
      [product.id]: { product, qty: (current[product.id]?.qty || 0) + 1 }
    }));
    setQuery("");
    setError("");
    return true;
  }

  function changeQty(productId: string, delta: number) {
    setCart((current) => {
      const line = current[productId];
      if (!line) return current;
      const qty = line.qty + delta;
      if (qty <= 0) {
        const { [productId]: _removed, ...rest } = current;
        return rest;
      }
      const blocked = productSaleBlockReason(line.product, qty - 1);
      if (blocked) {
        setError(blocked);
        setStatus("Sale blocked.");
        return current;
      }
      setError("");
      return { ...current, [productId]: { ...line, qty } };
    });
    focusSearch();
  }

  function completeSale() {
    if (!terminal || !account || !canCompleteSale) return;
    setCheckoutFingerprintOpen(true);
  }

  async function issueInvoiceAfterAuthorization(authorize: () => Promise<void>) {
    if (!terminal || !account || !canCompleteSale) return;
    setError("");
    const unavailable = cartLines.find((line) => productSaleBlockReason(line.product, line.qty - 1));
    if (unavailable) {
      setError(productSaleBlockReason(unavailable.product, unavailable.qty - 1));
      setStatus("Sale blocked by stock control.");
      focusSearch();
      return;
    }
    const receiptNumber = `RCP-${terminal.branchId.toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const nextReceipt: Receipt = {
      number: receiptNumber,
      branchName: branch?.name || terminal.branchId,
      cashierName: account.name,
      customerName: customerName.trim(),
      note: "",
      totalCents,
      ts: Date.now(),
      items: cartLines.map((line) => ({
        productId: line.product.id,
        name: line.product.name,
        qty: line.qty,
        priceCents: line.product.priceCents
      }))
    };
    try {
      await authorize();
      const assignedReceiptNumber = await pushCheckout(terminal, account, nextReceipt);
      const issuedReceipt = { ...nextReceipt, number: assignedReceiptNumber };
      setReceipt(issuedReceipt);
      setLastReceipt(issuedReceipt);
      setCart({});
      setCustomerName("");
      setCheckoutFingerprintOpen(false);
      setStatus(`Open invoice ${assignedReceiptNumber} issued.`);
      refreshCatalog(terminal);
    } catch (err) {
      const message = `Checkout failed: ${String(err).replace(/^Error:\s*/, "")}`;
      setError(message);
      throw new Error(message);
    } finally {
      focusSearch();
    }
  }

  async function issueInvoiceAfterFingerprint() {
    if (!terminal || !account) return;
    await issueInvoiceAfterAuthorization(async () => {
      const verification = await verifyCashierFingerprint(terminal, account, sessionToken);
      if (verification.renewedSessionToken) {
        setSessionToken(verification.renewedSessionToken);
        if (verification.account) setAccount(verification.account);
        setStatus("Cashier session renewed.");
      }
    });
  }

  async function issueInvoiceAfterSupervisorPin(pin: string) {
    if (!terminal || !account) return;
    await issueInvoiceAfterAuthorization(async () => {
      await verifyCheckoutWithSupervisorPin(terminal, account, sessionToken, pin);
    });
  }

  function resetCashierSessionUi() {
    setCart({});
    setCustomerName("");
    setReceipt(null);
    setLastReceipt(null);
    setCheckoutFingerprintOpen(false);
    setExpenseOpen(false);
    setInvoiceListMode(null);
    setInvoiceDetail(null);
  }

  async function handleLogout(reason: "manual" | "inactivity" = "manual") {
    try {
      await logout(sessionToken);
    } finally {
      resetCashierSessionUi();
      clearFingerprintTemplateCache();
      setAccount(null);
      setSessionToken("");
      setStatus(reason === "inactivity" ? "Signed out after 15 minutes of inactivity." : "Signed out.");
    }
  }

  async function handleCloseApp() {
    if (cartLines.length && !window.confirm("Close VISIONPOS Cashier and discard the current sale?")) return;
    await invoke("close_app");
  }

  function handleDayClosed(ts = Date.now()) {
    const effectiveTs = retainLatestDayClose(ts) || ts;
    setDayCloseNoticeAt(effectiveTs);
    setInvoices((current) => current
      .map((invoice) => (
        Number(invoice.ts || 0) <= effectiveTs && outstanding(invoice) > 0
          ? { ...invoice, carriedOver: true }
          : invoice
      )));
    setStatus("Day closed by supervisor. New day started.");
  }

  function restartForUpdate() {
    if (!updatePrompt) return;
    if (cartLines.length > 0) {
      setRestartWhenCartEmpty(true);
      setUpdateToastDismissed(true);
      setStatus("Finish or clear the current cart before installing the update.");
      logUpdateEvent("install_waiting_for_empty_cart", { version: updatePrompt.version });
      return;
    }
    setRestartWhenCartEmpty(false);
    setUpdateToastDismissed(true);
    setUpdateInstallOpen(true);
    logUpdateEvent("install_prompt_opened", { version: updatePrompt.version });
  }

  const updateModal = latestUpdateNotice
      ? <LatestUpdateModal version={APP_VERSION} onClose={() => setLatestUpdateNotice(false)} />
    : updatePrompt && updateInstallOpen
      ? <UpdatePromptModal update={updatePrompt} onClose={() => setUpdateInstallOpen(false)} />
    : null;

  if (!terminal) {
    return (
      <>
        <ActivationScreen
          onActivated={(next) => { clearFingerprintTemplateCache(); setTerminal(next); refreshCatalog(next); }}
          error={error}
          status={status}
          lastSyncAt={lastSyncAt}
          onClose={handleCloseApp}
          updateState={updateState}
          updateVersion={updatePrompt?.version}
          onCheckForUpdates={() => checkForUpdates(true)}
          onInstallUpdate={restartForUpdate}
        />
        {updateModal}
      </>
    );
  }

  if (!account) {
    return (
      <>
        <LoginScreen
          terminal={terminal}
          branch={branch}
          lastSyncAt={lastSyncAt}
          status={status}
          error={error}
          onClose={handleCloseApp}
          updateState={updateState}
          updateVersion={updatePrompt?.version}
          onCheckForUpdates={() => checkForUpdates(true)}
          onInstallUpdate={restartForUpdate}
          onLogin={async (employeeNumber, pin) => {
            setError("");
            let result;
            try {
              result = await loginCashier(terminal, employeeNumber, pin);
            } catch (err) {
              if (isTerminalRegistrationError(err)) await resetInvalidTerminalRegistration();
              throw err;
            }
            resetCashierSessionUi();
            setAccount(result.account);
            setSessionToken(result.sessionToken);
            setStatus(`Signed in as ${result.account.name}.`);
            writeLastFingerprintUserId(terminal, result.account.id);
            void preloadCashierFingerprintTemplate(terminal, result.account.id);
            await refreshCatalog(terminal);
          }}
          onFingerprintLogin={async (employeeNumber) => {
            setError("");
            const preferredUserId = String(employeeNumber || "").trim() || readLastFingerprintUserId(terminal);
            let result;
            try {
              result = await loginCashierWithFingerprint(terminal, preferredUserId || undefined);
            } catch (err) {
              if (isTerminalRegistrationError(err)) await resetInvalidTerminalRegistration();
              throw err;
            }
            resetCashierSessionUi();
            setAccount(result.account);
            setSessionToken(result.sessionToken);
            setStatus(`Signed in as ${result.account.name}.`);
            writeLastFingerprintUserId(terminal, result.account.id);
            void preloadCashierFingerprintTemplate(terminal, result.account.id);
            await refreshCatalog(terminal);
          }}
        />
        {updateModal}
      </>
    );
  }

  return (
    <main className="workstation">
      <header className="topbar">
        <div className="brand"><span>V</span><strong>Vision<b>POS</b></strong></div>
        <div className="topmeta">
          <div
            className={"connectivity-pill " + (session.online ? "online" : "offline")}
            title={session.online ? "Internet connection active" : "No internet connection"}
          >
            <i />
            <span>{session.online ? "Online" : "Offline"}</span>
          </div>
          <div
            className="branch-pill online"
            title="Store terminal"
          >
            <Building2 size={18} /><b>{branch?.name || terminal.branchId}</b><small>{terminal.terminalName}</small>
          </div>
          <div className="cashier-id"><b>{account.name}</b><span>Cashier</span></div>
        </div>
      </header>

      <section className={"layout" + (leftCollapsed ? " left-collapsed" : "")}>
        <aside className="left-panel">
          {leftCollapsed ? (
            <>
              <button
                className="sidebar-menu-button"
                onClick={() => setLeftCollapsed(false)}
                aria-label="Open cashier sidebar"
                title="Open menu"
              >
                <Menu size={22} />
              </button>
              <div className="mini-sidebar">
                <button title={`Sales today: ${money(salesInvoiceTotal)}`}><FileText size={18} /><span>{money(salesInvoiceTotal)}</span></button>
                <button className="mini-badge-button" onClick={() => setInvoiceListMode("invoices")} title={`${currentOpenInvoices.length} open and ${overdueInvoices.length} overdue invoices`}>
                  <FileText size={18} />
                  {openInvoices.length > 0 && <b>{openInvoices.length}</b>}
                </button>
                <button onClick={() => setExpenseOpen(true)} title="Expense"><WalletCards size={18} /></button>
                <button className="mini-badge-button" onClick={() => setInvoiceListMode("debts")} title={`${cashierDebtCount} cashier debts`}>
                  <span className="info-dot">!</span>
                  {cashierDebtCount > 0 && <b>{cashierDebtCount}</b>}
                </button>
                <button onClick={() => lastReceipt ? setReceipt(lastReceipt) : setStatus("No receipt to reprint yet.")} title="Reprint receipt"><FileText size={18} /></button>
                <button className="mini-logout" onClick={() => handleLogout()} title="Logout"><LogOut size={18} /></button>
              </div>
            </>
          ) : (
          <>
          <div className="rail-header-row">
            <button
              className="sidebar-menu-button"
              onClick={() => setLeftCollapsed(true)}
              aria-label="Collapse cashier sidebar"
              title="Collapse menu"
            >
              <Menu size={22} />
            </button>
            <time dateTime={new Date(session.dateTime).toISOString()}>
              <span>{railDateLabel(session.dateTime)}</span>
              <b>{railTimeLabel(session.dateTime)}</b>
            </time>
          </div>

          <section className="rail-card rail-sales-card">
            <div className="rail-card-head">
              <span>Sales today</span>
              <strong>{money(salesInvoiceTotal)}</strong>
            </div>
            <div className="rail-sales-chips">
              <div className="rail-chip paid"><b>{paidTodayCount}</b><span>Paid</span></div>
              <div className="rail-chip open"><b>{ordinaryOpenTodayCount}</b><span>Open</span></div>
              <div className="rail-chip pending"><b>{pendingTodayCount}</b><span>Pending</span></div>
            </div>
            {dayClosedAt && activeTodayInvoices.length === 0 && (
              <p className="rail-fresh-start">Fresh start - sell to fill this up.</p>
            )}
          </section>

          <section className="rail-card rail-open-card">
            <div className="rail-card-title">
              <h3>Today's open invoices</h3>
              <b>{openInvoicesToday.length}</b>
            </div>
            <div className="rail-invoice-list">
              {openInvoicesToday.length === 0 ? (
                <div className="rail-empty">
                  <FileText size={24} />
                  <b>No open invoices</b>
                  <span>Paid and closed invoices stay out of the cashier workspace.</span>
                </div>
              ) : openInvoicesToday.map((invoice) => {
                const label = invoiceCustomerLabel(invoice);
                const voidPending = isPendingVoidInvoice(invoice);
                return (
                  <button
                    className={"rail-invoice-row" + (voidPending ? " void-pending" : "")}
                    key={invoice.id}
                    onClick={() => setInvoiceDetail({ invoice, side: "left" })}
                    title={voidPending ? `Void pending for ${invoice.number}` : `Open ${invoice.number}`}
                  >
                    <span className="rail-avatar">{avatarInitial(label)}</span>
                    <span className="rail-invoice-main">
                      <b>{label}</b>
                      <small>{voidPending ? "Void pending - " : ""}{invoice.number} - opened {timeShort(invoice.ts)}</small>
                    </span>
                    <strong>{money(outstanding(invoice))}</strong>
                  </button>
                );
              })}
            </div>
            <div
              className="rail-open-footer"
              role="button"
              tabIndex={0}
              onClick={() => setInvoiceListMode("invoices")}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setInvoiceListMode("invoices");
                }
              }}
              title="View all open and overdue invoices"
            >
              <span>{overdueInvoices.length > 0 ? `${overdueInvoices.length} overdue - view all` : "Open total - view all"}</span>
              <b>{money(openInvoiceTotal)}</b>
            </div>
          </section>
          <div
            className="card dark debt-card clickable-card rail-hidden"
            role="button"
            tabIndex={0}
            onClick={() => setInvoiceListMode("debts")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setInvoiceListMode("debts");
              }
            }}
          >
            <div className="card-head">
              <h3>Debt tracker</h3>
              <button
                className="text-link"
                onClick={(event) => {
                  event.stopPropagation();
                  setInvoiceListMode("debts");
                }}
              >
                View
              </button>
            </div>
            <div className="debt-line"><span>Cashier debt</span><b>{money(debtTrackerTotal)}</b></div>
            <p>{carriedDebts.length} invoice debt{carriedDebts.length === 1 ? "" : "s"} - {inventoryDebtEntries.length} inventory debt{inventoryDebtEntries.length === 1 ? "" : "s"}</p>
            {carriedDebts.length === 0 && inventoryDebtEntries.length === 0 ? (
              <p>No cashier debts for your login.</p>
            ) : (
              <div className="debt-preview-list">
                {inventoryDebtEntries.slice(0, 2).map(({ debt, outstandingCents }) => (
                  <button
                    key={debt.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setInvoiceListMode("debts");
                    }}
                  >
                    <span><b>Missing inventory</b><small>{debt.stockCountCode}</small></span>
                    <strong>{money(outstandingCents)}</strong>
                  </button>
                ))}
                {carriedDebts.slice(0, Math.max(0, 3 - inventoryDebtEntries.length)).map((invoice) => (
                  <button
                    key={invoice.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setInvoiceListMode("debts");
                    }}
                  >
                    <span><b>{invoice.number}</b><small>{invoice.customerName || "Walk-in"}</small></span>
                    <strong>{money(outstanding(invoice))}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          <section className="rail-quick-actions">
            <button onClick={() => setExpenseOpen(true)}><WalletCards size={18} />Expense</button>
            <button className="rail-action-badge" onClick={() => setInvoiceListMode("debts")}>
              <span className="info-dot">!</span>
              Debts
              {cashierDebtCount > 0 && <b>{cashierDebtCount}</b>}
            </button>
            <button onClick={() => lastReceipt ? setReceipt(lastReceipt) : setStatus("No receipt to reprint yet.")}><FileText size={18} />Reprint</button>
          </section>

          <footer className="rail-footer">
            <div className="rail-update-wrap">
              <button className={"rail-update-status " + updateState} onClick={() => checkForUpdates(true)}>
                {updateState === "ready" ? <Download size={14} /> : <Check size={14} />}
                {updateStatusLabel}
              </button>
              {updatePrompt && updateState === "ready" && (
                <button className="rail-update-pill" onClick={restartForUpdate}>Update</button>
              )}
            </div>
            <button className="rail-logout-small" onClick={() => handleLogout()}><LogOut size={15} />Logout</button>
          </footer>
          </>
          )}
        </aside>

        <section className="products-panel">
            <div className="search-row">
              <label className="searchbar">
                <Search size={24} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && filteredProducts[0]) addToCart(filteredProducts[0]);
                  }}
                  placeholder="Scan barcode or search product, SKU, or barcode..."
                  autoFocus
                />
              </label>
              <button className={"scanner-toggle" + (scannerOn ? " on" : "")} onClick={() => setScannerOn((value) => !value)}><Barcode size={20} />Scanner</button>
            </div>
            <div className="product-strip">
              <button className="category-chip"><Heart size={16} />Favorites</button>
              {categories.map((category) => (
                <button
                  key={category}
                  className={"category-chip" + categoryAccentClass(category) + (selectedCategory === category ? " active" : "")}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category === "All Products" ? <Grid2X2 size={16} /> : <Wine size={16} />}
                  {category}
                </button>
              ))}
              <small>F2 Search - F4 Checkout - F6 Hold - Esc Clear search</small>
            </div>
            <div className="product-grid">
              {filteredProducts.map((product) => {
                const reservedQty = cart[product.id]?.qty || 0;
                const blocked = productSaleBlockReason(product, reservedQty);
                const productName = String(product.name || "").trim()
                  || String(product.sku || product.barcode || "").trim()
                  || "Unnamed product";
                return (
                  <button
                    className={"product-card" + (blocked ? " is-blocked" : "")}
                    key={product.id}
                    aria-disabled={Boolean(blocked)}
                    onClick={() => addToCart(product)}
                  >
                    <span className="product-name" title={productName}>{productName}</span>
                    <b className="product-price">{money(product.priceCents)}</b>
                    <span className="product-sku">SKU {product.sku || product.barcode || "No code"}</span>
                    <span className={"product-stock-row " + productStatusClass(product, reservedQty)}>
                      <i />
                      <b>{productStockLabel(product, reservedQty)}</b>
                    </span>
                    <span className={"product-action " + (blocked ? "blocked" : "available")}>{blocked ? "Out of stock" : "Add"}</span>
                  </button>
                );
              })}
            </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-head">
            <div>
              <h2>Cart</h2>
              <span>{itemCount} item{itemCount === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div className="cart-lines">
            {cartLines.length === 0 && (
              <div className="cart-empty-state">
                <ShoppingCart size={26} />
                <b>Cart is empty</b>
                <span>Scan or tap a product</span>
              </div>
            )}
            {cartLines.map((line) => (
              <div className="cart-line" key={line.product.id}>
                <div><b>{line.product.name}</b><span>{line.qty} x {money(line.product.priceCents)}</span></div>
                <div className="qty"><button onClick={() => changeQty(line.product.id, -1)}>-</button><b>{line.qty}</b><button onClick={() => changeQty(line.product.id, 1)}>+</button></div>
                <strong>{money(line.qty * line.product.priceCents)}</strong>
              </div>
            ))}
          </div>
          <label>Customer name / ID <em>*</em></label>
          <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Required - name, phone or ID" />
          {creditLocked && (
            <div className="credit-lock-warning" role="alert">
              <b>Owes {money(customerOutstandingDebt)} &middot; {customerDebtInvoices.length} open invoice{customerDebtInvoices.length === 1 ? "" : "s"}</b>
              <span>No new invoice until existing debt is cleared by a supervisor.</span>
            </div>
          )}
          <div className="subtotal"><span>Subtotal</span><b>{money(totalCents)}</b></div>
          <div className="total-row"><span>Total</span><strong>{money(totalCents)}</strong></div>
          <button className="checkout" disabled={!canCompleteSale} onClick={completeSale}><Check size={21} />Issue invoice <span>F4</span></button>
          <div className="cart-actions">
            <button disabled={!cartLines.length || creditLocked} onClick={() => { setCart({}); setCustomerName(""); setStatus("Sale held. Start a new invoice when ready."); }}>Hold</button>
            <button disabled={!cartLines.length && !customerName} onClick={() => { setCart({}); setCustomerName(""); setQuery(""); focusSearch(); }}>Clear</button>
          </div>
          {cartLines.length > 0 && !customerName.trim() && <p className="hint">Enter a customer name / identifier to issue the invoice.</p>}
        </aside>
      </section>
      {!session.online && (
        <div className="offline-body-blocker" role="alert" aria-live="assertive">
          <section>
            <WifiOff size={34} />
            <h2>No internet connection</h2>
            <p>VisionPOS needs to be online to sell. Reconnect to continue - nothing is lost.</p>
            <span><i /> Auto-retrying connection...</span>
          </section>
        </div>
      )}
      {dayCloseNoticeAt && (
        <div className="day-close-notice" role="status">
          <Server size={19} />
          <span>Day closed by supervisor at {timeShort(dayCloseNoticeAt)}. New day started.</span>
          <button onClick={() => setDayCloseNoticeAt(null)} aria-label="Dismiss day close notice"><X size={16} /></button>
        </div>
      )}

      {receipt && <ReceiptPreview receipt={receipt} onClose={() => setReceipt(null)} />}
      {checkoutFingerprintOpen && account && (
        <FingerprintCheckoutPrompt
          cashierName={account.name}
          onClose={() => { setCheckoutFingerprintOpen(false); focusSearch(); }}
          onConfirm={issueInvoiceAfterFingerprint}
          onSupervisorConfirm={issueInvoiceAfterSupervisorPin}
        />
      )}
      {updateModal}
      {updatePrompt && updateState === "ready" && !updateToastDismissed && (
        <UpdateReadyToast
          version={updatePrompt.version}
          cartBlocked={cartLines.length > 0}
          queued={restartWhenCartEmpty}
          onLater={() => setUpdateToastDismissed(true)}
          onRestart={restartForUpdate}
        />
      )}
      {expenseOpen && terminal && account && (
        <Drawer side="left" onClose={() => { setExpenseOpen(false); focusSearch(); }} labelledBy="expense-sheet-title">
          <ExpenseModal
            cashierName={account.name}
            categories={expenseCategories}
            onClose={() => { setExpenseOpen(false); focusSearch(); }}
            onSave={async (expense) => {
              setError("");
              await pushExpense(terminal, account, expense);
              setStatus(expense.amountCents > 50000 ? "Expense sent for supervisor approval." : "Expense recorded.");
              setExpenseOpen(false);
              await refreshCatalog(terminal);
              focusSearch();
            }}
          />
        </Drawer>
      )}
      {invoiceListMode && (
        <Drawer side="left" onClose={() => { setInvoiceListMode(null); focusSearch(); }} labelledBy="debts-center-title">
          <DebtsCenterView
            mode={invoiceListMode}
            openInvoices={openInvoices}
            currentOpenInvoices={currentOpenInvoices}
            overdueInvoices={overdueInvoices}
            carriedDebts={carriedDebts}
            inventoryDebts={inventoryDebtEntries}
            openTotalCents={openInvoiceTotal}
            carriedTotalCents={carriedDebtTotal}
            inventoryTotalCents={inventoryDebtTotal}
            onSelect={(invoice) => {
              setInvoiceListMode(null);
              setInvoiceDetail({ invoice, side: "left" });
            }}
          />
        </Drawer>
      )}
      {invoiceDetail && (
        <InvoiceDetailSlideOver
          invoice={invoiceDetail.invoice}
          side={invoiceDetail.side}
          cashierName={account.name}
          branchName={branch?.name || terminal.branchId}
          onReprint={(invoice) => {
            const nextReceipt: Receipt = {
              number: invoice.number,
              branchName: branch?.name || terminal.branchId,
              cashierName: invoice.cashierName || account.name,
              customerName: invoiceCustomerLabel(invoice),
              note: invoice.note,
              totalCents: invoice.totalCents,
              items: (invoice.items || []).map((item) => ({
                productId: item.productId || item.name,
                name: item.name,
                qty: item.qty,
                priceCents: item.priceCents
              })),
              ts: invoice.ts || Date.now()
            };
            setInvoiceDetail(null);
            setReceipt(nextReceipt);
            setStatus(`Ready to reprint ${invoice.number}.`);
          }}
          onSaveNote={async (invoice, note) => {
            if (!terminal || !account) return;
            await patchInvoiceNote(terminal, account, invoice, note);
            setInvoices((current) => current.map((item) => item.id === invoice.id ? { ...item, note } : item));
            setInvoiceDetail((current) => current && current.invoice.id === invoice.id ? {
              ...current,
              invoice: { ...current.invoice, note }
            } : current);
            setStatus(`Open note saved for ${invoice.number}.`);
            void refreshCatalog(terminal, { silent: true });
          }}
          onRequestVoid={async (invoice, reason) => {
            if (!terminal || !account) return;
            await requestInvoiceVoid(terminal, account, invoice, reason);
            const pendingInvoice = {
              ...invoice,
              voidRequestStatus: "pending" as const,
              voidReason: reason
            };
            setInvoices((current) => current.map((item) => item.id === invoice.id ? pendingInvoice : item));
            setInvoiceDetail((current) => current && current.invoice.id === invoice.id ? {
              ...current,
              invoice: pendingInvoice
            } : current);
            setStatus(`Void request sent for ${invoice.number}. Awaiting supervisor approval.`);
            void refreshCatalog(terminal, { silent: true });
          }}
          onClose={() => {
            setInvoiceDetail(null);
            focusSearch();
          }}
        />
      )}
    </main>
  );
}

function Drawer({
  side,
  onClose,
  labelledBy,
  children
}: {
  side: DrawerSide;
  onClose: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className={"drawer-backdrop " + side}>
      <aside
        className={"app-drawer " + side}
        role="dialog"
        aria-modal="false"
        aria-labelledby={labelledBy}
      >
        <button className="drawer-close" onClick={onClose} aria-label="Close panel">
          {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
        </button>
        {children}
      </aside>
    </div>
  );
}

function InvoiceDetailSlideOver({
  invoice,
  side,
  cashierName,
  branchName,
  onReprint,
  onSaveNote,
  onRequestVoid,
  onClose
}: {
  invoice: Invoice;
  side: DrawerSide;
  cashierName: string;
  branchName: string;
  onReprint: (invoice: Invoice) => void;
  onSaveNote: (invoice: Invoice, note: string) => Promise<void>;
  onRequestVoid: (invoice: Invoice, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const items = invoice.items || [];
  const customer = invoiceCustomerLabel(invoice);
  const overdue = Boolean(invoice.carriedOver) || isOverdueOpenInvoice(invoice);
  const paidCents = Number(invoice.paidCents || 0);
  const balanceCents = outstanding(invoice);
  const [openNote, setOpenNote] = useState(invoice.note || "");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [voidReason, setVoidReason] = useState("");
  const [voidStatus, setVoidStatus] = useState<"idle" | "sending" | "error">("idle");

  useEffect(() => {
    setOpenNote(invoice.note || "");
    setNoteStatus("idle");
    setVoidReason("");
    setVoidStatus("idle");
  }, [invoice.id, invoice.note]);

  async function submitVoidRequest() {
    const reason = voidReason.trim();
    if (reason.length < 3 || voidStatus === "sending") return;
    setVoidStatus("sending");
    try {
      await onRequestVoid(invoice, reason);
      setVoidStatus("idle");
    } catch {
      setVoidStatus("error");
    }
  }

  async function saveOpenNote() {
    const nextNote = openNote.trim();
    if (nextNote === (invoice.note || "").trim() || noteStatus === "saving") return;
    setNoteStatus("saving");
    try {
      await onSaveNote(invoice, nextNote);
      setNoteStatus("saved");
      window.setTimeout(() => setNoteStatus("idle"), 1800);
    } catch {
      setNoteStatus("error");
    }
  }

  return (
    <Drawer side={side} onClose={onClose} labelledBy="invoice-slide-title">
      <section className="invoice-slide">
        <header className="invoice-slide-header">
          <span className="invoice-slide-avatar">{avatarInitial(customer)}</span>
          <div>
            <span className="invoice-slide-kicker">Read-only invoice</span>
            <h2 id="invoice-slide-title">{customer}</h2>
            <p>{invoice.number} &middot; {branchName}</p>
          </div>
          <b className={"invoice-status-pill " + (overdue ? "overdue" : "recent")}>{invoiceAgeText(invoice)}</b>
        </header>

        <div className="invoice-slide-meta">
          <div><span>Issued</span><b>{invoiceDate(invoice)}</b></div>
          <div><span>Due</span><b>{invoiceDueDate(invoice)}</b></div>
          <div><span>Sold by</span><b>{invoice.cashierName || cashierName}</b></div>
        </div>

        <h3>Items</h3>
        <div className="invoice-slide-items">
          {items.length === 0 ? (
            <div className="invoice-slide-empty">No item lines have synced for this invoice yet.</div>
          ) : items.map((item, index) => (
            <div className="invoice-slide-item" key={(item.productId || item.name) + index}>
              <div><b>{item.name}</b><span>{item.qty} x {money(item.priceCents)}</span></div>
              <strong>{money(item.qty * item.priceCents)}</strong>
            </div>
          ))}
        </div>

        <div className="invoice-balance-block">
          <div><span>Invoice total</span><b>{money(invoice.totalCents)}</b></div>
          <div><span>Paid so far</span><b>{money(paidCents)}</b></div>
          <div className="balance-due"><span>Balance due</span><b>{money(balanceCents)}</b></div>
        </div>

        <div className="invoice-lock-notice">
          <ShieldCheck size={20} />
          <span>Payments and clearing are done by a supervisor in the admin dashboard. You can view and reprint only.</span>
        </div>

        <div className="invoice-open-note">
          <div className="invoice-open-note-head">
            <span><Pencil size={15} />OPEN NOTE</span>
            <em>{noteStatus === "saved" ? "Saved" : noteStatus === "saving" ? "Saving..." : noteStatus === "error" ? "Try again" : "only you can edit"}</em>
          </div>
          <textarea
            value={openNote}
            onChange={(event) => {
              setOpenNote(event.target.value);
              if (noteStatus !== "idle") setNoteStatus("idle");
            }}
            onBlur={() => { void saveOpenNote(); }}
            placeholder="Follow-up or collection note…"
            rows={3}
          />
          <button
            type="button"
            className="invoice-save-note"
            disabled={noteStatus === "saving" || openNote.trim() === (invoice.note || "").trim()}
            onClick={() => { void saveOpenNote(); }}
          >
            <Check size={16} />Save note
          </button>
        </div>

        <div className={`invoice-void-request ${invoice.voidRequestStatus || "idle"}`}>
          <div className="invoice-void-request-head">
            <span><ShieldCheck size={16} />VOID INVOICE</span>
            {invoice.voidRequestStatus === "pending" && <em>Awaiting supervisor</em>}
            {invoice.voidRequestStatus === "approved" && <em>Approved</em>}
            {invoice.voidRequestStatus === "rejected" && <em>Rejected</em>}
          </div>
          {invoice.voidRequestStatus === "pending" ? (
            <p>Your request is pending approval. The invoice and stock remain unchanged until a supervisor approves it.</p>
          ) : invoice.voidRequestStatus === "approved" ? (
            <p>This invoice was voided with supervisor authorization.</p>
          ) : (
            <>
              {invoice.voidRequestStatus === "rejected" && (
                <p className="invoice-void-rejected">The previous request was rejected{invoice.voidDecisionReason ? `: ${invoice.voidDecisionReason}` : "."}</p>
              )}
              <textarea
                value={voidReason}
                onChange={(event) => {
                  setVoidReason(event.target.value);
                  if (voidStatus === "error") setVoidStatus("idle");
                }}
                placeholder="Reason for void request"
                rows={2}
              />
              {voidStatus === "error" && <small>Could not send the request. Check the connection and try again.</small>}
              <button type="button" disabled={voidReason.trim().length < 3 || voidStatus === "sending"} onClick={() => { void submitVoidRequest(); }}>
                <Send size={16} />{voidStatus === "sending" ? "Sending..." : "Request supervisor void"}
              </button>
            </>
          )}
          {invoice.voidReason && <small>Reason: {invoice.voidReason}</small>}
        </div>

        <footer className="invoice-slide-actions">
          <button type="button" onClick={() => onReprint(invoice)}><FileText size={18} />Reprint</button>
        </footer>
      </section>
    </Drawer>
  );
}

function DebtsCenterView({
  mode,
  openInvoices,
  currentOpenInvoices,
  overdueInvoices,
  carriedDebts,
  inventoryDebts,
  openTotalCents,
  carriedTotalCents,
  inventoryTotalCents,
  onSelect
}: {
  mode: InvoiceListMode;
  openInvoices: Invoice[];
  currentOpenInvoices: Invoice[];
  overdueInvoices: Invoice[];
  carriedDebts: Invoice[];
  inventoryDebts: CashierJointDebtEntry[];
  openTotalCents: number;
  carriedTotalCents: number;
  inventoryTotalCents: number;
  onSelect: (invoice: Invoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "overdue" | "invoice" | "inventory">("all");
  const [oldestFirst, setOldestFirst] = useState(mode === "debts");
  const customerDebts = useMemo(() => {
    const grouped = new Map<string, {
      key: string;
      name: string;
      amountCents: number;
      count: number;
      oldestAgeDays: number;
    }>();
    carriedDebts.forEach((invoice) => {
      const label = invoiceCustomerLabel(invoice);
      const name = label.trim().length > 1 ? label : invoice.number;
      const key = name.trim().toLowerCase();
      const current = grouped.get(key) || {
        key,
        name,
        amountCents: 0,
        count: 0,
        oldestAgeDays: 0
      };
      current.amountCents += outstanding(invoice);
      current.count += 1;
      current.oldestAgeDays = Math.max(current.oldestAgeDays, invoiceAgeDays(invoice));
      grouped.set(key, current);
    });
    return [...grouped.values()].sort((a, b) => b.amountCents - a.amountCents);
  }, [carriedDebts]);
  const title = mode === "invoices" ? "Open & overdue invoices" : "Cashier debts";
  const subline = mode === "invoices"
    ? `${currentOpenInvoices.length} open - ${overdueInvoices.length} overdue`
    : `${carriedDebts.length} invoice - ${inventoryDebts.length} missing inventory`;
  const scopeCount = mode === "invoices" ? openInvoices.length : carriedDebts.length + inventoryDebts.length;
  const totalForMode = mode === "invoices" ? openTotalCents : carriedTotalCents + inventoryTotalCents;
  const searchTerm = query.trim().toLowerCase();

  useEffect(() => {
    setFilter("all");
    setOldestFirst(mode === "debts");
  }, [mode]);

  const visibleInvoices = useMemo(() => {
    const source = mode === "invoices"
      ? filter === "open"
        ? currentOpenInvoices
        : filter === "overdue"
          ? overdueInvoices
          : openInvoices
      : filter === "inventory"
        ? []
        : carriedDebts;
    return source
      .filter((invoice) => !searchTerm || invoiceSearchText(invoice).includes(searchTerm))
      .sort((a, b) => oldestFirst ? Number(a.ts || 0) - Number(b.ts || 0) : Number(b.ts || 0) - Number(a.ts || 0));
  }, [carriedDebts, currentOpenInvoices, filter, mode, oldestFirst, openInvoices, overdueInvoices, searchTerm]);
  const visibleInventoryDebts = useMemo(() => {
    if (mode !== "debts" || filter === "invoice") return [];
    return inventoryDebts
      .filter(({ debt }) => !searchTerm || [
        debt.stockCountCode,
        debt.source,
        ...debt.items.flatMap((item) => [item.productName, item.sku || ""])
      ].join(" ").toLowerCase().includes(searchTerm))
      .sort((a, b) => oldestFirst ? a.debt.ts - b.debt.ts : b.debt.ts - a.debt.ts);
  }, [filter, inventoryDebts, mode, oldestFirst, searchTerm]);

  return (
    <section className={`debts-center-panel${mode === "debts" && customerDebts.length > 0 ? " has-customer-summary" : ""}`}>
      <header className="debts-center-header">
        <div>
          <h2 id="debts-center-title">{title}</h2>
          <p>{subline}</p>
        </div>
        <div className="debts-total">
          <span>{mode === "debts" ? "Cashier debt" : "Outstanding"}</span>
          <b>{money(totalForMode)}</b>
        </div>
      </header>

      <label className="debts-search">
        <Search size={20} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === "debts" ? "Search customer, stock count, or product..." : "Search customer, phone, or receipt..."}
        />
      </label>

      <div className="debts-controls">
        <div className="debts-filter-chips" role="tablist" aria-label={mode === "debts" ? "Debt filters" : "Invoice filters"}>
          <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>All ({scopeCount})</button>
          {mode === "invoices" ? (
            <>
              <button className={filter === "open" ? "active amber" : "amber"} type="button" onClick={() => setFilter("open")}>Open ({currentOpenInvoices.length})</button>
              <button className={filter === "overdue" ? "active danger" : "danger"} type="button" onClick={() => setFilter("overdue")}>Overdue ({overdueInvoices.length})</button>
            </>
          ) : (
            <>
              <button className={filter === "invoice" ? "active amber" : "amber"} type="button" onClick={() => setFilter("invoice")}>Invoice debt ({carriedDebts.length})</button>
              <button className={filter === "inventory" ? "active danger" : "danger"} type="button" onClick={() => setFilter("inventory")}>Inventory debt ({inventoryDebts.length})</button>
            </>
          )}
        </div>
        <button className="debts-sort" type="button" onClick={() => setOldestFirst((value) => !value)}>
          {oldestFirst ? "Oldest first" : "Newest first"}
        </button>
      </div>

      {mode === "debts" && customerDebts.length > 0 && (
        <section className="customer-debt-summary" aria-label="Customer debt balances">
          <div className="customer-debt-heading">
            <b>Customer balances</b>
            <span>{customerDebts.length} customer{customerDebts.length === 1 ? "" : "s"}</span>
          </div>
          <div className="customer-debt-grid">
            {customerDebts.map((customer) => (
              <button type="button" key={customer.key} onClick={() => setQuery(customer.name)}>
                <span>
                  <b>{customer.name}</b>
                  <small>
                    {customer.count} debt invoice{customer.count === 1 ? "" : "s"}
                    {customer.oldestAgeDays > 0 ? ` · oldest ${customer.oldestAgeDays}d` : ""}
                  </small>
                </span>
                <strong>{money(customer.amountCents)}</strong>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="debts-list">
        {visibleInvoices.length === 0 && visibleInventoryDebts.length === 0 ? (
          <div className="debts-empty">
            {mode === "debts" ? <Boxes size={28} /> : <FileText size={28} />}
            <b>No {mode === "debts" ? "debts" : "invoices"} match</b>
            <span>Try another search or filter.</span>
          </div>
        ) : visibleInvoices.map((invoice) => {
          const label = invoiceCustomerLabel(invoice);
          const displayLabel = label.trim().length > 1 ? label : invoice.number;
          const ageDays = invoiceAgeDays(invoice);
          const overdue = isOverdueOpenInvoice(invoice);
          const ageText = ageDays <= 0 ? "Today" : `${ageDays}d`;
          return (
            <button className="debts-row" type="button" key={invoice.id} onClick={() => onSelect(invoice)}>
              <span className="debts-avatar">{avatarInitial(displayLabel)}</span>
              <span className="debts-main">
                <b>{displayLabel}</b>
                <small title={invoice.number}>{middleReceipt(invoice.number)} &middot; {ageText}</small>
              </span>
              <span className={"debts-age " + (mode === "debts" || overdue ? "overdue" : "recent")}>
                {mode === "debts" ? "Invoice debt" : overdue ? "Overdue" : "Open"}
              </span>
              <strong>{money(outstanding(invoice))}</strong>
              <ChevronRight size={18} />
            </button>
          );
        })}
        {visibleInventoryDebts.map(({ debt, outstandingCents }) => (
          <div className="debts-row inventory-debt-row" key={`inventory-${debt.id}`}>
            <span className="debts-avatar"><Boxes size={17} /></span>
            <span className="debts-main">
              <b>Missing inventory</b>
              <small>{debt.stockCountCode} &middot; {debt.shortageUnits} missing unit{debt.shortageUnits === 1 ? "" : "s"} &middot; {new Date(debt.ts).toLocaleDateString()}</small>
            </span>
            <span className="debts-age overdue">Joint debt</span>
            <strong>{money(outstandingCents)}</strong>
            <span aria-hidden="true" />
          </div>
        ))}
      </div>

      <footer className="debts-footer-note">
        <span>View only &middot; settlement is done by a supervisor.</span>
        <b>{money(totalForMode)}</b>
      </footer>
    </section>
  );
}

function UpdatePromptModal({ update, onClose }: { update: UpdatePrompt; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState(0);
  const [phase, setPhase] = useState("Ready to install");
  const [failure, setFailure] = useState("");

  async function installUpdate() {
    setBusy(true);
    setFailure("");
    setDownloaded(0);
    setContentLength(0);
    setPhase("Preparing secure download...");
    try {
      logUpdateEvent("download_started", { version: update.version });
      let received = 0;
      await update.nativeUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          const total = Number(event.data.contentLength || 0);
          setContentLength(total);
          setPhase("Downloading update...");
        }
        if (event.event === "Progress") {
          received += Number(event.data.chunkLength || 0);
          setDownloaded(received);
        }
        if (event.event === "Finished") {
          setPhase("Verifying and installing...");
        }
      });
      logUpdateEvent("install_finished", { version: update.version });
      setPhase("Restarting VISIONPOS...");
      await relaunch();
    } catch (err) {
      const message = String(err);
      logUpdateEvent("install_failed", { version: update.version, message });
      setFailure(message);
      setPhase("Update failed");
    } finally {
      setBusy(false);
    }
  }

  const progress = contentLength > 0 ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : busy ? 12 : 0;

  return (
    <div className="update-backdrop">
      <section className="update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <button className="update-close" onClick={onClose} aria-label="Remind me later"><X size={18} /></button>
        <div className="update-icon"><Download size={28} /></div>
        <span>Update available</span>
        <h2 id="update-title">VISIONPOS Cashier {update.version}</h2>
        <p>
          You are using version {update.currentVersion}. The update will download, verify, install, and restart VISIONPOS automatically.
        </p>
        {update.releaseNotes.length > 0 && (
          <ul>
            {update.releaseNotes.slice(0, 5).map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
        <div className="update-progress">
          <div><b>{phase}</b><span>{contentLength > 0 ? `${progress}%` : busy ? "Starting" : "Idle"}</span></div>
          <progress max={100} value={progress} />
        </div>
        {failure && <p className="update-error">Update failed: {failure}. You can retry the download.</p>}
        <div className="update-actions">
          <button onClick={installUpdate} disabled={busy}>{busy ? "Updating..." : failure ? "Retry update" : "Update now"}</button>
          <button className="ghost" onClick={onClose}>Remind me later</button>
        </div>
      </section>
    </div>
  );
}

function LatestUpdateModal({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <div className="update-backdrop">
      <section className="update-modal latest-modal" role="dialog" aria-modal="true" aria-labelledby="latest-title">
        <button className="update-close" onClick={onClose} aria-label="Close update status"><X size={18} /></button>
        <div className="update-icon latest-icon"><Check size={28} /></div>
        <span>Update status</span>
        <h2 id="latest-title">This is the latest update</h2>
        <p>VISIONPOS Cashier is already running version {version}. No installer download is needed on this terminal.</p>
        <div className="update-actions single">
          <button onClick={onClose}>OK</button>
        </div>
      </section>
    </div>
  );
}

function UpdateReadyToast({
  version,
  cartBlocked,
  queued,
  onLater,
  onRestart
}: {
  version: string;
  cartBlocked: boolean;
  queued: boolean;
  onLater: () => void;
  onRestart: () => void;
}) {
  return (
    <aside className="update-ready-toast" role="status">
      <button className="toast-close" onClick={onLater} aria-label="Dismiss update notice"><X size={16} /></button>
      <div className="toast-icon"><Download size={18} /></div>
      <div className="toast-copy">
        <b>Update v{version} available</b>
        <span>Install inside VisionPOS when this terminal is idle.</span>
        {cartBlocked && <small>Finish or clear the current cart before updating.</small>}
        {queued && <small>The installer will open once the cart is empty.</small>}
      </div>
      <div className="toast-actions">
        <button onClick={onLater}>Later</button>
        <button className="primary" onClick={onRestart} disabled={cartBlocked}>Update now</button>
      </div>
    </aside>
  );
}

function ExpenseModal({
  cashierName,
  categories,
  onClose,
  onSave
}: {
  cashierName: string;
  categories: ExpenseCategory[];
  onClose: () => void;
  onSave: (expense: { categoryId: string; category: string; amountCents: number; note?: string; source: "cash_till" | "mpesa"; status: "approved" | "pending" }) => Promise<void>;
}) {
  const availableCategories = cashierManagedExpenseCategories(categories);
  const [categoryId, setCategoryId] = useState(availableCategories[0]?.id || "excat_other");
  const [digits, setDigits] = useState("");
  const [source, setSource] = useState<"cash_till" | "mpesa">("cash_till");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [openedAt] = useState(Date.now());
  const amountKes = Number(digits || "0");
  const amountCents = amountKes * 100;
  const needsApproval = amountCents > 50000;
  const footerText = needsApproval
    ? "Sent to the supervisor - shows as Pending until they decide."
    : "Added to today's expenses - supervisor reviews at day close.";

  useEffect(() => {
    if (!availableCategories.some((category) => category.id === categoryId)) {
      setCategoryId(availableCategories[0]?.id || "excat_other");
    }
  }, [availableCategories, categoryId]);

  function pressKey(key: string) {
    setMessage("");
    if (key === "backspace") {
      setDigits((current) => current.slice(0, -1));
      return;
    }
    setDigits((current) => {
      const next = (current + key).replace(/^0+(?=\d)/, "");
      return next.slice(0, 7);
    });
  }

  async function submit() {
    if (amountCents <= 0) {
      setMessage("Enter a valid expense amount.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const category = availableCategories.find((item) => item.id === categoryId) || availableCategories[0];
      await onSave({
        categoryId: category?.id || categoryId,
        category: category?.name || "Other",
        amountCents,
        note: note.trim(),
        source,
        status: needsApproval ? "pending" : "approved"
      });
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
      <div className="expense-sheet">
        <div className="expense-sheet-head">
          <div className="expense-head-icon"><WalletCards size={22} /></div>
          <div>
            <h2 id="expense-sheet-title">Record expense</h2>
            <p>{cashierName} · {new Date(openedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
          </div>
          <button className="expense-close" onClick={onClose} aria-label="Close expense sheet"><X size={20} /></button>
        </div>

        <section className="expense-amount-panel">
          <span>Amount</span>
          <strong className={needsApproval ? "approval" : ""}>{money(amountCents)}</strong>
          <div className="expense-source-toggle" role="group" aria-label="Expense source">
            <button className={source === "cash_till" ? "active" : ""} onClick={() => setSource("cash_till")}>Cash till</button>
            <button className={source === "mpesa" ? "active" : ""} onClick={() => setSource("mpesa")}>M-Pesa</button>
          </div>
        </section>

        <section className="expense-section">
          <div className="expense-section-title">
            <span>Category</span>
            <small>set by supervisor</small>
          </div>
          <div className="expense-category-chips">
            {availableCategories.map((item) => (
              <button
                key={item.id}
                className={categoryId === item.id ? "active" : ""}
                onClick={() => setCategoryId(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        </section>

        <section className="expense-note-block">
          <label htmlFor="expense-note">Optional note</label>
          <textarea
            id="expense-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What was this expense for?"
            rows={2}
          />
        </section>

        <div className="expense-keypad" aria-label="Expense amount keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "00", "backspace"].map((key) => (
            <button key={key} onClick={() => pressKey(key)} aria-label={key === "backspace" ? "Backspace" : key}>
              {key === "backspace" ? <Delete size={22} /> : key}
            </button>
          ))}
        </div>

        {needsApproval && (
          <div className="expense-warning">
            Over KES 500 - this needs supervisor approval. It won't count against the till until approved.
          </div>
        )}
        {message && <div className="expense-error">{message}</div>}

        <button
          className={"expense-primary" + (needsApproval ? " approval" : "")}
          disabled={busy || amountCents <= 0}
          onClick={submit}
        >
          {needsApproval ? <Send size={18} /> : <Check size={18} />}
          {busy
            ? "Saving..."
            : needsApproval
              ? `Submit ${money(amountCents)} for approval`
              : `Record ${money(amountCents)} expense`}
        </button>
        <p className="expense-footer-copy">{footerText}</p>
      </div>
  );
}

function DebtsAndInvoicesModal({
  cashierName,
  openInvoices,
  carriedDebts,
  openTotalCents,
  carriedTotalCents,
  onClose
}: {
  cashierName: string;
  openInvoices: Invoice[];
  carriedDebts: Invoice[];
  openTotalCents: number;
  carriedTotalCents: number;
  onClose: () => void;
}) {
  const allInvoices = [...openInvoices, ...carriedDebts].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("visionpos:cashier:invoice-notes:v1") || "{}");
    } catch {
      return {};
    }
  });
  const selectedNote = selected ? notes[selected.id] || selected.note || "" : "";
  const saveSelectedNote = (value: string) => {
    if (!selected) return;
    const next = { ...notes, [selected.id]: value };
    setNotes(next);
    localStorage.setItem("visionpos:cashier:invoice-notes:v1", JSON.stringify(next));
  };

  if (selected) {
    const items = selected.items || [];
    return (
      <div className="modal-backdrop">
        <div className="cashier-modal ledger-modal">
          <div className="ledger-detail-head">
            <div>
              <span>Invoice</span>
              <h2>{selected.number}</h2>
            </div>
            <button className="close-button ledger-close" onClick={() => setSelected(null)}><X size={24} /></button>
          </div>
          <div className="ledger-detail-grid">
            <div><span>Customer</span><b>{selected.customerName || "Walk-in"}</b></div>
            <div><span>Cashier</span><b>{selected.cashierName || cashierName}</b></div>
            <div><span>Date</span><b>{invoiceDate(selected)}</b></div>
            <div><span>Status</span><b className="ledger-status">{selected.status || (selected.carriedOver ? "carried" : "open")}</b></div>
            <div><span>Total</span><b>{money(selected.totalCents)}</b></div>
            <div><span>Outstanding</span><b>{money(outstanding(selected))}</b></div>
          </div>
          <h3 className="ledger-section-title">Items</h3>
          <div className="ledger-items">
            {items.length === 0 ? (
              <div className="ledger-empty">No item lines were synced for this invoice yet.</div>
            ) : items.map((item, index) => (
              <div className="ledger-item" key={(item.productId || item.name) + index}>
                <div><b>{item.name}</b><span>{item.qty} x {money(item.priceCents)}</span></div>
                <strong>{money(item.qty * item.priceCents)}</strong>
              </div>
            ))}
          </div>
          <label className="ledger-note-label">Employee tracking note</label>
          <textarea
            className="ledger-note"
            value={selectedNote}
            onChange={(event) => saveSelectedNote(event.target.value)}
            placeholder="Track this invoice - who collected, follow-up, reason for credit, etc."
          />
          <button className="modal-primary ledger-save" onClick={() => setSelected(null)}><Check size={20} />Save note</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="cashier-modal ledger-modal">
        <div className="ledger-title-row">
          <div>
            <p>{cashierName}</p>
            <h2>Debts & Open Invoices</h2>
          </div>
          <button className="close-button ledger-close" onClick={onClose}><X size={24} /></button>
        </div>
        <div className="ledger-stats">
          <div className="ledger-stat">
            <span className="ledger-stat-icon">!</span>
            <p>Total outstanding</p>
            <b>{money(openTotalCents)}</b>
            <small>{openInvoices.length} open invoice{openInvoices.length === 1 ? "" : "s"}</small>
          </div>
          <div className="ledger-stat">
            <FileText size={25} />
            <p>Carried-over debt</p>
            <b>{money(carriedTotalCents)}</b>
            <small>{carriedDebts.length} carried over</small>
          </div>
        </div>
        <h3 className="ledger-section-title">Open invoices ({openInvoices.length})</h3>
        {allInvoices.length === 0 ? (
          <div className="ledger-empty">No open invoices or carried-over debts for this login.</div>
        ) : (
          <div className="ledger-list">
            {allInvoices.map((invoice) => (
              <button className="ledger-row" key={invoice.id} onClick={() => setSelected(invoice)}>
                <div><b>{invoice.number}</b><span>{invoice.customerName || "Walk-in"} · {invoiceDate(invoice)}</span></div>
                <strong>{money(outstanding(invoice))}</strong>
                <em>{invoice.carriedOver ? "Debt" : "Open"}</em>
              </button>
            ))}
          </div>
        )}
        <p className="ledger-help">Includes all your open invoices and carried-over debts - cleared by an admin or supervisor. Tap one to view its details.</p>
      </div>
    </div>
  );
}

function InvoicesModal({
  invoices,
  totalCents,
  branchName,
  onUseCustomer,
  onClose
}: {
  invoices: Invoice[];
  totalCents: number;
  branchName: string;
  onUseCustomer: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="cashier-modal wide">
        <div className="modal-head">
          <div>
            <span>{branchName}</span>
            <h2>Open Invoices</h2>
          </div>
          <button className="close-button" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="debt-summary"><span>Unpaid open invoices</span><b>{money(totalCents)}</b></div>
        {invoices.length === 0 ? (
          <div className="empty-modal">No open invoices for your login.</div>
        ) : (
          <div className="modal-list">
            {invoices.map((invoice) => (
              <button
                className="modal-row modal-row-button"
                key={invoice.id}
                onClick={() => onUseCustomer(invoice.customerName || "Walk-in")}
              >
                <div><b>{invoice.number}</b><span>{invoice.customerName || "Walk-in"}</span></div>
                <strong>{money(outstanding(invoice))}</strong>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DebtsModal({ debts, totalCents, onClose }: { debts: Invoice[]; totalCents: number; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="cashier-modal wide">
        <div className="modal-head">
          <div>
            <span>Cashier</span>
            <h2>My Debts</h2>
          </div>
          <button className="close-button" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="debt-summary"><span>Carried-over unpaid invoices</span><b>{money(totalCents)}</b></div>
        {debts.length === 0 ? (
          <div className="empty-modal">No carried-over debts for your login.</div>
        ) : (
          <div className="modal-list">
            {debts.map((invoice) => (
              <div className="modal-row" key={invoice.id}>
                <div><b>{invoice.number}</b><span>{invoice.customerName || "Walk-in"}</span></div>
                <strong>{money(outstanding(invoice))}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectionIndicator({ label, state = "online" }: { label: string; state?: "online" | "warning" | "muted" }) {
  return (
    <div className={`connection-indicator ${state}`}>
      <span className="pulse-dot" />
      <span>{label}</span>
    </div>
  );
}

function BrandSection() {
  return (
    <section className="auth-brand">
      <div className="brand-mark">V</div>
      <div>
        <h1>VisionPOS</h1>
        <p>Business in Focus</p>
      </div>
      <div className="auth-visual" aria-hidden="true">
        <span className="orb orb-one" />
        <span className="orb orb-two" />
        <span className="orb orb-three" />
        <div className="glass-terminal">
          <div className="terminal-top"><span /><span /><span /></div>
          <div className="terminal-grid"><b /><b /><b /><b /></div>
          <div className="terminal-line" />
        </div>
      </div>
    </section>
  );
}

function StatusPanel({
  terminal,
  branch,
  lastSyncAt,
  status,
  activationMode = false
}: {
  terminal?: TerminalCredentials | null;
  branch?: Branch | null;
  lastSyncAt?: number;
  status: string;
  activationMode?: boolean;
}) {
  const online = !/cached|failed|error/i.test(status);
  return (
    <section className="status-panel">
      <div className="status-title">
        <span>System Status</span>
        <ConnectionIndicator label={online ? "Online" : "Attention"} state={online ? "online" : "warning"} />
      </div>
      <div className="status-checks">
        <div><ShieldCheck size={17} />Secure Connection</div>
        <div><MonitorCheck size={17} />{activationMode ? "Activation Required" : "Terminal Registered"}</div>
        <div><Server size={17} />Connected to Server</div>
      </div>
      <div className="status-cards">
        <div><span>Branch Name</span><b>{branch?.name || terminal?.branchId || "Pending activation"}</b></div>
        <div><span>Terminal Name</span><b>{terminal?.terminalName || "Not registered"}</b></div>
        <div><span>Last Synchronization</span><b>{syncLabel(lastSyncAt)}</b></div>
        <div><span>Current Version</span><b>v{APP_VERSION}</b></div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="auth-footer">
      <span>VisionPOS</span>
      <span>Business in Focus</span>
      <span>Version {APP_VERSION}</span>
      <span>Copyright {new Date().getFullYear()}</span>
    </footer>
  );
}

function AuthShell({
  children,
  terminal,
  branch,
  lastSyncAt,
  status,
  activationMode = false,
  onClose
}: {
  children: ReactNode;
  terminal?: TerminalCredentials | null;
  branch?: Branch | null;
  lastSyncAt?: number;
  status: string;
  activationMode?: boolean;
  onClose?: () => void;
}) {
  return (
    <main className="auth premium-auth">
      <AuthClock />
      <div className="auth-left">
        <BrandSection />
        <StatusPanel
          terminal={terminal}
          branch={branch}
          lastSyncAt={lastSyncAt}
          status={status}
          activationMode={activationMode}
        />
        <Footer />
      </div>
      <div className="auth-right">{children}</div>
    </main>
  );
}

function AuthClock() {
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const time = currentTime.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const date = currentTime.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric"
  });

  return (
    <div className="auth-clock-chip" aria-label={`Local time ${time}, ${date}`}>
      <Clock size={18} />
      <span>
        <b>{time}</b>
        <small>{date}</small>
      </span>
    </div>
  );
}

function LoginCard({ eyebrow, title, subtitle, children }: { eyebrow: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="auth-card login-panel">
      <div className="panel-eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </section>
  );
}

function PreLoginUpdateControl({
  updateState,
  updateVersion,
  onCheckForUpdates,
  onInstallUpdate
}: {
  updateState: CashierUpdateState;
  updateVersion?: string;
  onCheckForUpdates: () => Promise<void> | void;
  onInstallUpdate: () => void;
}) {
  const checking = updateState === "downloading";
  return (
    <div className={`prelogin-update ${updateVersion ? "available" : ""}`}>
      <div>
        <span>VISIONPOS Cashier</span>
        <b>v{APP_VERSION}</b>
      </div>
      {updateVersion ? (
        <button type="button" onClick={onInstallUpdate}>
          <Download size={16} />
          Install v{updateVersion}
        </button>
      ) : (
        <button type="button" disabled={checking} onClick={() => void onCheckForUpdates()}>
          <Check size={16} />
          {checking ? "Checking..." : "Check for updates"}
        </button>
      )}
    </div>
  );
}

function ActivationScreen({
  onActivated,
  error,
  status,
  lastSyncAt,
  onClose,
  updateState,
  updateVersion,
  onCheckForUpdates,
  onInstallUpdate
}: {
  onActivated: (terminal: TerminalCredentials) => void;
  error: string;
  status: string;
  lastSyncAt?: number;
  onClose: () => void;
  updateState: CashierUpdateState;
  updateVersion?: string;
  onCheckForUpdates: () => Promise<void> | void;
  onInstallUpdate: () => void;
}) {
  const [code, setCode] = useState("");
  const [terminalName, setTerminalName] = useState(`Till ${new Date().toLocaleDateString()}`);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);

  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      const terminal = await activateTerminal(code, terminalName);
      await saveTerminalCredentials(terminal);
      onActivated(terminal);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell lastSyncAt={lastSyncAt} status={status} activationMode onClose={onClose}>
      <LoginCard eyebrow="Terminal Setup" title="Register Terminal" subtitle="Activate this computer as a trusted cashier workstation.">
        <label>Terminal name</label>
        <div className="premium-input"><MonitorCheck size={20} /><input value={terminalName} onChange={(event) => setTerminalName(event.target.value)} /></div>
        <label>Activation code</label>
        <div className="premium-input"><KeyRound size={20} /><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD-1234-EFGH" /></div>
        {message && <div className="error">{message}</div>}
        <button className="premium-primary" disabled={busy || code.length < 8} onClick={submit}>{busy ? <span className="spinner" /> : <ShieldCheck size={20} />}{busy ? "Registering..." : "Activate Terminal"}</button>
        <PreLoginUpdateControl updateState={updateState} updateVersion={updateVersion} onCheckForUpdates={onCheckForUpdates} onInstallUpdate={onInstallUpdate} />
      </LoginCard>
    </AuthShell>
  );
}

function LoginScreen({
  terminal,
  branch,
  lastSyncAt,
  status,
  error,
  onClose,
  updateState,
  updateVersion,
  onCheckForUpdates,
  onInstallUpdate,
  onLogin,
  onFingerprintLogin
}: {
  terminal: TerminalCredentials;
  branch: Branch | null;
  lastSyncAt?: number;
  status: string;
  error: string;
  onClose: () => void;
  updateState: CashierUpdateState;
  updateVersion?: string;
  onCheckForUpdates: () => Promise<void> | void;
  onInstallUpdate: () => void;
  onLogin: (employeeNumber: string, pin: string) => Promise<void>;
  onFingerprintLogin: (employeeNumber?: string) => Promise<void>;
}) {
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [fingerprintBusy, setFingerprintBusy] = useState(false);
  const [message, setMessage] = useState(error);
  const canSubmit = !busy && employeeNumber.trim().length > 0 && pin.length >= 4;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage("");
    try {
      await onLogin(employeeNumber, pin);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function scanFingerprint() {
    if (busy || fingerprintBusy) return;
    setFingerprintBusy(true);
    setMessage("");
    try {
      await onFingerprintLogin(employeeNumber.trim());
    } catch (err) {
      setMessage(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setFingerprintBusy(false);
    }
  }

  return (
    <AuthShell terminal={terminal} branch={branch} lastSyncAt={lastSyncAt} status={status} onClose={onClose}>
      <LoginCard eyebrow="Trusted Terminal" title="Cashier Login" subtitle="Sign in to begin today's sales.">
        <div className="terminal-summary">
          <ConnectionIndicator label="Terminal Registered" />
          <span>{branch?.name || terminal.branchId} / {terminal.terminalName}</span>
        </div>
        <p>{branch?.name || terminal.branchId} · {terminal.terminalName}</p>
        <label>Employee number</label>
        <div className="premium-input"><UserRound size={20} /><input value={employeeNumber} onChange={(event) => setEmployeeNumber(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} autoFocus /></div>
        <label>PIN</label>
        <div className="premium-input"><Lock size={20} /><input value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} type="password" inputMode="numeric" /></div>
        {message && <div className="error">{message}</div>}
        <button className="premium-primary" disabled={!canSubmit || fingerprintBusy} onClick={submit}>{busy ? <span className="spinner" /> : <Wifi size={20} />}{busy ? "Signing in..." : "Sign in with PIN"}</button>
        <div className="auth-choice"><span>or</span></div>
        <button className="premium-secondary fingerprint-login-button" disabled={busy || fingerprintBusy} onClick={scanFingerprint}>
          {fingerprintBusy ? <span className="spinner" /> : <Fingerprint size={22} />}
          {fingerprintBusy ? "Place finger on reader..." : "Sign in with fingerprint"}
        </button>
        <PreLoginUpdateControl updateState={updateState} updateVersion={updateVersion} onCheckForUpdates={onCheckForUpdates} onInstallUpdate={onInstallUpdate} />
      </LoginCard>
    </AuthShell>
  );
}

function FingerprintCheckoutPrompt({
  cashierName,
  onClose,
  onConfirm,
  onSupervisorConfirm
}: {
  cashierName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onSupervisorConfirm: (pin: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [supervisorPin, setSupervisorPin] = useState("");
  const automaticScanStarted = useRef(false);

  async function scanAndConfirm() {
    setBusy(true);
    setMessage("");
    try {
      await onConfirm();
    } catch (err) {
      setMessage(String(err).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (automaticScanStarted.current) return;
    automaticScanStarted.current = true;
    const timer = window.setTimeout(() => {
      void scanAndConfirm();
    }, 150);
    return () => window.clearTimeout(timer);
  }, []);

  async function confirmSupervisorPin() {
    if (busy || !/^\d{4}$/.test(supervisorPin)) return;
    setBusy(true);
    setMessage("");
    try {
      await onSupervisorConfirm(supervisorPin);
    } catch (err) {
      setMessage(String(err).replace(/^Error:\s*/, ""));
      setSupervisorPin("");
      setBusy(false);
    }
  }

  return (
    <div className="pin-confirm-backdrop" role="presentation">
      <section className="pin-confirm-card fingerprint-confirm-card" role="dialog" aria-modal="true" aria-labelledby="fingerprint-checkout-title">
        <div className="pin-confirm-head">
          <span><ShieldCheck size={18} /> Secure checkout</span>
          <button type="button" onClick={onClose} aria-label="Cancel fingerprint confirmation"><X size={18} /></button>
        </div>
        {!fallbackOpen ? (
          <>
            <div className={"fingerprint-scan-visual" + (busy ? " scanning" : "")}>
              <Fingerprint size={58} />
              <i />
            </div>
            <h2 id="fingerprint-checkout-title">Confirm {cashierName}'s fingerprint</h2>
          </>
        ) : (
          <>
            <div className="supervisor-override-icon"><KeyRound size={34} /></div>
            <h2 id="fingerprint-checkout-title">Supervisor emergency approval</h2>
            <p>Use only when the fingerprint reader or cashier's finger is unavailable. This approval is recorded.</p>
            <label className="supervisor-pin-label" htmlFor="supervisor-checkout-pin">Supervisor PIN</label>
            <input
              id="supervisor-checkout-pin"
              className="supervisor-pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              autoFocus
              value={supervisorPin}
              onChange={(event) => setSupervisorPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(event) => { if (event.key === "Enter") confirmSupervisorPin(); }}
              aria-label="Four digit supervisor emergency PIN"
            />
          </>
        )}
        {message && <div className="pin-confirm-error">{message}</div>}
        {!fallbackOpen ? (
          <>
            <button className="pin-confirm-primary" type="button" disabled={busy || !message} onClick={scanAndConfirm}>
              {busy ? <span className="spinner" /> : <Fingerprint size={22} />}
              {busy ? "Reading fingerprint..." : "Try fingerprint again"}
            </button>
            <button className="supervisor-fallback-toggle" type="button" disabled={busy} onClick={() => { setFallbackOpen(true); setMessage(""); }}>
              <KeyRound size={16} /> Scanner unavailable? Use supervisor PIN
            </button>
          </>
        ) : (
          <>
            <button className="pin-confirm-primary" type="button" disabled={busy || !/^\d{4}$/.test(supervisorPin)} onClick={confirmSupervisorPin}>
              {busy ? <span className="spinner" /> : <ShieldCheck size={22} />}
              {busy ? "Verifying supervisor..." : "Approve and issue invoice"}
            </button>
            <button className="supervisor-fallback-toggle" type="button" disabled={busy} onClick={() => {
              setFallbackOpen(false);
              setSupervisorPin("");
              setMessage("");
              setBusy(true);
              window.setTimeout(() => { void scanAndConfirm(); }, 150);
            }}>
              <Fingerprint size={16} /> Return to fingerprint
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function ReceiptPreview({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  return (
    <div className="receipt-backdrop">
      <div className="receipt-modal">
        <div className="receipt-title">
          <div>
            <span>Invoice receipt</span>
            <strong>{receipt.number}</strong>
          </div>
          <button className="receipt-x" onClick={onClose} aria-label="Close receipt">×</button>
        </div>
        <div className="receipt" id="receipt-print">
          <h2>{receipt.branchName}</h2>
          <p>{new Date(receipt.ts).toLocaleString()}</p>
          <p>Receipt: {receipt.number}</p>
          <p>Cashier: {receipt.cashierName}</p>
          <p>Customer: {receipt.customerName}</p>
          {receipt.note && <p>Note: {receipt.note}</p>}
          <hr />
          {receipt.items.map((item) => (
            <div className="receipt-line" key={item.name + item.qty}>
              <span>{item.qty} x {item.name}</span>
              <b>{money(item.qty * item.priceCents)}</b>
            </div>
          ))}
          <hr />
          <div className="receipt-total"><span>Total</span><b>{money(receipt.totalCents)}</b></div>
          <p>Open invoice - not paid at checkout.</p>
          <p>Thank you.</p>
        </div>
        <div className="receipt-actions">
          <button onClick={() => printReceipt(receipt)}>Print receipt</button>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
