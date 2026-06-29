import type { Account, Branch, Product, Receipt, TerminalCredentials } from "./types";

export const API_BASE_URL = "https://visionarypos.cloud";
export const APP_VERSION = "0.1.0";

function uid(prefix: string) {
  const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
  return `${prefix}_${random}`;
}

function terminalHeaders(terminal: TerminalCredentials): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Terminal-UUID": terminal.uuid,
    "X-Terminal-Secret": terminal.terminalSecret
  };
}

async function jsonFetch<T>(path: string, init: RequestInit): Promise<T> {
  if (!API_BASE_URL.startsWith("https://")) throw new Error("HTTPS is required.");
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `request_failed_${response.status}`);
  return data as T;
}

export async function activateTerminal(activationCode: string, terminalName: string): Promise<TerminalCredentials> {
  const data = await jsonFetch<{
    terminal: Omit<TerminalCredentials, "terminalSecret">;
    terminalSecret: string;
  }>("/api/auth/terminals/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activationCode, terminalName, appVersion: APP_VERSION })
  });
  return { ...data.terminal, terminalSecret: data.terminalSecret };
}

export async function loginCashier(terminal: TerminalCredentials, employeeNumber: string, pin: string): Promise<{
  account: Account;
  sessionToken: string;
}> {
  return jsonFetch("/api/auth/login", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ identifier: employeeNumber.trim(), pin, branchId: terminal.branchId })
  });
}

export async function logout(sessionToken: string): Promise<void> {
  if (!sessionToken) return;
  await jsonFetch("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken })
  }).catch(() => undefined);
}

export async function pullCatalog(terminal: TerminalCredentials): Promise<{ branches: Branch[]; products: Product[] }> {
  const data = await jsonFetch<{ events: Array<any> }>("/api/sync/pull?since=0&limit=2000", {
    method: "GET",
    headers: terminalHeaders(terminal)
  });

  const branches: Branch[] = [];
  const products: Product[] = [];
  const stockByProduct = new Map<string, number>();

  for (const item of data.events || []) {
    if (item.deleted) continue;
    if (item.type === "branch") {
      const payload = item.payload || {};
      branches.push({ id: item.id, name: payload.name || payload.branchName || item.id, location: payload.location || "" });
    }
    if (item.type === "stockMovement") {
      const payload = item.payload || {};
      const productId = payload.productId || item.productId;
      if (productId && (payload.branchId || item.branchId) === terminal.branchId) {
        stockByProduct.set(productId, (stockByProduct.get(productId) || 0) + Number(payload.qty || 0));
      }
    }
    if (item.type === "product" && (item.branchId || item.payload?.branchId) === terminal.branchId) {
      const payload = item.payload || {};
      const priceCents = Number(payload.priceCents ?? payload.sellingPriceCents ?? Math.round(Number(payload.sellingPrice || payload.price || 0) * 100));
      const costCents = Number(payload.costCents ?? payload.costPriceCents ?? Math.round(Number(payload.costPrice || payload.cost || 0) * 100));
      products.push({
        id: item.id,
        branchId: terminal.branchId,
        name: payload.name || "Unnamed product",
        sku: payload.sku || "",
        barcode: payload.barcode || "",
        barcodes: Array.isArray(payload.barcodes) ? payload.barcodes : [],
        category: payload.category || payload.categoryId || "Uncategorised",
        categoryId: payload.categoryId || payload.category || "",
        image: payload.image || payload.imageUrl || "",
        priceCents,
        costCents,
        stockQty: Number(payload.stockQty ?? payload.stock ?? 0)
      });
    }
  }

  return {
    branches,
    products: products
      .map((product) => ({ ...product, stockQty: product.stockQty + (stockByProduct.get(product.id) || 0) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

export async function resolveBarcode(terminal: TerminalCredentials, barcode: string): Promise<Product | null> {
  const data = await jsonFetch<any>("/api/barcodes/resolve", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ barcode, branchId: terminal.branchId })
  });
  if (!data.available || !data.product) return null;
  return {
    id: data.product.id,
    branchId: data.product.branchId,
    name: data.product.name,
    sku: "",
    barcode,
    categoryId: data.product.categoryId,
    image: data.product.image || "",
    priceCents: Math.round(Number(data.product.sellingPrice || 0) * 100),
    costCents: Math.round(Number(data.product.costPrice || 0) * 100),
    stockQty: Number(data.product.stock || 0)
  };
}

export async function pushCheckout(terminal: TerminalCredentials, account: Account, receipt: Receipt): Promise<void> {
  const ts = Date.now();
  const invoiceId = uid("inv");
  const events = [
    {
      id: invoiceId,
      type: "invoice",
      branchId: terminal.branchId,
      clientTs: ts,
      payload: {
        id: invoiceId,
        number: receipt.number,
        customerName: receipt.customerName,
        cashierId: account.id,
        cashier: account.name,
        branchId: terminal.branchId,
        date: new Date(ts).toISOString().slice(0, 10),
        totalCents: receipt.totalCents,
        paidCents: receipt.totalCents,
        items: receipt.items,
        method: receipt.method,
        status: "paid",
        ts
      }
    },
    {
      id: uid("pay"),
      type: "payment",
      branchId: terminal.branchId,
      clientTs: ts,
      payload: {
        orderId: invoiceId,
        invoiceId,
        method: receipt.method.toLowerCase(),
        amountCents: receipt.totalCents,
        status: "captured",
        ts
      }
    },
    ...receipt.items.map((item) => ({
      id: uid("mv"),
      type: "stockMovement",
      branchId: terminal.branchId,
      clientTs: ts,
      payload: {
        productId: item.productId,
        branchId: terminal.branchId,
        qty: -item.qty,
        reason: `Sale ${receipt.number}`,
        ts
      }
    }))
  ];

  await jsonFetch("/api/sync/push", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ events })
  });
}

export async function pushCashSessionEvent(
  terminal: TerminalCredentials,
  account: Account,
  mode: "open" | "close",
  amountCents: number
): Promise<void> {
  const ts = Date.now();
  await jsonFetch("/api/sync/push", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({
      events: [{
        id: uid("cash"),
        type: "cashMovement",
        branchId: terminal.branchId,
        clientTs: ts,
        payload: {
          mode,
          branchId: terminal.branchId,
          cashierId: account.id,
          cashier: account.name,
          amountCents,
          reason: mode === "open" ? "Open cash session" : "Close cash session",
          ts
        }
      }]
    })
  });
}
