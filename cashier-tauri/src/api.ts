import { invoke } from "@tauri-apps/api/core";
import type { Account, Branch, Invoice, Product, Receipt, TerminalCredentials } from "./types";

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
  const headers: Record<string, string> = {};
  new Headers(init.headers || {}).forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  if (typeof init.body === "string" && init.body.trim()) {
    body = JSON.parse(init.body);
  }

  const response = await invoke<{ status: number; ok: boolean; body: any }>("api_request", {
    req: {
      method: init.method || "GET",
      path,
      headers,
      body
    }
  });

  if (!response.ok) throw new Error(response.body?.error || `request_failed_${response.status}`);
  return response.body as T;
}

function centsFromPayload(payload: any, fields: string[], fallback = 0) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    return Math.round(value);
  }
  return fallback;
}

function moneyToCentsFromPayload(payload: any, fields: string[], fallback = 0) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    return Math.round(value * 100);
  }
  return fallback;
}

function productDedupeKey(product: Product) {
  const code = product.sku || product.barcode || product.barcodes?.[0] || "";
  return `${product.branchId}|${code ? "code:" + code.toLowerCase() : "name:" + product.name.toLowerCase()}`;
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

export async function pullCatalog(terminal: TerminalCredentials): Promise<{ branches: Branch[]; products: Product[]; invoices: Invoice[] }> {
  let cursor = 0;
  let hasMore = true;
  const events: Array<any> = [];

  while (hasMore) {
    const data = await jsonFetch<{ events: Array<any>; cursor?: number; hasMore?: boolean }>(`/api/sync/pull?since=${cursor}&limit=2000`, {
      method: "GET",
      headers: terminalHeaders(terminal)
    });
    events.push(...(data.events || []));
    hasMore = Boolean(data.hasMore && data.cursor && data.cursor !== cursor);
    cursor = Number(data.cursor || cursor);
  }

  const branchRecords = new Map<string, any>();
  const productRecords = new Map<string, any>();
  const productDeduped = new Map<string, Product>();
  const invoiceRecords = new Map<string, Invoice>();
  const paidByInvoice = new Map<string, number>();
  const stockByProduct = new Map<string, number>();

  for (const item of events) {
    if (item.type === "branch") {
      if (item.deleted) {
        branchRecords.delete(item.id);
        continue;
      }
      const prev = branchRecords.get(item.id);
      if (!prev || Number(item.serverTs || 0) >= Number(prev.serverTs || 0)) branchRecords.set(item.id, item);
    }
    if (item.type === "product") {
      if (item.deleted) {
        productRecords.delete(item.id);
        continue;
      }
      const prev = productRecords.get(item.id);
      if (!prev || Number(item.serverTs || 0) >= Number(prev.serverTs || 0)) productRecords.set(item.id, item);
    }
    if (item.type === "invoice") {
      const payload = item.payload || {};
      const invoice: Invoice = {
        id: item.id,
        number: payload.number || item.id,
        branchId: payload.branchId || item.branchId || "",
        cashierId: payload.cashierId,
        customerName: payload.customerName || "",
        totalCents: centsFromPayload(payload, ["totalCents", "total_cents"], moneyToCentsFromPayload(payload, ["total", "amount"])),
        paidCents: centsFromPayload(payload, ["paidCents", "paid_cents"], moneyToCentsFromPayload(payload, ["paid"])),
        carriedOver: Boolean(payload.carriedOver || payload.carried_over),
        status: payload.status || "",
        ts: Number(payload.ts || item.clientTs || 0)
      };
      invoiceRecords.set(invoice.id, invoice);
    }
    if (item.type === "payment") {
      const payload = item.payload || {};
      const invoiceId = payload.invoiceId || payload.orderId;
      const amount = centsFromPayload(payload, ["amountCents", "amount_cents"], moneyToCentsFromPayload(payload, ["amount"]));
      if (invoiceId) paidByInvoice.set(invoiceId, (paidByInvoice.get(invoiceId) || 0) + amount);
    }
    if (item.type === "stockMovement") {
      const payload = item.payload || {};
      const productId = payload.productId || item.productId;
      if (productId && (payload.branchId || item.branchId) === terminal.branchId) {
        stockByProduct.set(productId, (stockByProduct.get(productId) || 0) + Number(payload.qty || 0));
      }
    }
  }

  const branches = Array.from(branchRecords.values()).map((item) => {
    const payload = item.payload || {};
    return { id: item.id, name: payload.name || payload.branchName || item.id, location: payload.location || "" };
  });

  for (const item of productRecords.values()) {
    if ((item.branchId || item.payload?.branchId) === terminal.branchId) {
      const payload = item.payload || {};
      const product: Product = {
        id: String(item.id),
        branchId: terminal.branchId,
        name: payload.name || "Unnamed product",
        sku: payload.sku || "",
        barcode: payload.barcode || "",
        barcodes: Array.isArray(payload.barcodes) ? payload.barcodes : [],
        category: payload.category || payload.categoryId || "Uncategorised",
        categoryId: payload.categoryId || payload.category || "",
        image: payload.image || payload.imageUrl || payload.image_url || "",
        priceCents: centsFromPayload(payload, ["priceCents", "sellingPriceCents", "selling_price_cents"], moneyToCentsFromPayload(payload, ["sellingPrice", "selling_price", "price"])),
        costCents: centsFromPayload(payload, ["costCents", "costPriceCents", "cost_price_cents"], moneyToCentsFromPayload(payload, ["costPrice", "cost_price", "cost"])),
        stockQty: Number(payload.stockQty ?? payload.stock ?? 0)
      };
      const current = productDeduped.get(productDedupeKey(product));
      if (!current || (product.priceCents > 0 && current.priceCents <= 0) || product.id > current.id) {
        productDeduped.set(productDedupeKey(product), product);
      }
    }
  }

  return {
    branches,
    invoices: Array.from(invoiceRecords.values())
      .map((invoice) => ({ ...invoice, paidCents: Math.max(invoice.paidCents, paidByInvoice.get(invoice.id) || 0) }))
      .filter((invoice) => invoice.branchId === terminal.branchId)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)),
    products: Array.from(productDeduped.values())
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
    priceCents: centsFromPayload(data.product, ["priceCents", "sellingPriceCents"], moneyToCentsFromPayload(data.product, ["sellingPrice", "price"])),
    costCents: centsFromPayload(data.product, ["costCents", "costPriceCents"], moneyToCentsFromPayload(data.product, ["costPrice", "cost"])),
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
        note: receipt.note || "",
        cashierId: account.id,
        cashier: account.name,
        branchId: terminal.branchId,
        date: new Date(ts).toISOString().slice(0, 10),
        totalCents: receipt.totalCents,
        paidCents: 0,
        items: receipt.items,
        method: "Invoice",
        status: "open",
        carriedOver: false,
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

export async function pushExpense(
  terminal: TerminalCredentials,
  account: Account,
  expense: { category: string; amountCents: number; note?: string }
): Promise<void> {
  const ts = Date.now();
  const status = expense.amountCents > 50000 ? "pending" : "approved";
  await jsonFetch("/api/sync/push", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({
      events: [{
        id: uid("ex"),
        type: "expense",
        branchId: terminal.branchId,
        clientTs: ts,
        payload: {
          category: expense.category,
          amountCents: expense.amountCents,
          note: `Quick expense - ${account.name}${expense.note ? " - " + expense.note : ""}`,
          status,
          enteredBy: account.name,
          cashierId: account.id,
          branchId: terminal.branchId,
          date: new Date(ts).toISOString().slice(0, 10),
          ts
        }
      }]
    })
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
