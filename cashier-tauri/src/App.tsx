import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  Barcode,
  Building2,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock,
  Delete,
  Download,
  FileText,
  Grid2X2,
  GripHorizontal,
  Heart,
  KeyRound,
  Keyboard,
  Lock,
  LogOut,
  Menu,
  Minus,
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
  connectSyncStream,
  type SyncVersionChange,
  loginCashier,
  logout,
  patchInvoiceNote,
  pullCatalog,
  pushCheckout,
  pushExpense,
  resolveBarcode,
  verifyCashierPin
} from "./api";
import { clearTerminalCredentials, loadTerminalCredentials, saveTerminalCredentials } from "./secureStore";
import type { Account, Branch, CartLine, Invoice, Product, Receipt, TerminalCredentials } from "./types";

const LAST_CATALOG_KEY = "visionpos:cashier:last-catalog:v1";
const UPDATE_LOG_KEY = "visionpos:cashier:update-log:v1";
const LEFT_RAIL_COLLAPSED_KEY = "visionpos:cashier:left-rail-collapsed:v1";
const VIRTUAL_KEYBOARD_ENABLED_KEY = "visionpos:cashier:virtual-keyboard-enabled:v1";
const VIRTUAL_KEYBOARD_POSITION_KEY = "visionpos:cashier:virtual-keyboard-position:v1";
const SUPERVISOR_EXPENSE_CATEGORIES = ["Police", "Utilities", "Other"];
const CASHIER_INACTIVITY_LOGOUT_MS = 5 * 60 * 1000;

type UpdatePrompt = {
  version: string;
  currentVersion: string;
  releaseNotes: string[];
  nativeUpdate: NonNullable<Awaited<ReturnType<typeof check>>>;
};

type CashierUpdateState = "idle" | "downloading" | "ready";
type DrawerSide = "left" | "right";
type InvoiceListMode = "today" | "debts";

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

