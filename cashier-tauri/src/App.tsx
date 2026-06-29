import { useEffect, useMemo, useRef, useState } from "react";
import {
  activateTerminal,
  loginCashier,
  logout,
  pullCatalog,
  pushCashSessionEvent,
  pushCheckout,
  resolveBarcode
} from "./api";
import { clearTerminalCredentials, loadTerminalCredentials, saveTerminalCredentials } from "./secureStore";
import type { Account, Branch, CartLine, CashSession, Product, Receipt, TerminalCredentials } from "./types";

const CASH_SESSION_KEY = "visionpos:cashier:cash-session:v1";
const LAST_CATALOG_KEY = "visionpos:cashier:last-catalog:v1";

function money(cents: number) {
  return "KES " + Math.round(cents / 100).toLocaleString();
}

function uid(prefix: string) {
  const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
  return `${prefix}_${random}`;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function loadCashSession(): CashSession | null {
  try {
    const raw = localStorage.getItem(CASH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCashSession(session: CashSession | null) {
  if (!session) localStorage.removeItem(CASH_SESSION_KEY);
  else localStorage.setItem(CASH_SESSION_KEY, JSON.stringify(session));
}

function saveCatalog(branches: Branch[], products: Product[]) {
  localStorage.setItem(LAST_CATALOG_KEY, JSON.stringify({ branches, products, savedAt: Date.now() }));
}

function loadCatalog(): { branches: Branch[]; products: Product[] } {
  try {
    const raw = localStorage.getItem(LAST_CATALOG_KEY);
    if (!raw) return { branches: [], products: [] };
    const parsed = JSON.parse(raw);
    return { branches: parsed.branches || [], products: parsed.products || [] };
  } catch {
    return { branches: [], products: [] };
  }
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
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [query, setQuery] = useState("");
  const [customerName, setCustomerName] = useState("Walk-in");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [status, setStatus] = useState("Starting VISIONPOS Cashier...");
  const [error, setError] = useState("");
  const [cashSession, setCashSession] = useState<CashSession | null>(() => loadCashSession());
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const branch = branches.find((item) => item.id === terminal?.branchId) || null;
  const cartLines = Object.values(cart);
  const totalCents = cartLines.reduce((sum, line) => sum + line.qty * line.product.priceCents, 0);
  const itemCount = cartLines.reduce((sum, line) => sum + line.qty, 0);

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

  useScanner((barcode) => handleScan(barcode), Boolean(account));

  async function refreshCatalog(nextTerminal = terminal) {
    if (!nextTerminal) return;
    try {
      setStatus("Syncing products...");
      const pulled = await pullCatalog(nextTerminal);
      setBranches(pulled.branches);
      setProducts(pulled.products);
      saveCatalog(pulled.branches, pulled.products);
      setStatus("Connected.");
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
    if (!terminal || !account || !cashSession || !cartLines.length) return;
    setError("");
    const receiptNumber = `RCP-${terminal.branchId.toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const nextReceipt: Receipt = {
      number: receiptNumber,
      branchName: branch?.name || terminal.branchId,
      cashierName: account.name,
      customerName: customerName.trim() || "Walk-in",
      method: paymentMethod,
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
      setCustomerName("Walk-in");
      setStatus("Sale completed.");
      refreshCatalog(terminal);
    } catch (err) {
      setError(`Checkout failed: ${String(err)}`);
    } finally {
      focusSearch();
    }
  }

  async function openCashSession(openingFloat: string) {
    if (!terminal || !account) return;
    const amountCents = Math.round(Number(openingFloat || 0) * 100);
    const next: CashSession = {
      id: uid("cash_session"),
      openedAt: Date.now(),
      openingFloatCents: amountCents,
      cashierId: account.id,
      cashierName: account.name
    };
    await pushCashSessionEvent(terminal, account, "open", amountCents);
    saveCashSession(next);
    setCashSession(next);
    setStatus("Cash session opened.");
  }

  async function closeCashSession(closingCash: string) {
    if (!terminal || !account || !cashSession) return;
    const amountCents = Math.round(Number(closingCash || 0) * 100);
    await pushCashSessionEvent(terminal, account, "close", amountCents);
    saveCashSession(null);
    setCashSession(null);
    setCart({});
    setStatus("Cash session closed.");
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
        <div className="brand"><span>V</span><strong>VISIONPOS Cashier</strong></div>
        <div className="topmeta">
          <b>{branch?.name || terminal.branchId}</b>
          <span>{terminal.terminalName}</span>
          <span>{account.name}</span>
          <button onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <section className="statusline">
        <span className={error ? "bad" : "good"}>{error || status}</span>
        <button onClick={() => refreshCatalog()}>Sync products</button>
      </section>

      <section className="layout">
        <aside className="left-panel">
          <CashSessionCard
            cashSession={cashSession}
            openCashSession={openCashSession}
            closeCashSession={closeCashSession}
          />
          <div className="card">
            <h3>Shortcuts</h3>
            <button onClick={focusSearch}>Focus search</button>
            <button onClick={() => setCart({})}>Clear cart</button>
            <button onClick={() => refreshCatalog()}>Refresh catalog</button>
          </div>
          <div className="card">
            <h3>Categories</h3>
            {[...new Set(products.map((product) => product.category || "Uncategorised"))].slice(0, 12).map((category) => (
              <button key={category} onClick={() => setQuery(category || "")}>{category}</button>
            ))}
          </div>
        </aside>

        <section className="products-panel">
          <div className="searchbar">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && filteredProducts[0]) addToCart(filteredProducts[0]);
              }}
              placeholder="Scan barcode or search product..."
              autoFocus
            />
          </div>
          <div className="product-grid">
            {filteredProducts.map((product) => (
              <button className="product-card" key={product.id} onClick={() => addToCart(product)}>
                <div className="product-image">{product.image ? <img src={product.image} alt="" /> : <span>{product.name.slice(0, 1)}</span>}</div>
                <strong>{product.name}</strong>
                <span>{product.sku || product.barcode || "No code"}</span>
                <b>{money(product.priceCents)}</b>
              </button>
            ))}
          </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-head">
            <div>
              <h2>Current Sale</h2>
              <span>{itemCount} item(s)</span>
            </div>
            <strong>{money(totalCents)}</strong>
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
          <label>Customer</label>
          <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Walk-in" />
          <label>Payment</label>
          <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
            <option>Cash</option>
            <option>M-Pesa</option>
            <option>Card</option>
          </select>
          <button className="checkout" disabled={!cashSession || !cartLines.length} onClick={completeSale}>Complete Sale</button>
          {!cashSession && <p className="hint">Open a cash session before checkout.</p>}
        </aside>
      </section>

      {receipt && <ReceiptPreview receipt={receipt} onClose={() => setReceipt(null)} />}
    </main>
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

function CashSessionCard({
  cashSession,
  openCashSession,
  closeCashSession
}: {
  cashSession: CashSession | null;
  openCashSession: (openingFloat: string) => Promise<void>;
  closeCashSession: (closingCash: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (cashSession) await closeCashSession(amount);
      else await openCashSession(amount);
      setAmount("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card cash">
      <h3>Cash Session</h3>
      <div className={cashSession ? "session open" : "session"}>{cashSession ? "Open" : "Closed"}</div>
      {cashSession && <p>Opened with {money(cashSession.openingFloatCents)}</p>}
      <label>{cashSession ? "Closing cash" : "Opening float"}</label>
      <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" />
      <button disabled={busy} onClick={submit}>{cashSession ? "Close Cash Session" : "Open Cash Session"}</button>
    </div>
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
          <hr />
          {receipt.items.map((item) => (
            <div className="receipt-line" key={item.name + item.qty}>
              <span>{item.qty} x {item.name}</span>
              <b>{money(item.qty * item.priceCents)}</b>
            </div>
          ))}
          <hr />
          <div className="receipt-total"><span>Total</span><b>{money(receipt.totalCents)}</b></div>
          <p>Paid by {receipt.method}</p>
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
