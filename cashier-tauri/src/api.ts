import { invoke } from "@tauri-apps/api/core";
import { productDisplayImage } from "./productImages";
import type { Account, Branch, Invoice, Product, Receipt, TerminalCredentials } from "./types";

export const API_BASE_URL = "https://visionarypos.cloud";
export const APP_VERSION = "2.0.7";
export const UPDATE_MANIFEST_URL = `${API_BASE_URL}/downloads/release.json`;

export type UpdateManifest = {
  version: string;
  platform?: string;
  installer?: string;
  size?: number;
  sha512?: string;
  releaseNotes?: string[];
};

export async function fetchUpdateManifest(): Promise<UpdateManifest> {
  return invoke<UpdateManifest>("fetch_update_manifest");
}

export function absoluteDownloadUrl(pathOrUrl?: string) {
  if (pathOrUrl?.startsWith("https://visionarypos.cloud/downloads/")) return pathOrUrl;
  if (pathOrUrl?.startsWith("/downloads/")) return `${API_BASE_URL}${pathOrUrl}`;
  return `${API_BASE_URL}/downloads/VISIONPOS-Cashier-Setup.exe`;
}

export function connectSyncStream(terminal: TerminalCredentials, onSync: () => void, onState?: (state: "connected" | "reconnecting") => void) {
  const controller = new AbortController();
  let stopped = false;
  let retryMs = 1000;

  async function wait(ms: number) {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function parseSseBlock(block: string) {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    return { event, data };
  }

  async function run() {
    while (!stopped && !controller.signal.aborted) {
      try {
        onState?.("reconnecting");
        const response = await fetch(`${API_BASE_URL}/api/sync/stream?t=${Date.now()}`, {
          headers: terminalHeaders(terminal),
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error(`stream_failed_${response.status}`);
        onState?.("connected");
        retryMs = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\n\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const parsed = parseSseBlock(block);
            if (parsed.event === "sync" || parsed.event === "connected") onSync();
          }
        }
      } catch (_) {
        if (stopped || controller.signal.aborted) break;
      }
      onState?.("reconnecting");
      await wait(retryMs);
      retryMs = Math.min(retryMs * 1.6, 15000);
    }
  }

  run();
  return () => {
    stopped = true;
    controller.abort();
  };
}

function uid(prefix: string) {
  const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
  return `${prefix}_${random}`;
}

function terminalHeaders(terminal: TerminalCredentials): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Terminal-UUID": terminal.uuid,
    "X-Terminal-Secret": terminal.terminalSecret
  };
}