function receiptPrintHtml(receipt: Receipt) {
  const lines = receipt.items.map((item) => `
    <div class="line">
      <span>${escapeHtml(String(item.qty))} x ${escapeHtml(item.name)}</span>
      <b>${escapeHtml(money(item.qty * item.priceCents))}</b>
    </div>
  `).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt ${escapeHtml(receipt.number)}</title>
  <style>
    @page { size: 76mm auto; margin: 4mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 68mm;
      color: #111827;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    h1 { margin: 0 0 8px; text-align: center; font-size: 17px; }
    p { margin: 4px 0; text-align: center; }
    hr { border: 0; border-top: 1px dashed #9CA3AF; margin: 10px 0; }
    .line, .total { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; break-inside: avoid; }
    .line span { max-width: 42mm; }
    .total { font-size: 15px; font-weight: 900; }
  </style>
</head>
<body>
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
  <script>window.onload = () => { window.focus(); window.print(); setTimeout(() => window.close(), 500); };</script>
</body>
</html>`;
}

function printReceipt(receipt: Receipt) {
  const frame = document.createElement("iframe");
  frame.title = "Receipt print";
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1000);
  };
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(receiptPrintHtml(receipt));
  doc.close();
}

function saveCatalog(branches: Branch[], products: Product[], invoices: Invoice[]) {
  const savedAt = Date.now();
  localStorage.setItem(LAST_CATALOG_KEY, JSON.stringify({ branches, products, invoices, savedAt }));
  return savedAt;
}

function loadCatalog(): { branches: Branch[]; products: Product[]; invoices: Invoice[]; savedAt?: number } {
  try {
    const raw = localStorage.getItem(LAST_CATALOG_KEY);
    if (!raw) return { branches: [], products: [], invoices: [] };
    const parsed = JSON.parse(raw);
    return { branches: parsed.branches || [], products: parsed.products || [], invoices: parsed.invoices || [], savedAt: parsed.savedAt };
  } catch {
    return { branches: [], products: [], invoices: [] };
  }
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

function isPendingInvoice(invoice: Invoice) {
  const status = String(invoice.status || "").toLowerCase();
  return status.includes("pending") || status.includes("approval");
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

function isOverdueDebtInvoice(invoice: Invoice) {
  return Boolean(invoice.carriedOver) || invoiceAgeDays(invoice) > 7;
}

function invoiceDueDate(invoice: Invoice) {
  if (!invoice.ts) return "Not set";
  return new Date(Number(invoice.ts) + 7 * DAY_MS).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function invoiceAgeText(invoice: Invoice) {
  const ageDays = invoiceAgeDays(invoice);
  if (isOverdueDebtInvoice(invoice)) return `${Math.max(1, ageDays - 7)}d overdue`;
  if (ageDays <= 0) return "Due today";
  return `${ageDays}d old`;
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
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All Products");
  const [customerName, setCustomerName] = useState("");
  const [status, setStatus] = useState("Starting VISIONPOS Cashier...");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  const [checkoutPinOpen, setCheckoutPinOpen] = useState(false);
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
  const [virtualKeyboardEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem(VIRTUAL_KEYBOARD_ENABLED_KEY);
      return stored == null ? true : stored === "1";
    } catch {
      return true;
    }
  });
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
  const updateCheckInFlight = useRef(false);
  const updateStateRef = useRef<CashierUpdateState>("idle");

  const branch = branches.find((item) => item.id === terminal?.branchId) || null;
  const cartLines = Object.values(cart);
  const totalCents = cartLines.reduce((sum, line) => sum + line.qty * line.product.priceCents, 0);
  const itemCount = cartLines.reduce((sum, line) => sum + line.qty, 0);
  const myInvoices = useMemo(() => {
    if (!account?.id) return [];
    return invoices.filter((invoice) => !invoice.cashierId || invoice.cashierId === account.id);
  }, [account?.id, invoices]);
  const openInvoices = useMemo(() => myInvoices.filter((invoice) => outstanding(invoice) > 0 && !invoice.carriedOver), [myInvoices]);
  const carriedDebts = useMemo(() => myInvoices.filter((invoice) => outstanding(invoice) > 0 && invoice.carriedOver), [myInvoices]);
  const todayInvoices = useMemo(() => myInvoices.filter((invoice) => isToday(invoice.ts)), [myInvoices]);
  const activeTodayInvoices = useMemo(
    () => todayInvoices.filter((invoice) => !dayClosedAt || Number(invoice.ts || 0) > dayClosedAt),
    [dayClosedAt, todayInvoices]
  );
  const openInvoicesToday = useMemo(() => activeTodayInvoices.filter((invoice) => outstanding(invoice) > 0 && !invoice.carriedOver), [activeTodayInvoices]);
  const paidTodayCount = activeTodayInvoices.filter((invoice) => outstanding(invoice) <= 0).length;
  const pendingTodayCount = activeTodayInvoices.filter(isPendingInvoice).length;
  const openInvoiceTotal = openInvoices.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const openInvoicesTodayTotal = openInvoicesToday.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const carriedDebtTotal = carriedDebts.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const debtTrackerTotal = openInvoiceTotal + carriedDebtTotal;
  const salesInvoiceTotal = activeTodayInvoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0);
  const customerDebtInvoices = useMemo(() => {
    const customerKey = normalize(customerName);
    if (customerKey.length < 2) return [];
    return [...openInvoices, ...carriedDebts].filter((invoice) => {
      const invoiceCustomer = normalize(invoice.customerName || "");
      return invoiceCustomer === customerKey;
    });
  }, [carriedDebts, customerName, openInvoices]);
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
    if (!q) return scoped.slice(0, 80);
    return scoped.filter((product) => {
      const haystack = [product.name, product.sku, product.barcode, product.category, ...(product.barcodes || [])].join(" ").toLowerCase();
      return haystack.includes(q);
    }).slice(0, 80);
  }, [products, query, selectedCategory]);

  const focusSearch = () => setTimeout(() => searchRef.current?.focus(), 20);

  useEffect(() => {
    loadTerminalCredentials().then((stored) => {
      const cached = loadCatalog();
      setBranches(cached.branches);
      setProducts(cached.products);
      setInvoices(cached.invoices);
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
      if (window.innerWidth < 1100) setLeftCollapsed(true);
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
      const update = await check();

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
    const resetTimer = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void handleLogout("inactivity");
      }, CASHIER_INACTIVITY_LOGOUT_MS);
    };
    const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "pointerdown", "wheel", "scroll"];
    resetTimer();
    activityEvents.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    return () => {
      if (timer) window.clearTimeout(timer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [account?.id, sessionToken]);

  async function refreshCatalog(nextTerminal = terminal, options: { silent?: boolean } = {}) {
    if (!nextTerminal) return;
    if (catalogSyncInFlight.current) return;
    catalogSyncInFlight.current = true;
    try {
      if (!options.silent) setStatus("Syncing products...");
      const pulled = await pullCatalog(nextTerminal);
      setBranches(pulled.branches);
      setProducts(pulled.products);
      setInvoices(pulled.invoices);
      setLastSyncAt(saveCatalog(pulled.branches, pulled.products, pulled.invoices));
      setStatus(`Connected. Synced ${pulled.products.length} products and ${pulled.invoices.length} invoices.`);
      setError("");
    } catch (err) {
      if (String(err).includes("terminal_not_authorized")) {
        await clearTerminalCredentials();
        setTerminal(null);
        setAccount(null);
      }
      if (!options.silent) setStatus("Using last cached catalog.");
      setError(String(err));
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
    setCheckoutPinOpen(true);
  }

  async function issueInvoiceAfterPin(pin: string) {
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
      await verifyCashierPin(terminal, account, pin);
      await pushCheckout(terminal, account, nextReceipt);
      setReceipt(nextReceipt);
      setLastReceipt(nextReceipt);
      setCart({});
      setCustomerName("");
      setCheckoutPinOpen(false);
      setStatus(`Open invoice ${receiptNumber} issued.`);
      refreshCatalog(terminal);
    } catch (err) {
      const message = String(err).includes("invalid_pin") ? "PIN does not match this cashier." : `Checkout failed: ${String(err)}`;
      setError(message);
      throw new Error(message);
    } finally {
      focusSearch();
    }
  }

  async function handleLogout(reason: "manual" | "inactivity" = "manual") {
    await logout(sessionToken);
    setAccount(null);
    setSessionToken("");
    setCart({});
    setCustomerName("");
    setCheckoutPinOpen(false);
    setStatus(reason === "inactivity" ? "Signed out after 5 minutes of inactivity." : "Signed out.");
  }

  async function handleCloseApp() {
    if (cartLines.length && !window.confirm("Close VISIONPOS Cashier and discard the current sale?")) return;
    await invoke("close_app");
  }

  function handleDayClosed(ts = Date.now()) {
    setDayClosedAt(ts);
    setDayCloseNoticeAt(ts);
    setInvoices((current) => current
      .filter((invoice) => !(isToday(invoice.ts) && outstanding(invoice) <= 0))
      .map((invoice) => (
        isToday(invoice.ts) && outstanding(invoice) > 0
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
          onActivated={(next) => { setTerminal(next); refreshCatalog(next); }}
          error={error}
          status={status}
          lastSyncAt={lastSyncAt}
          onClose={handleCloseApp}
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
          onLogin={async (employeeNumber, pin) => {
            setError("");
            const result = await loginCashier(terminal, employeeNumber, pin);
            setAccount(result.account);
            setSessionToken(result.sessionToken);
            setStatus(`Signed in as ${result.account.name}.`);
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
                <button className="mini-badge-button" onClick={() => setInvoiceListMode("today")} title={`${openInvoicesToday.length} open invoices`}>
                  <FileText size={18} />
                  {openInvoicesToday.length > 0 && <b>{openInvoicesToday.length}</b>}
                </button>
                <button onClick={() => setExpenseOpen(true)} title="Expense"><WalletCards size={18} /></button>
                <button className="mini-badge-button" onClick={() => setInvoiceListMode("debts")} title={`${carriedDebts.length} outstanding debts`}>
                  <span className="info-dot">!</span>
                  {carriedDebts.length > 0 && <b>{carriedDebts.length}</b>}
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
              <div className="rail-chip open"><b>{openInvoicesToday.length}</b><span>Open</span></div>
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
                return (
                  <button
                    className="rail-invoice-row"
                    key={invoice.id}
                    onClick={() => setInvoiceDetail({ invoice, side: "left" })}
                    title={`Open ${invoice.number}`}
                  >
                    <span className="rail-avatar">{avatarInitial(label)}</span>
                    <span className="rail-invoice-main">
                      <b>{label}</b>
                      <small>{invoice.number} - opened {timeShort(invoice.ts)}</small>
                    </span>
                    <strong>{money(outstanding(invoice))}</strong>
                  </button>
                );
              })}
            </div>
            <div className="rail-open-footer">
              <span>Open total</span>
              <b>{money(openInvoicesTodayTotal)}</b>
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
            <div className="debt-line"><span>Pending invoices & carried debt</span><b>{money(debtTrackerTotal)}</b></div>
            <p>{openInvoices.length} pending invoice{openInvoices.length === 1 ? "" : "s"} · {carriedDebts.length} carried over</p>
            {openInvoices.length === 0 ? (
              <p>No pending invoices for your login.</p>
            ) : (
              <div className="debt-preview-list">
                {openInvoices.slice(0, 3).map((invoice) => (
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
            {openInvoices.length === 0 && carriedDebts.length === 0 && <p>No carried-over debts for your login.</p>}
          </div>
          <section className="rail-quick-actions">
            <button onClick={() => setExpenseOpen(true)}><WalletCards size={18} />Expense</button>
            <button className="rail-action-badge" onClick={() => setInvoiceListMode("debts")}>
              <span className="info-dot">!</span>
              Debts
              {carriedDebts.length > 0 && <b>{carriedDebts.length}</b>}
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
                return (
                  <button className="product-card" key={product.id} disabled={Boolean(blocked)} onClick={() => addToCart(product)}>
                    <span className="product-name">{product.name}</span>
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
      {checkoutPinOpen && account && (
        <CashierPinPrompt
          cashierName={account.name}
          onClose={() => { setCheckoutPinOpen(false); focusSearch(); }}
          onConfirm={issueInvoiceAfterPin}
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
            todayInvoices={openInvoicesToday}
            openInvoices={openInvoices}
            carriedDebts={carriedDebts}
            todayTotalCents={openInvoicesTodayTotal}
            openTotalCents={openInvoiceTotal}
            carriedTotalCents={carriedDebtTotal}
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
          onClose={() => {
            setInvoiceDetail(null);
            focusSearch();
          }}
        />
      )}
      <VirtualKeyboard enabled={virtualKeyboardEnabled} />
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
    <div className={"drawer-backdrop " + side} onClick={onClose}>
      <aside
        className={"app-drawer " + side}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(event) => event.stopPropagation()}
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
  onClose
}: {
  invoice: Invoice;
  side: DrawerSide;
  cashierName: string;
  branchName: string;
  onReprint: (invoice: Invoice) => void;
  onSaveNote: (invoice: Invoice, note: string) => Promise<void>;
  onClose: () => void;
}) {
  const items = invoice.items || [];
  const customer = invoiceCustomerLabel(invoice);
  const overdue = isOverdueDebtInvoice(invoice);
  const paidCents = Number(invoice.paidCents || 0);
  const balanceCents = outstanding(invoice);
  const [openNote, setOpenNote] = useState(invoice.note || "");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setOpenNote(invoice.note || "");
    setNoteStatus("idle");
  }, [invoice.id, invoice.note]);

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

        <footer className="invoice-slide-actions">
          <button type="button" onClick={() => onReprint(invoice)}><FileText size={18} />Reprint</button>
        </footer>
      </section>
    </Drawer>
  );
}

function DebtsCenterView({
  mode,
  todayInvoices,
  openInvoices,
  carriedDebts,
  todayTotalCents,
  openTotalCents,
  carriedTotalCents,
  onSelect
}: {
  mode: InvoiceListMode;
  todayInvoices: Invoice[];
  openInvoices: Invoice[];
  carriedDebts: Invoice[];
  todayTotalCents: number;
  openTotalCents: number;
  carriedTotalCents: number;
  onSelect: (invoice: Invoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unpaid" | "overdue" | "carried">("all");
  const [oldestFirst, setOldestFirst] = useState(mode === "debts");
  const debtInvoices = useMemo(() => [...openInvoices, ...carriedDebts], [openInvoices, carriedDebts]);
  const overdueInvoices = useMemo(() => debtInvoices.filter(isOverdueDebtInvoice), [debtInvoices]);
  const title = mode === "today" ? "Open invoices" : "Debts";
  const subline = mode === "today"
    ? `${todayInvoices.length} open today`
    : `${openInvoices.length} pending · ${carriedDebts.length} carried over`;
  const scopeInvoices = mode === "today" ? todayInvoices : debtInvoices;
  const totalOwed = openTotalCents + carriedTotalCents;
  const totalForMode = mode === "today" ? todayTotalCents : totalOwed;
  const searchTerm = query.trim().toLowerCase();

  useEffect(() => {
    setFilter("all");
    setOldestFirst(mode === "debts");
  }, [mode]);

  const visibleInvoices = useMemo(() => {
    const source =
      mode === "today"
        ? (filter === "unpaid" ? todayInvoices.filter((invoice) => outstanding(invoice) > 0) : todayInvoices)
        : filter === "overdue"
          ? overdueInvoices
          : filter === "carried"
            ? carriedDebts
            : debtInvoices;
    return source
      .filter((invoice) => !searchTerm || invoiceSearchText(invoice).includes(searchTerm))
      .sort((a, b) => oldestFirst ? Number(a.ts || 0) - Number(b.ts || 0) : Number(b.ts || 0) - Number(a.ts || 0));
  }, [carriedDebts, debtInvoices, filter, mode, oldestFirst, overdueInvoices, searchTerm, todayInvoices]);

  return (
    <section className="debts-center-panel">
      <header className="debts-center-header">
        <div>
          <h2 id="debts-center-title">{title}</h2>
          <p>{subline}</p>
        </div>
        {mode === "debts" && (
          <div className="debts-total">
            <span>Total owed</span>
            <b>{money(totalOwed)}</b>
          </div>
        )}
      </header>

      <label className="debts-search">
        <Search size={20} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search customer, phone, or receipt..."
        />
      </label>

      <div className="debts-controls">
        <div className="debts-filter-chips" role="tablist" aria-label="Debt filters">
          <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>All ({scopeInvoices.length})</button>
          {mode === "today" ? (
            <button className={filter === "unpaid" ? "active amber" : "amber"} type="button" onClick={() => setFilter("unpaid")}>Unpaid ({todayInvoices.length})</button>
          ) : (
            <>
              <button className={filter === "overdue" ? "active danger" : "danger"} type="button" onClick={() => setFilter("overdue")}>Overdue ({overdueInvoices.length})</button>
              <button className={filter === "carried" ? "active amber" : "amber"} type="button" onClick={() => setFilter("carried")}>Carried over ({carriedDebts.length})</button>
            </>
          )}
        </div>
        <button className="debts-sort" type="button" onClick={() => setOldestFirst((value) => !value)}>
          {oldestFirst ? "Oldest first" : "Newest first"}
        </button>
      </div>

      <div className="debts-list">
        {visibleInvoices.length === 0 ? (
          <div className="debts-empty">
            <FileText size={28} />
            <b>No invoices match</b>
            <span>Try another customer, phone, receipt, or filter.</span>
          </div>
        ) : visibleInvoices.map((invoice) => {
          const label = invoiceCustomerLabel(invoice);
          const displayLabel = label.trim().length > 1 ? label : invoice.number;
          const ageDays = invoiceAgeDays(invoice);
          const overdue = isOverdueDebtInvoice(invoice);
          const ageText = ageDays <= 0 ? "Today" : `${ageDays}d`;
          return (
            <button className="debts-row" type="button" key={invoice.id} onClick={() => onSelect(invoice)}>
              <span className="debts-avatar">{avatarInitial(displayLabel)}</span>
              <span className="debts-main">
                <b>{displayLabel}</b>
                <small title={invoice.number}>{middleReceipt(invoice.number)} &middot; {ageText}</small>
              </span>
              {mode === "debts" && <span className={"debts-age " + (overdue ? "overdue" : "recent")}>{ageText}</span>}
              <strong>{money(outstanding(invoice))}</strong>
              <ChevronRight size={18} />
            </button>
          );
        })}
      </div>

      <footer className="debts-footer-note">
        <span>View only &middot; settlement is done by a supervisor.</span>
        {mode === "today" && <b>{money(totalForMode)}</b>}
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

type VirtualKeyboardTarget = HTMLInputElement | HTMLTextAreaElement;

type VirtualKeyboardSession = {
  label: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "tel", "url"]);
const VIRTUAL_KEYBOARD_WIDTH = 760;
const VIRTUAL_KEYBOARD_HEIGHT = 330;

function isTextInputTarget(target: EventTarget | null): target is VirtualKeyboardTarget {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return false;
  if (target.disabled || target.readOnly) return false;
  if (target.dataset.virtualKeyboard === "off") return false;
  if (target instanceof HTMLTextAreaElement) return true;
  const type = target.type.toLowerCase();
  if (!TEXT_INPUT_TYPES.has(type)) return false;
  if (target.inputMode === "numeric" || target.inputMode === "decimal") return false;
  return true;
}

function hasHardwareKeyboard() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return true;
  const hasTouch = Number(navigator.maxTouchPoints || 0) > 0 || window.matchMedia("(pointer: coarse)").matches;
  return !hasTouch;
}

function keyboardFieldLabel(target: VirtualKeyboardTarget) {
  const explicit = target.dataset.keyboardLabel || target.getAttribute("aria-label");
  if (explicit) return explicit.trim();
  if (target.id) {
    const linked = document.querySelector(`label[for="${CSS.escape(target.id)}"]`);
    if (linked?.textContent?.trim()) return linked.textContent.trim();
  }
  const parentLabel = target.closest("label");
  const parentText = parentLabel?.textContent?.replace(target.value || "", "").trim();
  if (parentText) return parentText;
  const previousLabel = target.previousElementSibling;
  if (previousLabel?.tagName === "LABEL" && previousLabel.textContent?.trim()) return previousLabel.textContent.trim();
  return target.placeholder || "Text field";
}

function clampKeyboardPosition(position: { x: number; y: number }) {
  const maxX = Math.max(16, window.innerWidth - VIRTUAL_KEYBOARD_WIDTH - 16);
  const maxY = Math.max(16, window.innerHeight - VIRTUAL_KEYBOARD_HEIGHT - 16);
  return {
    x: Math.min(Math.max(16, position.x), maxX),
    y: Math.min(Math.max(16, position.y), maxY)
  };
}

function initialKeyboardPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIRTUAL_KEYBOARD_POSITION_KEY) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampKeyboardPosition(saved);
  } catch {
    // Position persistence is best-effort.
  }
  return clampKeyboardPosition({
    x: Math.max(16, Math.round((window.innerWidth - VIRTUAL_KEYBOARD_WIDTH) / 2)),
    y: Math.max(16, window.innerHeight - VIRTUAL_KEYBOARD_HEIGHT - 24)
  });
}

function targetSession(target: VirtualKeyboardTarget): VirtualKeyboardSession {
  return {
    label: keyboardFieldLabel(target),
    value: target.value,
    selectionStart: target.selectionStart ?? target.value.length,
    selectionEnd: target.selectionEnd ?? target.value.length
  };
}

function setTargetValue(target: VirtualKeyboardTarget, value: string, selection: number, inputType: string, data: string | null = null) {
  const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(target, value);
  target.setSelectionRange(selection, selection);
  try {
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  } catch {
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function renderKeyboardMirror(session: VirtualKeyboardSession) {
  const start = session.selectionStart;
  const end = session.selectionEnd;
  const value = session.value || "";
  return (
    <>
      {value.slice(0, start)}
      <i />
      {value.slice(end)}
    </>
  );
}

function VirtualKeyboard({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [caps, setCaps] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [session, setSession] = useState<VirtualKeyboardSession | null>(null);
  const [position, setPosition] = useState(initialKeyboardPosition);
  const targetRef = useRef<VirtualKeyboardTarget | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIRTUAL_KEYBOARD_POSITION_KEY, JSON.stringify(position));
    } catch {
      // Position persistence is best-effort.
    }
  }, [position]);

  useEffect(() => {
    const sync = () => {
      const target = targetRef.current;
      if (target) setSession(targetSession(target));
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!enabled || hasHardwareKeyboard()) return;
      if (isTextInputTarget(event.target)) {
        targetRef.current = event.target;
        setSession(targetSession(event.target));
        setMinimized(false);
        setOpen(true);
        return;
      }
      const element = event.target as Element | null;
      if (!element?.closest?.(".virtual-keyboard")) {
        targetRef.current = null;
        setOpen(false);
      }
    };

    const handleFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!isTextInputTarget(active)) {
          targetRef.current = null;
          setOpen(false);
        }
      }, 0);
    };

    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("focusout", handleFocusOut);
    window.addEventListener("input", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("click", sync);
    document.addEventListener("selectionchange", sync);
    return () => {
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("input", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("click", sync);
      document.removeEventListener("selectionchange", sync);
    };
  }, [enabled]);

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampKeyboardPosition(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const move = (moveEvent: PointerEvent) => {
      setPosition(clampKeyboardPosition({
        x: origin.x + moveEvent.clientX - startX,
        y: origin.y + moveEvent.clientY - startY
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function pressKey(key: string) {
    const target = targetRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    const value = target.value;
    const start = target.selectionStart ?? value.length;
    const end = target.selectionEnd ?? value.length;

    if (key === "backspace") {
      if (start === 0 && end === 0) return;
      const deleteStart = start === end ? Math.max(0, start - 1) : start;
      const next = value.slice(0, deleteStart) + value.slice(end);
      setTargetValue(target, next, deleteStart, "deleteContentBackward");
      setSession(targetSession(target));
      return;
    }

    const text = key === "space" ? " " : caps && key.length === 1 ? key.toUpperCase() : key;
    const next = value.slice(0, start) + text + value.slice(end);
    const cursor = start + text.length;
    setTargetValue(target, next, cursor, "insertText", text);
    setSession(targetSession(target));
  }

  function closeKeyboard() {
    targetRef.current = null;
    setOpen(false);
    setMinimized(false);
  }

  if (!enabled || !open || !session) return null;

  const letterRows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"]
  ];
  const symbolRows = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "KES", "-", "_", "&", ".", ",", "/"],
    ["(", ")", "'", "\"", ":", ";", "?", "!"]
  ];
  const rows = symbols ? symbolRows : letterRows;

  if (minimized) {
    return (
      <div className="virtual-keyboard-minimized" style={{ left: position.x, top: position.y }} role="dialog" aria-label="Virtual keyboard minimized">
        <button onMouseDown={(event) => event.preventDefault()} onClick={() => setMinimized(false)} aria-label="Restore virtual keyboard">
          <Keyboard size={18} />
          Keyboard
        </button>
        <button onMouseDown={(event) => event.preventDefault()} onClick={closeKeyboard} aria-label="Close virtual keyboard"><X size={15} /></button>
      </div>
    );
  }

  return (
    <section className="virtual-keyboard" style={{ left: position.x, top: position.y }} role="dialog" aria-label="On-screen keyboard">
      <div className="virtual-keyboard-title" onPointerDown={beginDrag}>
        <GripHorizontal size={18} />
        <div>
          <span>Typing into: {session.label}</span>
          <strong>{renderKeyboardMirror(session)}</strong>
        </div>
        <button onMouseDown={(event) => event.preventDefault()} onClick={() => setMinimized(true)} aria-label="Minimize virtual keyboard"><Minus size={16} /></button>
        <button onMouseDown={(event) => event.preventDefault()} onClick={closeKeyboard} aria-label="Close virtual keyboard"><X size={16} /></button>
      </div>

      <div className="virtual-keyboard-keys" onMouseDown={(event) => event.preventDefault()}>
        <div className="vk-row vk-number-row">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((key) => (
            <button key={key} type="button" aria-label={`Type ${key}`} onClick={() => pressKey(key)}>{key}</button>
          ))}
        </div>
        {rows.map((row, index) => (
          <div className={"vk-row row-" + index} key={row.join("")}>
            {index === 2 && !symbols && (
              <button type="button" className={caps ? "vk-wide active" : "vk-wide"} aria-label="Shift" onClick={() => setCaps((value) => !value)}>Shift</button>
            )}
            {row.map((key) => (
              <button key={key} type="button" aria-label={`Type ${key}`} onClick={() => pressKey(key)}>
                {symbols ? key : caps ? key.toUpperCase() : key}
              </button>
            ))}
            {index === 2 && (
              <button type="button" className="vk-wide danger" aria-label="Backspace" onClick={() => pressKey("backspace")}>Backspace</button>
            )}
          </div>
        ))}
        <div className="vk-row vk-action-row">
          <button type="button" className={symbols ? "vk-wide active" : "vk-wide"} aria-label="Toggle symbols keyboard" onClick={() => setSymbols((value) => !value)}>?123</button>
          <button type="button" className="vk-space" aria-label="Space" onClick={() => pressKey("space")}>Space</button>
          <button type="button" className="vk-done" aria-label="Done typing" onClick={closeKeyboard}>Done</button>
        </div>
      </div>
    </section>
  );
}

function ExpenseModal({
  cashierName,
  onClose,
  onSave
}: {
  cashierName: string;
  onClose: () => void;
  onSave: (expense: { category: string; amountCents: number; note?: string; source: "cash_till" | "mpesa"; status: "approved" | "pending" }) => Promise<void>;
}) {
  const [category, setCategory] = useState(SUPERVISOR_EXPENSE_CATEGORIES[0]);
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
      await onSave({
        category,
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
            {SUPERVISOR_EXPENSE_CATEGORIES.map((item) => (
              <button
                key={item}
                className={category === item ? "active" : ""}
                onClick={() => setCategory(item)}
              >
                {item}
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
        <div><span>Current Version</span><b>v0.1.0</b></div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="auth-footer">
      <span>VisionPOS</span>
      <span>Business in Focus</span>
      <span>Version 0.1.0</span>
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

function ActivationScreen({ onActivated, error, status, lastSyncAt, onClose }: {
  onActivated: (terminal: TerminalCredentials) => void;
  error: string;
  status: string;
  lastSyncAt?: number;
  onClose: () => void;
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
  onLogin
}: {
  terminal: TerminalCredentials;
  branch: Branch | null;
  lastSyncAt?: number;
  status: string;
  error: string;
  onClose: () => void;
  onLogin: (employeeNumber: string, pin: string) => Promise<void>;
}) {
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
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
        <button className="premium-primary" disabled={!canSubmit} onClick={submit}>{busy ? <span className="spinner" /> : <Wifi size={20} />}{busy ? "Signing in..." : "Sign In"}</button>
      </LoginCard>
    </AuthShell>
  );
}

function CashierPinPrompt({
  cashierName,
  onClose,
  onConfirm
}: {
  cashierName: string;
  onClose: () => void;
  onConfirm: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canSubmit = !busy && pin.trim().length >= 4;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage("");
    try {
      await onConfirm(pin.trim());
    } catch (err) {
      setMessage(String(err).replace(/^Error:\s*/, ""));
      setPin("");
      setBusy(false);
    }
  }

  return (
    <div className="pin-confirm-backdrop" role="presentation">
      <form className="pin-confirm-card" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="pin-confirm-head">
          <span><ShieldCheck size={18} /> Cashier confirmation</span>
          <button type="button" onClick={onClose} aria-label="Cancel PIN confirmation"><X size={18} /></button>
        </div>
        <h2>Enter {cashierName}'s PIN</h2>
        <p>This confirms the invoice is being issued by the logged-in cashier.</p>
        <label>Cashier PIN</label>
        <div className="pin-confirm-input">
          <KeyRound size={21} />
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
            type="password"
            inputMode="numeric"
            autoFocus
            placeholder="Enter PIN"
          />
        </div>
        {message && <div className="pin-confirm-error">{message}</div>}
        <button className="pin-confirm-primary" type="submit" disabled={!canSubmit}>
          {busy ? <span className="spinner" /> : <Check size={20} />}
          {busy ? "Verifying..." : "Confirm and issue invoice"}
        </button>
      </form>
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
