import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Barcode,
  Building2,
  Check,
  FileText,
  Grid2X2,
  Heart,
  KeyRound,
  Lock,
  LogOut,
  MonitorCheck,
  Search,
  Server,
  ShieldCheck,
  UserRound,
  WalletCards,
  Wine,
  Wifi,
  X
} from "lucide-react";
import {
  activateTerminal,
  loginCashier,
  logout,
  pullCatalog,
  pushCheckout,
  pushExpense,
  resolveBarcode
} from "./api";
import { clearTerminalCredentials, loadTerminalCredentials, saveTerminalCredentials } from "./secureStore";
import type { Account, Branch, CartLine, Invoice, Product, Receipt, TerminalCredentials } from "./types";

const LAST_CATALOG_KEY = "visionpos:cashier:last-catalog:v1";
const EXPENSE_CATEGORIES = ["Police", "Utilities", "Other"];

function money(cents: number) {
  return "KES " + Math.round(cents / 100).toLocaleString();
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

function productStatusText(product: Product) {
  const stock = productStock(product);
  if (stock <= 0) return "Out";
  if (product.priceCents <= 0) return "No price";
  if (product.costCents > 0 && product.priceCents < product.costCents) return "Below cost";
  return `${stock} in`;
}

function productStatusClass(product: Product) {
  return productSaleBlockReason(product, 0) ? "out" : "ok";
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
  const [saleNote, setSaleNote] = useState("");
  const [status, setStatus] = useState("Starting VISIONPOS Cashier...");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [scannerOn, setScannerOn] = useState(true);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [openInvoicesOpen, setOpenInvoicesOpen] = useState(false);
  const [debtsOpen, setDebtsOpen] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const catalogSyncInFlight = useRef(false);

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
  const openInvoiceTotal = openInvoices.reduce((sum, invoice) => sum + outstanding(invoice), 0);
  const carriedDebtTotal = carriedDebts.reduce((sum, invoice) => sum + outstanding(invoice), 0);

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
    if (!terminal) return;
    const syncQuietly = () => refreshCatalog(terminal, { silent: true });
    const intervalId = window.setInterval(syncQuietly, 8000);
    const onFocus = () => syncQuietly();
    const onOnline = () => syncQuietly();
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncQuietly();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
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
          setSaleNote("");
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
      return { ...current, [productId]: { ...line, qty } };
    });
    focusSearch();
  }

  async function completeSale() {
    if (!terminal || !account || !cartLines.length || !customerName.trim()) return;
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
      note: saleNote.trim(),
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
      await pushCheckout(terminal, account, nextReceipt);
      setReceipt(nextReceipt);
      setCart({});
      setCustomerName("");
      setSaleNote("");
      setStatus(`Open invoice ${receiptNumber} issued.`);
      refreshCatalog(terminal);
    } catch (err) {
      setError(`Checkout failed: ${String(err)}`);
    } finally {
      focusSearch();
    }
  }

  async function handleLogout() {
    await logout(sessionToken);
    setAccount(null);
    setSessionToken("");
    setCart({});
    setStatus("Signed out.");
  }

  async function handleCloseApp() {
    if (cartLines.length && !window.confirm("Close VISIONPOS Cashier and discard the current sale?")) return;
    await getCurrentWindow().close();
  }

  if (!terminal) {
    return (
      <ActivationScreen
        onActivated={(next) => { setTerminal(next); refreshCatalog(next); }}
        error={error}
        status={status}
        lastSyncAt={lastSyncAt}
      />
    );
  }

  if (!account) {
    return (
      <LoginScreen
        terminal={terminal}
        branch={branch}
        lastSyncAt={lastSyncAt}
        status={status}
        error={error}
        onLogin={async (employeeNumber, pin) => {
          setError("");
          const result = await loginCashier(terminal, employeeNumber, pin);
          setAccount(result.account);
          setSessionToken(result.sessionToken);
          setStatus(`Signed in as ${result.account.name}.`);
          await refreshCatalog(terminal);
        }}
      />
    );
  }

  return (
    <main className="workstation">
      <header className="topbar">
        <div className="brand"><span>V</span><strong>Vision<b>POS</b></strong></div>
        <div className="topmeta">
          <div className="branch-pill"><Building2 size={18} /><b>{branch?.name || terminal.branchId}</b><small>{terminal.terminalName}</small></div>
          <div className="cashier-id"><b>{account.name}</b><span>Cashier</span></div>
          <button className="window-close-button" onClick={handleCloseApp} title="Close app" aria-label="Close app"><X size={20} /></button>
        </div>
      </header>

      <section className="layout">
        <aside className="left-panel">
          <div
            className="card dark open-invoices clickable-card"
            role="button"
            tabIndex={0}
            onClick={() => setOpenInvoicesOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpenInvoicesOpen(true);
              }
            }}
          >
            <div className="card-head">
              <div>
                <h3>Open invoices</h3>
                <strong>{branch?.name || terminal.branchId}</strong>
              </div>
              <button
                className={"scanner-pill" + (scannerOn ? " on" : "")}
                onClick={(event) => {
                  event.stopPropagation();
                  setScannerOn((value) => !value);
                }}
              >
                <Barcode size={15} />{scannerOn ? "On" : "Off"}
              </button>
            </div>
            <div className="invoice-total">
              <span>{openInvoices.length} unpaid invoice{openInvoices.length === 1 ? "" : "s"}</span>
              <b>{money(openInvoiceTotal)}</b>
            </div>
            {openInvoices.length === 0 ? (
              <div className="invoice-empty">
                <b>No open invoices</b>
                <span>Paid and closed invoices stay out of the cashier workspace.</span>
              </div>
            ) : (
              <div className="invoice-list">
                {openInvoices.slice(0, 8).map((invoice) => (
                  <button
                    key={invoice.id}
                    className="invoice-row"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenInvoicesOpen(true);
                    }}
                  >
                    <span><b>{invoice.number}</b><small>{invoice.customerName || "Walk-in"}</small></span>
                    <strong>{money(outstanding(invoice))}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            className="card dark debt-card clickable-card"
            role="button"
            tabIndex={0}
            onClick={() => setDebtsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setDebtsOpen(true);
              }
            }}
          >
            <div className="card-head">
              <h3>Debt tracker</h3>
              <button
                className="text-link"
                onClick={(event) => {
                  event.stopPropagation();
                  setDebtsOpen(true);
                }}
              >
                View
              </button>
            </div>
            <div className="debt-line"><span>Carried-over debts</span><b>{money(carriedDebtTotal)}</b></div>
            <p>{carriedDebts.length} unpaid carried-over invoice{carriedDebts.length === 1 ? "" : "s"}</p>
            {carriedDebts.length === 0 && <p>No carried-over debts for your login.</p>}
          </div>
          <div className="card dark quick-actions">
            <h3>Quick Actions</h3>
            <button onClick={() => setExpenseOpen(true)}><WalletCards size={17} />Expense</button>
            <button disabled={!cartLines.length} onClick={() => { setCart({}); setCustomerName(""); setSaleNote(""); setStatus("Sale held. Start a new invoice when ready."); }}><FileText size={17} />Hold Sale</button>
            <button onClick={() => setDebtsOpen(true)}><span className="info-dot">!</span>My Debts{carriedDebtTotal > 0 ? ` - ${money(carriedDebtTotal)}` : ""}</button>
            <button className="logout-action" onClick={handleLogout}><LogOut size={18} />Logout</button>
          </div>
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
                className={"category-chip" + (selectedCategory === category ? " active" : "")}
                onClick={() => setSelectedCategory(category)}
              >
                {category === "All Products" ? <Grid2X2 size={16} /> : <Wine size={16} />}
                {category}
              </button>
            ))}
            <small>F2 Search - F4 Checkout - F6 Hold - Esc Clear search</small>
          </div>
          <div className="product-grid">
            {filteredProducts.map((product) => (
              <button className="product-card" key={product.id} disabled={Boolean(productSaleBlockReason(product, 0))} onClick={() => addToCart(product)}>
                <div className="product-image">{product.image ? <img src={product.image} alt="" /> : <span>{product.name.slice(0, 1)}</span>}</div>
                <span className="product-name">{product.name}</span>
                <span className="product-code">SKU: {product.sku || product.barcode || "No code"}</span>
                <span className="product-code">Volume: {product.size || "N/A"}</span>
                <span className="product-foot"><b>{money(product.priceCents)}</b><small className={productStatusClass(product)}>{productStatusText(product)}</small></span>
                <span className="product-stepper"><i>+</i><b>1</b><i>-</i></span>
              </button>
            ))}
          </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-head">
            <div>
              <h2>Current Invoice</h2>
              <span>{itemCount} item(s) · {branch?.name || terminal.branchId}</span>
            </div>
          </div>
          <div className="cart-lines">
            {cartLines.length === 0 && <div className="empty">Scan or tap products to start.</div>}
            {cartLines.map((line) => (
              <div className="cart-line" key={line.product.id}>
                <div><b>{line.product.name}</b><span>{money(line.product.priceCents)}</span></div>
                <div className="qty"><button onClick={() => changeQty(line.product.id, -1)}>-</button><b>{line.qty}</b><button onClick={() => changeQty(line.product.id, 1)}>+</button></div>
              </div>
            ))}
          </div>
          <label>Customer name / identifier <em>*</em></label>
          <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Required - name, phone or ID" />
          <label>Sale note</label>
          <input value={saleNote} onChange={(event) => setSaleNote(event.target.value)} placeholder="Optional receipt note" />
          <div className="subtotal"><span>Subtotal</span><b>{money(totalCents)}</b></div>
          <div className="total-row"><span>Total</span><strong>{money(totalCents)}</strong></div>
          <button className="checkout" disabled={!cartLines.length || !customerName.trim()} onClick={completeSale}><Check size={21} />Complete Sale <span>F4</span></button>
          <div className="cart-actions">
            <button disabled={!cartLines.length} onClick={() => { setCart({}); setCustomerName(""); setSaleNote(""); setStatus("Sale held. Start a new invoice when ready."); }}>Hold</button>
            <button disabled={!cartLines.length && !customerName && !saleNote} onClick={() => { setCart({}); setCustomerName(""); setSaleNote(""); setQuery(""); focusSearch(); }}>Clear</button>
          </div>
          {cartLines.length > 0 && !customerName.trim() && <p className="hint">Enter a customer name / identifier to issue the invoice.</p>}
          <p className="hint muted">Issues an open invoice cleared by admin or supervisor.</p>
          {(error || status) && <p className={"status-note " + (error ? "bad" : "good")}>{error || status}</p>}
        </aside>
      </section>

      {receipt && <ReceiptPreview receipt={receipt} onClose={() => setReceipt(null)} />}
      {expenseOpen && terminal && account && (
        <ExpenseModal
          onClose={() => { setExpenseOpen(false); focusSearch(); }}
          onSave={async (expense) => {
            setError("");
            await pushExpense(terminal, account, expense);
            setStatus(expense.amountCents > 50000 ? "Expense sent for admin approval." : "Expense recorded.");
            setExpenseOpen(false);
            await refreshCatalog(terminal);
            focusSearch();
          }}
        />
      )}
      {(openInvoicesOpen || debtsOpen) && (
        <DebtsAndInvoicesModal
          cashierName={account.name}
          openInvoices={openInvoices}
          carriedDebts={carriedDebts}
          openTotalCents={openInvoiceTotal}
          carriedTotalCents={carriedDebtTotal}
          onClose={() => {
            setOpenInvoicesOpen(false);
            setDebtsOpen(false);
            focusSearch();
          }}
        />
      )}
    </main>
  );
}