async function jsonFetch<T>(path: string, init: RequestInit): Promise<T> {
  if (!API_BASE_URL.startsWith("https://")) throw new Error("HTTPS is required.");
  const headers: Record<string, string> = { "Cache-Control": "no-store", "Pragma": "no-cache" };
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

function numberFromPayload(payload: any, fields: string[], fallback = 0) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function productDedupeKey(product: Product) {
  const catalogId = product.barcodeCatalogId || "";
  if (catalogId) return `${product.branchId}|catalog:${catalogId}`;
  const code = product.sku || product.barcode || product.barcodes?.[0] || "";
  const size = product.size || "";
  return `${product.branchId}|${code ? "code:" + code.toLowerCase() : "name:" + product.name.toLowerCase() + "|" + size.toLowerCase()}`;
}

function preferProductRow(current: Product | undefined, candidate: Product) {
  if (!current) return candidate;
  const score = (product: Product) =>
    (product.priceCents > 0 ? 8 : 0) +
    (product.costCents > 0 ? 4 : 0) +
    (product.image ? 2 : 0) +
    (product.barcode ? 1 : 0);
  const currentScore = score(current);
  const candidateScore = score(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return Number(candidate.serverTs || 0) >= Number(current.serverTs || 0) ? candidate : current;
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
  const productIdsByKey = new Map<string, string[]>();
  const baseStockByKey = new Map<string, number>();
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
        cashierName: payload.cashierName || payload.cashier || "",
        customerName: payload.customerName || "",
        note: payload.note || "",
        totalCents: centsFromPayload(payload, ["totalCents", "total_cents"], moneyToCentsFromPayload(payload, ["total", "amount"])),
        paidCents: centsFromPayload(payload, ["paidCents", "paid_cents"], moneyToCentsFromPayload(payload, ["paid"])),
        carriedOver: Boolean(payload.carriedOver || payload.carried_over),
        status: payload.status || "",
        ts: Number(payload.ts || item.clientTs || 0),
        items: Array.isArray(payload.items) ? payload.items.map((line: any) => ({
          productId: line.productId || line.id || "",
          name: line.name || line.productName || "Product",
          qty: Number(line.qty || line.quantity || 0),
          priceCents: centsFromPayload(line, ["priceCents", "price_cents"], moneyToCentsFromPayload(line, ["price"]))
        })) : []
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
        size: payload.size || "",
        barcode: payload.barcode || "",
        barcodes: Array.isArray(payload.barcodes) ? payload.barcodes : [],
        barcodeCatalogId: payload.barcodeCatalogId || payload.barcode_catalog_id || null,
        category: payload.category || payload.categoryId || "Uncategorised",
        categoryId: payload.categoryId || payload.category || "",
        image: productDisplayImage({
          sku: payload.sku || "",
          barcode: payload.barcode || "",
          image: payload.image || payload.imageUrl || payload.image_url || payload.photo || ""
        }),
        priceCents: centsFromPayload(payload, ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"], moneyToCentsFromPayload(payload, ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"])),
        costCents: centsFromPayload(payload, ["costCents", "costPriceCents", "cost_price_cents", "buyingPriceCents"], moneyToCentsFromPayload(payload, ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"])),
        stockQty: numberFromPayload(payload, ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand"], 0),
        serverTs: Number(item.serverTs || item.updatedAt || 0)
      };
      const key = productDedupeKey(product);
      productIdsByKey.set(key, [...(productIdsByKey.get(key) || []), product.id]);
      baseStockByKey.set(key, (baseStockByKey.get(key) || 0) + product.stockQty);
      productDeduped.set(key, preferProductRow(productDeduped.get(key), product));
    }
  }

  return {
    branches,
    invoices: Array.from(invoiceRecords.values())
      .map((invoice) => ({ ...invoice, paidCents: Math.max(invoice.paidCents, paidByInvoice.get(invoice.id) || 0) }))
      .filter((invoice) => invoice.branchId === terminal.branchId)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)),
    products: Array.from(productDeduped.entries())
      .map(([key, product]) => ({
        ...product,
        stockQty: (baseStockByKey.get(key) || 0) + (productIdsByKey.get(key) || []).reduce((sum, id) => sum + (stockByProduct.get(id) || 0), 0)
      }))
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
    sku: data.product.sku || "",
    size: data.product.size || "",
    barcode,
    barcodes: Array.isArray(data.product.barcodes) ? data.product.barcodes : [],
    categoryId: data.product.categoryId,
    image: productDisplayImage({
      sku: data.product.sku || "",
      barcode,
      image: data.product.image || data.product.imageUrl || data.product.image_url || ""
    }),
    priceCents: centsFromPayload(data.product, ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"], moneyToCentsFromPayload(data.product, ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"])),
    costCents: centsFromPayload(data.product, ["costCents", "costPriceCents", "cost_price_cents", "buyingPriceCents"], moneyToCentsFromPayload(data.product, ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"])),
    stockQty: numberFromPayload(data.product, ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand"], 0)
  };
}

function assertSyncAccepted(
  result: { accepted?: string[]; rejected?: Array<{ id?: string; reason?: string; type?: string }> },
  events: Array<{ id: string; type: string }>
) {
  const accepted = new Set(result.accepted || []);
  const rejected = result.rejected || [];
  const rejectedDetails = rejected
    .map((item) => `${item.id || "unknown"}:${item.reason || "rejected"}`)
    .join(", ");
  const missing = events.filter((event) => !accepted.has(event.id));
  if (rejected.length || missing.length) {
    const missingDetails = missing.map((event) => `${event.id}:${event.type}`).join(", ");
    throw new Error(`sync_rejected ${[rejectedDetails, missingDetails].filter(Boolean).join(" ")}`.trim());
  }
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

  const result = await jsonFetch<{ accepted?: string[]; rejected?: Array<{ id?: string; reason?: string; type?: string }> }>("/api/sync/push", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ events })
  });
  assertSyncAccepted(result, events);
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
