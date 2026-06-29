import { useEffect, useMemo, useRef, useState } from "react";
import { Barcode, Building2, Check, FileText, Menu, Search, WalletCards, X } from "lucide-react";
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

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function saveCatalog(branches: Branch[], products: Product[], invoices: Invoice[]) {
  localStorage.setItem(LAST_CATALOG_KEY, JSON.stringify({ branches, products, invoices, savedAt: Date.now() }));
}

function loadCatalog(): { branches: Branch[]; products: Product[]; invoices: Invoice[] } {
  try {
    const raw = localStorage.getItem(LAST_CATALOG_KEY);
    if (!raw) return { branches: [], products: [], invoices: [] };
    const parsed = JSON.parse(raw);
    return { branches: parsed.branches || [], products: parsed.products || [], invoices: parsed.invoices || [] };
  } catch {
    return { branches: [], products: [], invoices: [] };
  }
}

function outstanding(invoice: Invoice) {
  return Math.max(0, Number(invoice.totalCents || 0) - Number(invoice.paidCents || 0));
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
  const [customerName, setCustomerName] = useState("");
  const [saleNote, setSaleNote] = useState("");
  const [status, setStatus] = useState("Starting VISIONPOS Cashier...");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [scannerOn, setScannerOn] = useState(true);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [debtsOpen, setDebtsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

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

  const filteredProducts = useMemo(() => {
    const q = normalize(query);
    if (!q) return products.slice(0, 80);
    return products.filter((product) => {
      const haystack = [product.name, product.sku, product.barcode, product.category, ...(product.barcodes || [])].join(" ").toLowerCase();
      return haystack.includes(q);
    }).slice(0, 80);
  }, [products, query]);

  const focusSearch = () => setTimeout(() => searchRef.current?.focus(), 20);

  useEffect(() => {
    loadTerminalCredentials().then((stored) => {
      const cached = loadCatalog();
      setBranches(cached.branches);
      setProducts(cached.products);
      setInvoices(cached.invoices);
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

  async function refreshCatalog(nextTerminal = terminal) {
    if (!nextTerminal) return;
    try {
      setStatus("Syncing products...");
      const pulled = await pullCatalog(nextTerminal);
      setBranches(pulled.branches);
      setProducts(pulled.products);
      setInvoices(pulled.invoices);
      saveCatalog(pulled.branches, pulled.products, pulled.invoices);
      setStatus(`Connected. Synced ${pulled.products.length} products and ${pulled.invoices.length} invoices.`);
    } catch (err) {
      if (String(err).includes("terminal_not_authorized")) {
        await clearTerminalCredentials();
        setTerminal(null);
        setAccount(null);
      }
      setStatus("Using last cached catalog.");
      setError(String(err));
    }
  }

  async function handleScan(barcode: string) {
    setQuery(barcode);
    const local = products.find((product) => {
      const codes = [product.barcode, product.sku, ...(product.barcodes || [])].filter(Boolean).map((value) => normalize(String(value)));
      return codes.includes(normalize(barcode));
    });
    if (local) {
      addToCart(local);
      setStatus(`Added ${local.name}`);
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
      addToCart(remote);
      setStatus(`Added ${remote.name}`);
    } catch (err) {
      setError(String(err));
    } finally {
      focusSearch();
    }
  }

  function addToCart(product: Product) {
    setCart((current) => ({
      ...current,
      [product.id]: { product, qty: (current[product.id]?.qty || 0) + 1 }
    }));
    setQuery("");
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

  if (!terminal) {
    return <ActivationScreen onActivated={(next) => { setTerminal(next); refreshCatalog(next); }} error={error} />;
  }

  if (!account) {
    return (
      <LoginScreen
        terminal={terminal}
        branch={branch}
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
        onResetTerminal={async () => {
          await clearTerminalCredentials();
          setTerminal(null);
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
          <button className="menu-button" onClick={handleLogout} title="Logout"><Menu size={20} /></button>
        </div>
      </header>

      <section className="layout">
        <aside className="left-panel">
          <div className="card dark open-invoices">
            <div className="card-head">
              <div>
                <h3>Open invoices</h3>
                <strong>{branch?.name || terminal.branchId}</strong>
              </div>
              <button className={"scanner-pill" + (scannerOn ? " on" : "")} onClick={() => setScannerOn((value) => !value)}><Barcode size={15} />{scannerOn ? "On" : "Off"}</button>
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
                  <button key={invoice.id} className="invoice-row" onClick={() => setCustomerName(invoice.customerName || "Walk-in")}>
                    <span><b>{invoice.number}</b><small>{invoice.customerName || "Walk-in"}</small></span>
                    <strong>{money(outstanding(invoice))}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="card dark debt-card">
            <div className="card-head">
              <h3>Debt tracker</h3>
              <button className="text-link" onClick={() => setStatus(`${carriedDebts.length} carried-over debt invoice(s).`)}>View</button>
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
            <b>{products.length}</b> products
            <span>All categories</span>
            <small>F2 Search - F4 Checkout - F6 Hold - Esc Clear search</small>
          </div>
          <div className="product-grid">
            {filteredProducts.map((product) => (
              <button className="product-card" key={product.id} onClick={() => addToCart(product)}>
                <div className="product-image">{product.image ? <img src={product.image} alt="" /> : <span>{product.name.slice(0, 1)}</span>}</div>
                <span className="product-name">{product.name}</span>
                <span className="product-code">{product.sku || product.barcode || "No code"}</span>
                <span className="product-foot"><b>{money(product.priceCents)}</b><small>{product.priceCents > 0 ? "In" : "Out"}</small></span>
              </button>
            ))}
          </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-head">
            <div>
              <h2>Current Sale</h2>
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
      {debtsOpen && (
        <DebtsModal
          debts={carriedDebts}
          totalCents={carriedDebtTotal}
          onClose={() => { setDebtsOpen(false); focusSearch(); }}
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

function ActivationScreen({ onActivated, error }: { onActivated: (terminal: TerminalCredentials) => void; error: string }) {
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
    <main className="auth">
      <div className="auth-card">
        <div className="logo">V</div>
        <h1>Register Terminal</h1>
        <p>Enter the activation code generated by an admin. This computer will become a registered cashier terminal.</p>
        <label>Terminal name</label>
        <input value={terminalName} onChange={(event) => setTerminalName(event.target.value)} />
        <label>Activation code</label>
        <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD-1234-EFGH" />
        {message && <div className="error">{message}</div>}
        <button disabled={busy || code.length < 8} onClick={submit}>{busy ? "Registering..." : "Activate Terminal"}</button>
      </div>
    </main>
  );
}

function LoginScreen({
  terminal,
  branch,
  status,
  error,
  onLogin,
  onResetTerminal
}: {
  terminal: TerminalCredentials;
  branch: Branch | null;
  status: string;
  error: string;
  onLogin: (employeeNumber: string, pin: string) => Promise<void>;
  onResetTerminal: () => Promise<void>;
}) {
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);

  async function submit() {
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
    <main className="auth">
      <div className="auth-card">
        <div className="logo">V</div>
        <h1>Cashier Login</h1>
        <p>{branch?.name || terminal.branchId} · {terminal.terminalName}</p>
        <label>Employee number</label>
        <input value={employeeNumber} onChange={(event) => setEmployeeNumber(event.target.value)} autoFocus />
        <label>PIN</label>
        <input value={pin} onChange={(event) => setPin(event.target.value)} type="password" inputMode="numeric" />
        {(message || status) && <div className={message ? "error" : "notice"}>{message || status}</div>}
        <button disabled={busy || !employeeNumber.trim() || pin.length < 4} onClick={submit}>{busy ? "Signing in..." : "Sign In"}</button>
        <button className="ghost" onClick={onResetTerminal}>Reset terminal registration</button>
      </div>
    </main>
  );
}

function ReceiptPreview({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  return (
    <div className="receipt-backdrop">
      <div className="receipt-modal">
        <div className="receipt" id="receipt-print">
          <h2>VISIONPOS</h2>
          <p>{receipt.branchName}</p>
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
          <button onClick={() => window.print()}>Print receipt</button>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