function ExpenseModal({
  onClose,
  onSave
}: {
  onClose: () => void;
  onSave: (expense: { category: string; amountCents: number; note?: string }) => Promise<void>;
}) {
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const amountCents = Math.round((Number(amount) || 0) * 100);

  async function submit() {
    if (amountCents <= 0) {
      setMessage("Enter a valid expense amount.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await onSave({ category, amountCents, note: note.trim() });
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="cashier-modal">
        <div className="modal-head">
          <div>
            <span>Quick</span>
            <h2>Record Expense</h2>
          </div>
          <button className="close-button" onClick={onClose}><X size={20} /></button>
        </div>
        <label>Category</label>
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          {EXPENSE_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label>Amount (KES)</label>
        <input value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="0.00" autoFocus />
        <label>Note</label>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional expense note" />
        {amountCents > 50000 && <div className="notice">Expenses above KES 500 are sent for admin approval.</div>}
        {message && <div className="error">{message}</div>}
        <button className="modal-primary" disabled={busy || amountCents <= 0} onClick={submit}><Check size={18} />{busy ? "Saving..." : "Save Expense"}</button>
      </div>
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
  activationMode = false
}: {
  children: ReactNode;
  terminal?: TerminalCredentials | null;
  branch?: Branch | null;
  lastSyncAt?: number;
  status: string;
  activationMode?: boolean;
}) {
  return (
    <main className="auth premium-auth">
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

function ActivationScreen({ onActivated, error, status, lastSyncAt }: {
  onActivated: (terminal: TerminalCredentials) => void;
  error: string;
  status: string;
  lastSyncAt?: number;
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
    <AuthShell lastSyncAt={lastSyncAt} status={status} activationMode>
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
  onLogin
}: {
  terminal: TerminalCredentials;
  branch: Branch | null;
  lastSyncAt?: number;
  status: string;
  error: string;
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
    <AuthShell terminal={terminal} branch={branch} lastSyncAt={lastSyncAt} status={status}>
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
