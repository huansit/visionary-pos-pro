import { invoke } from "@tauri-apps/api/core";
import { productDisplayImage } from "./productImages";
import { businessDateValue } from "./businessTime";
import type { Account, Branch, BusinessDayPeriod, CashierJointDebt, ExpenseCategory, Invoice, MpesaLedger, Product, Receipt, StockTransferRequest, StockTransferRequestItem, TerminalCredentials } from "./types";

export const API_BASE_URL = "https://visionarypos.cloud";
declare const __APP_VERSION__: string;

export const APP_VERSION = __APP_VERSION__;

const RESET_EPOCH_KEY_PREFIX = "visionpos:cashier:reset-epoch:v1:";

class ApiRequestError extends Error {
  status: number;
  body: any;

  constructor(status: number, body: any) {
    super(body?.error || `request_failed_${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

type SyncPushResult = {
  accepted?: string[];
  rejected?: Array<{ id?: string; reason?: string; type?: string }>;
  resetEpoch?: string;
  invoiceNumbers?: Record<string, string>;
};

const TERMINAL_REGISTRATION_ERRORS = new Set([
  "terminal_not_authorized",
  "terminal_environment_mismatch",
  "invalid_or_missing_device_token",
  "unknown_terminal",
  "terminal_disabled",
  "terminal_revoked",
  "invalid_terminal_secret"
]);

export function isTerminalRegistrationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return [...TERMINAL_REGISTRATION_ERRORS].some((code) => message.includes(code));
}

export type SyncVersionChange = {
  version?: number;
  type?: string;
  event?: string;
  changedType?: string;
  branchId?: string;
  types?: string[];
  ts?: number;
  payload?: Record<string, unknown>;
  change?: Record<string, unknown>;
};

export function connectSyncStream(terminal: TerminalCredentials, onSync: (change?: SyncVersionChange) => void, onState?: (state: "connected" | "reconnecting") => void) {
  let stopped = false;
  let retryMs = 1200;
  let lastVersion = 0;

  async function wait(ms: number) {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function run() {
    while (!stopped) {
      try {
        const data = await jsonFetch<SyncVersionChange>(`/api/sync/version?t=${Date.now()}`, {
          method: "GET",
          headers: terminalHeaders(terminal)
        });
        const nextVersion = Number(data.version || 0);
        onState?.("connected");
        retryMs = 1000;
        if (!lastVersion) {
          lastVersion = nextVersion;
        } else if (nextVersion && nextVersion !== lastVersion) {
          lastVersion = nextVersion;
          onSync(data);
        }
        await wait(3000);
      } catch (_) {
        if (stopped) break;
        onState?.("reconnecting");
        await wait(retryMs);
        retryMs = Math.min(retryMs * 1.6, 15000);
      }
    }
  }

  run();
  return () => {
    stopped = true;
  };
}

function uid(prefix: string) {
  const random = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
  return `${prefix}_${random}`;
}

function firstArray(...values: unknown[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function eventQuantity(payload: Record<string, any>) {
  for (const value of [payload.qty, payload.quantity, payload.receivedQty, payload.received_qty, payload.units, payload.count]) {
    const qty = Number(value);
    if (Number.isFinite(qty)) return qty;
  }
  return 0;
}

function addStock(stockByProduct: Map<string, number>, productId: unknown, qty: unknown) {
  if (!productId) return;
  const quantity = Number(qty);
  if (!Number.isFinite(quantity) || quantity === 0) return;
  const id = String(productId);
  stockByProduct.set(id, (stockByProduct.get(id) || 0) + quantity);
}

function terminalHeaders(terminal: TerminalCredentials): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Terminal-UUID": terminal.uuid,
    "X-Terminal-Secret": terminal.terminalSecret,
    "X-VISIONPOS-App-Version": APP_VERSION
  };
}

function resetEpochKey(terminal: TerminalCredentials) {
  return `${RESET_EPOCH_KEY_PREFIX}${terminal.uuid}`;
}

function readResetEpoch(terminal: TerminalCredentials) {
  try {
    return window.localStorage.getItem(resetEpochKey(terminal)) || "";
  } catch (_) {
    return "";
  }
}

function writeResetEpoch(terminal: TerminalCredentials, resetEpoch: unknown) {
  const value = String(resetEpoch || "");
  if (!value) return;
  try {
    window.localStorage.setItem(resetEpochKey(terminal), value);
  } catch (_) {
    // A blocked storage API must not prevent an online cashier operation.
  }
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

  if (!response.ok) throw new ApiRequestError(response.status, response.body);
  return response.body as T;
}

async function pushSyncEvents(
  terminal: TerminalCredentials,
  events: Array<{ id: string; type: string; [key: string]: any }>
): Promise<SyncPushResult> {
  const submit = () => jsonFetch<SyncPushResult>("/api/sync/push", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ events, resetEpoch: readResetEpoch(terminal) })
  });

  try {
    const result = await submit();
    writeResetEpoch(terminal, result.resetEpoch);
    return result;
  } catch (error) {
    const isResetMismatch = error instanceof ApiRequestError
      && error.status === 409
      && error.message === "operational_reset_required"
      && error.body?.resetEpoch;
    if (!isResetMismatch) throw error;

    // Accept the server's current reset generation, then retry only this
    // in-memory cashier action once. Historical operations are never replayed.
    writeResetEpoch(terminal, error.body.resetEpoch);
    const result = await submit();
    writeResetEpoch(terminal, result.resetEpoch);
    return result;
  }
}

function preciseCentValue(raw: any, fractionDigits = 6) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** fractionDigits;
  return Math.round(Math.max(0, value) * factor) / factor;
}

function centsFromPayload(payload: any, fields: string[], fallback = 0, preserveFraction = false) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    return preserveFraction ? preciseCentValue(value) ?? fallback : Math.round(value);
  }
  return fallback;
}

function moneyToCentsFromPayload(payload: any, fields: string[], fallback = 0, preserveFraction = false) {
  for (const field of fields) {
    const raw = payload?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    return preserveFraction ? preciseCentValue(value * 100) ?? fallback : Math.round(value * 100);
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

const PRODUCT_PRICE_CENT_FIELDS = ["priceCents", "sellingPriceCents", "selling_price_cents", "sellPriceCents"];
const PRODUCT_PRICE_MONEY_FIELDS = ["sellingPrice", "selling_price", "sellPrice", "sell_price", "price", "retailPrice"];
const PRODUCT_COST_CENT_FIELDS = ["costCents", "costPriceCents", "cost_price_cents", "buyingPriceCents"];
const PRODUCT_COST_MONEY_FIELDS = ["costPrice", "cost_price", "buyingPrice", "buying_price", "cost"];
const PRODUCT_STOCK_FIELDS = ["stockQty", "stock_qty", "stock", "_stock", "qty", "quantity", "onHand", "currentStock", "current_stock"];
const BRANCH_PRICE_MAP_FIELDS = ["branchPrices", "priceByBranch", "sellingPrices", "sellingPriceByBranch", "branchSellingPrices"];
const BRANCH_COST_MAP_FIELDS = ["branchCosts", "costByBranch", "movingAverageCostByBranch", "averageCostByBranch", "branchMovingAverageCosts"];
const BRANCH_STOCK_MAP_FIELDS = ["branchStock", "stockByBranch", "stockQtyByBranch", "branchInventory"];

function valueFromObject(raw: any, fields: string[]) {
  if (!raw || typeof raw !== "object") return undefined;
  for (const field of fields) {
    const value = raw[field];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function branchMappedValue(payload: any, mapFields: string[], branchId: string, valueFields: string[]) {
  const branchKeys = [branchId, branchId.toLowerCase(), branchId.toUpperCase()].filter(Boolean);
  for (const field of mapFields) {
    const map = payload?.[field];
    if (!map || typeof map !== "object") continue;
    for (const key of branchKeys) {
      const raw = map[key];
      if (raw === undefined || raw === null || raw === "") continue;
      if (typeof raw === "object") {
        const nested = valueFromObject(raw, valueFields);
        if (nested !== undefined) return nested;
      }
      return raw;
    }
  }
  return undefined;
}

function centsFromAny(raw: any, fields = PRODUCT_PRICE_CENT_FIELDS, preserveFraction = false): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") {
    return centsFromAny(valueFromObject(raw, fields), fields, preserveFraction);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return preserveFraction ? preciseCentValue(value) : Math.round(value);
}

function moneyCentsFromAny(raw: any, fields = PRODUCT_PRICE_MONEY_FIELDS, preserveFraction = false): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") {
    return moneyCentsFromAny(valueFromObject(raw, fields), fields, preserveFraction);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return preserveFraction ? preciseCentValue(value * 100) : Math.round(value * 100);
}

function numberFromAny(raw: any): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object") {
    return numberFromAny(valueFromObject(raw, PRODUCT_STOCK_FIELDS));
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function normalizeProductForBranch(source: any, branchId: string): Product {
  const payload = { ...(source?.payload || {}), ...(source || {}) };
  const sku = String(payload.sku || "").trim();
  const barcode = String(payload.barcode || "").trim();
  const branchPrice =
    centsFromAny(branchMappedValue(payload, BRANCH_PRICE_MAP_FIELDS, branchId, PRODUCT_PRICE_CENT_FIELDS), PRODUCT_PRICE_CENT_FIELDS) ??
    moneyCentsFromAny(branchMappedValue(payload, BRANCH_PRICE_MAP_FIELDS, branchId, PRODUCT_PRICE_MONEY_FIELDS), PRODUCT_PRICE_MONEY_FIELDS);
  const branchCost =
    centsFromAny(branchMappedValue(payload, BRANCH_COST_MAP_FIELDS, branchId, PRODUCT_COST_CENT_FIELDS), PRODUCT_COST_CENT_FIELDS, true) ??
    moneyCentsFromAny(branchMappedValue(payload, BRANCH_COST_MAP_FIELDS, branchId, PRODUCT_COST_MONEY_FIELDS), PRODUCT_COST_MONEY_FIELDS, true);
  const branchStock = numberFromAny(branchMappedValue(payload, BRANCH_STOCK_MAP_FIELDS, branchId, PRODUCT_STOCK_FIELDS));
  const directPrice = centsFromPayload(
    payload,
    PRODUCT_PRICE_CENT_FIELDS,
    moneyToCentsFromPayload(payload, PRODUCT_PRICE_MONEY_FIELDS)
  );
  const directCost = centsFromPayload(
    payload,
    PRODUCT_COST_CENT_FIELDS,
    moneyToCentsFromPayload(payload, PRODUCT_COST_MONEY_FIELDS, 0, true),
    true
  );
  const directStock = numberFromPayload(payload, PRODUCT_STOCK_FIELDS, 0);

  return {
    id: String(payload.id || source?.id || (sku ? `product_${sku}` : uid("product"))),
    branchId: String(payload.branchId || payload.branch_id || branchId),
    name: String(payload.name || payload.productName || payload.product_name || payload.title || "Unnamed product"),
    sku,
    size: String(payload.size || payload.unit || ""),
    barcode,
    barcodes: Array.isArray(payload.barcodes) ? payload.barcodes : barcode ? [barcode] : [],
    barcodeCatalogId: payload.barcodeCatalogId || payload.barcode_catalog_id || null,
    category: payload.category || payload.categoryId || "Uncategorised",
    categoryId: payload.categoryId || payload.category || "",
    status: payload.enabled === false || payload.active === false ? "disabled" : String(payload.status || "active"),
    image: productDisplayImage({
      sku,
      barcode,
      image: payload.image || payload.imageUrl || payload.image_url || payload.photo || ""
    }),
    priceCents: branchPrice ?? directPrice,
    costCents: branchCost ?? directCost,
    stockQty: branchStock ?? directStock,
    serverTs: Number(payload.serverTs || payload.updatedAt || source?.serverTs || source?.updatedAt || 0)
  };
}

function productIsEnabled(product: Product) {
  return !["disabled", "inactive", "deleted"].includes(String(product.status || "active").trim().toLowerCase());
}

function productDedupeKey(product: Product) {
  const sku = String(product.sku || "").trim().toLowerCase();
  if (sku) return `sku:${sku}`;
  const catalogId = product.barcodeCatalogId || "";
  if (catalogId) return `catalog:${catalogId}`;
  const code = product.barcode || product.barcodes?.[0] || "";
  const size = product.size || "";
  return code ? `code:${code.toLowerCase()}` : `name:${product.name.toLowerCase()}|${size.toLowerCase()}`;
}

function preferProductRow(current: Product | undefined, candidate: Product) {
  if (!current) return candidate;
  const currentTs = Number(current.serverTs || 0);
  const candidateTs = Number(candidate.serverTs || 0);
  if (candidateTs !== currentTs) return candidateTs > currentTs ? candidate : current;
  const score = (product: Product) =>
    (product.priceCents > 0 ? 8 : 0) +
    (product.costCents > 0 ? 4 : 0) +
    (product.image ? 2 : 0) +
    (product.barcode ? 1 : 0);
  const currentScore = score(current);
  const candidateScore = score(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return String(candidate.id || "").localeCompare(String(current.id || "")) >= 0 ? candidate : current;
}

function isMeaningfulProductName(value?: string) {
  const name = String(value || "").trim();
  return Boolean(name && name.toLowerCase() !== "unnamed product");
}

function productNameScore(product: Product) {
  const name = String(product.name || "").trim();
  if (!isMeaningfulProductName(name)) return 0;
  const normalizedName = name.toLowerCase();
  const identifiers = [product.sku, product.barcode, ...(product.barcodes || [])]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (identifiers.includes(normalizedName)) return 1;
  return 20 + Math.min(name.length, 60);
}

function mergeProductGroup(rows: Product[]): Product | null {
  const preferred = rows.reduce<Product | undefined>((current, row) => preferProductRow(current, row), undefined);
  if (!preferred) return null;
  const detailRows = [...rows].sort((a, b) => {
    const score = (product: Product) =>
      (isMeaningfulProductName(product.name) ? 32 : 0) +
      (product.sku ? 16 : 0) +
      (product.barcode ? 8 : 0) +
      (product.category && product.category !== "Uncategorised" ? 4 : 0) +
      (product.image ? 2 : 0) +
      (product.size ? 1 : 0);
    return score(b) - score(a) || Number(b.serverTs || 0) - Number(a.serverTs || 0);
  });
  const details = detailRows[0] || preferred;
  const nameSource = [...rows].sort((a, b) =>
    productNameScore(b) - productNameScore(a) || Number(b.serverTs || 0) - Number(a.serverTs || 0)
  )[0] || details;
  const barcodes: string[] = [
    ...new Set(
      rows
        .flatMap((row) => [row.barcode, ...(row.barcodes || [])])
        .map((barcode) => String(barcode || "").trim())
        .filter((barcode) => Boolean(barcode))
    )
  ];
  return {
    ...preferred,
    name: nameSource.name,
    sku: preferred.sku || details.sku,
    size: preferred.size || details.size,
    barcode: preferred.barcode || details.barcode || barcodes[0] || "",
    barcodes,
    barcodeCatalogId: preferred.barcodeCatalogId || details.barcodeCatalogId,
    category: preferred.category && preferred.category !== "Uncategorised" ? preferred.category : details.category,
    categoryId: preferred.categoryId || details.categoryId,
    image: preferred.image || details.image
  } satisfies Product;
}

export function dedupeCatalogProducts(products: Product[]): Product[] {
  const groups = new Map<string, Product[]>();
  for (const product of products || []) {
    const key = productDedupeKey(product);
    groups.set(key, [...(groups.get(key) || []), product]);
  }
  const merged: Product[] = [];
  for (const rows of groups.values()) {
    const product = mergeProductGroup(rows);
    if (product && productIsEnabled(product)) merged.push(product);
  }
  return merged.sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.sku || "").localeCompare(String(b.sku || ""))
  );
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

type FingerprintCapture = {
  template: string;
  deviceSerial: string;
  quality: number | string;
};

type FingerprintTemplate = {
  userId: string;
  template: string;
  account: Account;
};

const SECUGEN_TEMPLATE_FORMAT = "ISO";
const SECUGEN_MATCH_THRESHOLD = 80;
const FINGERPRINT_TEMPLATE_CACHE_MS = 5 * 60 * 1000;
const FINGERPRINT_LOGIN_CAPTURE_TIMEOUT_MS = 6000;
const FINGERPRINT_CHECKOUT_CAPTURE_TIMEOUT_MS = 3500;
const fingerprintTemplateCache = new Map<string, { expiresAt: number; templates: FingerprintTemplate[] }>();

function secugenErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("secugen_webapi_not_installed")) {
    return "SecuGen WebAPI Client is not installed on this terminal. Install it once, then VisionPOS will start it automatically.";
  }
  if (
    message.includes("secugen_webapi_start_failed")
    || message.includes("secugen_webapi_start_timeout")
    || message.includes("secugen_webapi_restart_failed")
  ) {
    return "VisionPOS could not start the installed SecuGen WebAPI Client. Restart Windows once, then try again.";
  }
  if (message.includes("secugen_webapi_unreachable")) {
    return "SecuGen WebAPI Client could not be reached. VisionPOS tried to start it automatically; restart Windows and try again.";
  }
  if (message.includes("secugen_device_busy") || message.includes("secugen_error_59")) {
    return "Fingerprint reader is still in use after automatic recovery. Close any other fingerprint app, then try again.";
  }
  if (message.includes("capture_timeout")) return "Fingerprint capture timed out. Try again when the finger is ready.";
  if (message.includes("origin_required")) return "Fingerprint service rejected the application request. Restart VisionPOS and try again.";
  if (message.includes("not_connected")) return "Fingerprint reader not detected. Connect the SecuGen reader and try again.";
  if (message.includes("low_quality")) return "Fingerprint quality was too low. Place the enrolled finger flat and scan again.";
  if (message.includes("not_enrolled")) return "No fingerprint is enrolled for this cashier.";
  if (message.includes("not_recognized")) return "Fingerprint not recognized. Use an enrolled finger and try again.";
  return message || "Fingerprint verification failed.";
}

function secugenErrorCode(data: any) {
  const value = Number(data?.ErrorCode ?? data?.errorCode ?? data?.error_code ?? 0);
  return Number.isFinite(value) ? value : 0;
}

async function secugenRequest(path: "/SGIFPCapture" | "/SGIMatchScore", params: Record<string, string>) {
  return invoke<Record<string, any>>("secugen_request", { req: { path, params } });
}

function fingerprintPerf(label: string, startedAt: number, details: Record<string, unknown> = {}) {
  console.info("[visionpos:fingerprint]", label, { ms: Math.round(performance.now() - startedAt), ...details });
}

async function captureFingerprint(timeoutMs = FINGERPRINT_LOGIN_CAPTURE_TIMEOUT_MS): Promise<FingerprintCapture> {
  const startedAt = performance.now();
  try {
    const data = await secugenRequest("/SGIFPCapture", {
      Timeout: String(timeoutMs),
      Quality: "50",
      FakeDetection: "0",
      licstr: "",
      TemplateFormat: SECUGEN_TEMPLATE_FORMAT,
      templateFormat: SECUGEN_TEMPLATE_FORMAT
    });
    const code = secugenErrorCode(data);
    if (code !== 0) {
      if (code === 54) throw new Error("capture_timeout");
      if (code === 10004) throw new Error("origin_required");
      if ([55, 56, 60, 61].includes(code)) throw new Error("not_connected");
      if ([57, 101, 105].includes(code)) throw new Error("low_quality");
      throw new Error(`secugen_error_${code}`);
    }
    const template = String(data.TemplateBase64 || data.templateBase64 || data.Template || data.template || "");
    if (!template) throw new Error("low_quality");
    fingerprintPerf("capture", startedAt, { timeoutMs, quality: data.ImageQuality || data.Quality || "" });
    return {
      template,
      deviceSerial: String(data.SerialNumber || data.DeviceSerial || data.deviceSerial || data.DeviceID || ""),
      quality: data.ImageQuality || data.Quality || ""
    };
  } catch (error) {
    throw new Error(secugenErrorMessage(error));
  }
}

async function fingerprintScore(templateA: string, templateB: string) {
  const startedAt = performance.now();
  const data = await secugenRequest("/SGIMatchScore", {
    template1: templateA,
    template2: templateB,
    Template1: templateA,
    Template2: templateB,
    templateFormat: SECUGEN_TEMPLATE_FORMAT
  });
  const code = secugenErrorCode(data);
  if (code !== 0) throw new Error(`secugen_match_error_${code}`);
  const score = Number(data.MatchingScore ?? data.Score ?? data.score ?? data.matchScore ?? 0);
  fingerprintPerf("match-score", startedAt, { score: Number.isFinite(score) ? score : 0 });
  return Number.isFinite(score) ? score : 0;
}

function fingerprintTemplateCacheKey(terminal: TerminalCredentials, preferredUserId?: string) {
  return [
    terminal.uuid,
    terminal.branchId,
    preferredUserId || "all"
  ].join(":");
}

export function clearFingerprintTemplateCache() {
  fingerprintTemplateCache.clear();
}

export async function preloadCashierFingerprintTemplate(terminal: TerminalCredentials, accountId: string) {
  await fingerprintTemplates(terminal, accountId).catch(() => undefined);
}

async function fingerprintTemplates(terminal: TerminalCredentials, preferredUserId?: string, forceRefresh = false): Promise<FingerprintTemplate[]> {
  const startedAt = performance.now();
  const cacheKey = fingerprintTemplateCacheKey(terminal, preferredUserId);
  const cached = fingerprintTemplateCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    fingerprintPerf("templates-cache-hit", startedAt, { count: cached.templates.length, preferredUserId: preferredUserId || null });
    return cached.templates;
  }

  const data = await jsonFetch<{ templates?: FingerprintTemplate[] }>("/api/auth/fingerprints/templates", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ branchId: terminal.branchId, userId: preferredUserId || null })
  });
  const templates = (Array.isArray(data.templates) ? data.templates : [])
    .filter((entry) => String(entry?.account?.kind || "").toLowerCase() === "cashier");
  fingerprintTemplateCache.set(cacheKey, {
    expiresAt: Date.now() + FINGERPRINT_TEMPLATE_CACHE_MS,
    templates
  });
  fingerprintPerf("templates-fetch", startedAt, { count: templates.length, preferredUserId: preferredUserId || null, forceRefresh });
  return templates;
}

async function recordFingerprintFailure(
  terminal: TerminalCredentials,
  capture: FingerprintCapture,
  reason: string,
  userId?: string
) {
  await jsonFetch("/api/auth/fingerprints/failed", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({
      userId: userId || null,
      branchId: terminal.branchId,
      deviceSerial: capture.deviceSerial,
      reason
    })
  }).catch(() => undefined);
}

async function matchFingerprint(
  terminal: TerminalCredentials,
  preferredUserId?: string,
  options: { fallbackToAll?: boolean; captureTimeoutMs?: number; retryFresh?: boolean } = {}
): Promise<{ capture: FingerprintCapture; match: FingerprintTemplate }> {
  const startedAt = performance.now();
  const [capture, templates] = await Promise.all([
    captureFingerprint(options.captureTimeoutMs),
    fingerprintTemplates(terminal, preferredUserId)
  ]);
  if (!templates.length) {
    if (preferredUserId && options.fallbackToAll) {
      const fallbackTemplates = await fingerprintTemplates(terminal, undefined);
      const fallbackMatch = await bestFingerprintMatch(capture.template, fallbackTemplates);
      if (fallbackMatch) {
        fingerprintPerf("match-complete-after-empty-preference", startedAt, {
          userId: fallbackMatch.userId,
          preferredUserId
        });
        return { capture, match: fallbackMatch };
      }
      if (fallbackTemplates.length) {
        await recordFingerprintFailure(terminal, capture, "fingerprint_not_recognized", preferredUserId);
        throw new Error(secugenErrorMessage(new Error("not_recognized")));
      }
    }
    await recordFingerprintFailure(terminal, capture, "fingerprint_not_enrolled", preferredUserId);
    throw new Error(secugenErrorMessage(new Error("not_enrolled")));
  }

  const match = await bestFingerprintMatch(capture.template, templates);
  if (match) {
    fingerprintPerf("match-complete", startedAt, { userId: match.userId, preferredUserId: preferredUserId || null });
    return { capture, match };
  }

  if (options.retryFresh !== false) {
    const freshTemplates = await fingerprintTemplates(terminal, preferredUserId, true);
    const freshMatch = await bestFingerprintMatch(capture.template, freshTemplates);
    if (freshMatch) {
      fingerprintPerf("match-complete-after-refresh", startedAt, { userId: freshMatch.userId, preferredUserId: preferredUserId || null });
      return { capture, match: freshMatch };
    }
  }

  if (preferredUserId && options.fallbackToAll) {
    const fallbackTemplates = await fingerprintTemplates(terminal, undefined, true);
    const fallbackMatch = await bestFingerprintMatch(capture.template, fallbackTemplates);
    if (fallbackMatch) {
      fingerprintPerf("match-complete-after-fallback", startedAt, { userId: fallbackMatch.userId, preferredUserId });
      return { capture, match: fallbackMatch };
    }
  }

  await recordFingerprintFailure(terminal, capture, "fingerprint_not_recognized", preferredUserId);
  throw new Error(secugenErrorMessage(new Error("not_recognized")));
}

async function bestFingerprintMatch(capturedTemplate: string, templates: FingerprintTemplate[]) {
  let best: FingerprintTemplate | null = null;
  let bestScore = -1;
  for (const entry of templates) {
    const score = await fingerprintScore(capturedTemplate, entry.template);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
    if (score >= SECUGEN_MATCH_THRESHOLD) return entry;
  }
  return bestScore >= SECUGEN_MATCH_THRESHOLD ? best : null;
}

export async function loginCashierWithFingerprint(terminal: TerminalCredentials, preferredUserId?: string): Promise<{
  account: Account;
  sessionToken: string;
}> {
  const { capture, match } = await matchFingerprint(terminal, preferredUserId, {
    fallbackToAll: true,
    captureTimeoutMs: FINGERPRINT_LOGIN_CAPTURE_TIMEOUT_MS,
    retryFresh: true
  });
  return issueFingerprintSession(terminal, match.userId, capture.deviceSerial);
}

function issueFingerprintSession(terminal: TerminalCredentials, userId: string, deviceSerial: string): Promise<{
  account: Account;
  sessionToken: string;
}> {
  return jsonFetch("/api/auth/fingerprints/login", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({
      userId,
      branchId: terminal.branchId,
      deviceSerial,
      deviceName: terminal.terminalName
    })
  });
}

export async function verifyCashierFingerprint(
  terminal: TerminalCredentials,
  account: Account,
  sessionToken: string
): Promise<{ renewedSessionToken?: string; account?: Account }> {
  const { capture, match } = await matchFingerprint(terminal, account.id, {
    captureTimeoutMs: FINGERPRINT_CHECKOUT_CAPTURE_TIMEOUT_MS,
    retryFresh: false
  });
  try {
    await jsonFetch("/api/auth/fingerprints/checkout", {
      method: "POST",
      headers: terminalHeaders(terminal),
      body: JSON.stringify({
        sessionToken,
        userId: account.id,
        branchId: terminal.branchId,
        deviceSerial: capture.deviceSerial
      })
    });
    return {};
  } catch (error) {
    const sessionExpired = error instanceof ApiRequestError
      && error.status === 401
      && error.message === "invalid_session";
    if (!sessionExpired) throw error;

    // The finger already matched this cashier locally. Reuse that proof to
    // recover an expired overnight session without requiring a second scan.
    const renewed = await issueFingerprintSession(terminal, match.userId, capture.deviceSerial);
    if (renewed.account.id !== account.id) throw new Error("fingerprint_account_mismatch");
    return { renewedSessionToken: renewed.sessionToken, account: renewed.account };
  }
}

export async function verifyCheckoutWithSupervisorPin(
  terminal: TerminalCredentials,
  account: Account,
  sessionToken: string,
  pin: string
): Promise<{ supervisor: { id: string; name: string; role: string } }> {
  return jsonFetch("/api/auth/verify-supervisor-pin", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({
      sessionToken,
      cashierAccountId: account.id,
      pin
    })
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

export async function listMpesaTransactions(
  sessionToken: string,
  branchId: string,
  filters: {
    search?: string;
    status?: string;
    from?: string;
    to?: string;
    branchStarts?: Record<string, string>;
    branchPeriods?: Record<string, { from: string; to: string }>;
    sort?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {}
): Promise<MpesaLedger> {
  const params = new URLSearchParams({
    branchId,
    search: String(filters.search || "").trim(),
    status: filters.status || "all",
    sort: filters.sort || "desc",
    limit: String(filters.limit || 50),
    offset: String(filters.offset || 0)
  });
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.branchStarts && Object.keys(filters.branchStarts).length) params.set("branchStarts", JSON.stringify(filters.branchStarts));
  if (filters.branchPeriods && Object.keys(filters.branchPeriods).length) params.set("branchPeriods", JSON.stringify(filters.branchPeriods));
  return jsonFetch(`/api/integrations/kopokopo/transactions?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Session-Token": sessionToken
    }
  });
}

export async function pullCatalog(terminal: TerminalCredentials): Promise<{
  branches: Branch[];
  products: Product[];
  invoices: Invoice[];
  cashierJointDebts: CashierJointDebt[];
  stockTransferRequests: StockTransferRequest[];
  expenseCategories: ExpenseCategory[];
  businessDays: BusinessDayPeriod[];
  dayClosedAt: number | null;
}> {
  let cursor = 0;
  let hasMore = true;
  const events: Array<any> = [];
  let serverCatalogProducts: Product[] | null = null;
  let serverBusinessDays: BusinessDayPeriod[] = [];
  let catalogDayClosedAt: number | null = null;
  let carriedOverInvoiceIds = new Set<string>();

  try {
    const catalog = await jsonFetch<{
      products?: Product[];
      businessDays?: BusinessDayPeriod[];
      dayClosedAt?: number | null;
      carriedOverInvoiceIds?: string[];
      resetEpoch?: string;
    }>(`/api/sync/catalog?t=${Date.now()}`, {
      method: "GET",
      headers: terminalHeaders(terminal)
    });
    writeResetEpoch(terminal, catalog.resetEpoch);
    const closeCandidate = Number(catalog.dayClosedAt || 0);
    catalogDayClosedAt = Number.isFinite(closeCandidate) && closeCandidate > 0 ? closeCandidate : null;
    carriedOverInvoiceIds = new Set(
      (Array.isArray(catalog.carriedOverInvoiceIds) ? catalog.carriedOverInvoiceIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    if (Array.isArray(catalog.products)) {
      serverCatalogProducts = dedupeCatalogProducts(
        catalog.products.map((product) => normalizeProductForBranch(product, terminal.branchId))
      );
    }
    if (Array.isArray(catalog.businessDays)) {
      serverBusinessDays = catalog.businessDays
        .map((period) => ({
          id: String(period.id || ""),
          branchId: String(period.branchId || terminal.branchId),
          businessDate: String(period.businessDate || ""),
          startedAt: Number(period.startedAt || 0),
          endedAt: Number(period.endedAt || 0),
          closedAt: Number(period.closedAt || period.endedAt || 0)
        }))
        .filter((period) => period.branchId === terminal.branchId && period.startedAt > 0 && period.endedAt > period.startedAt);
    }
  } catch (error) {
    console.warn("[visionpos] normalized catalog unavailable; using sync stream fallback", error);
  }

  while (hasMore) {
    const data = await jsonFetch<{ events: Array<any>; cursor?: number; hasMore?: boolean; resetEpoch?: string }>(`/api/sync/pull?since=${cursor}&limit=2000`, {
      method: "GET",
      headers: terminalHeaders(terminal)
    });
    writeResetEpoch(terminal, data.resetEpoch);
    events.push(...(data.events || []));
    hasMore = Boolean(data.hasMore && data.cursor && data.cursor !== cursor);
    cursor = Number(data.cursor || cursor);
  }

  const branchRecords = new Map<string, any>();
  const expenseCategoryRecords = new Map<string, any>();
  const productRecords = new Map<string, any>();
  const productGroups = new Map<string, Product[]>();
  const productIdsByKey = new Map<string, string[]>();
  const baseStockByKey = new Map<string, number>();
  const invoiceRecords = new Map<string, Invoice>();
  const invoiceNotes = new Map<string, { note: string; ts: number }>();
  const invoiceVoidRequests = new Map<string, { id: string; reason: string; ts: number }>();
  const invoiceVoidDecisions = new Map<string, { requestId: string; decision: "approved" | "rejected"; reason: string; ts: number }>();
  const cashierJointDebtRecords = new Map<string, CashierJointDebt>();
  const cashierJointDebtPaidCents = new Map<string, number>();
  const stockTransferRequestRecords = new Map<string, StockTransferRequest>();
  const stockTransferDecisions = new Map<string, { decision: "approved" | "rejected"; reason: string; transferNumber?: string; decidedAt: number }>();
  const businessDayRecords = new Map<string, BusinessDayPeriod>();
  serverBusinessDays.forEach((period) => businessDayRecords.set(period.id, period));
  const paidByInvoice = new Map<string, number>();
  const stockByProduct = new Map<string, number>();
  let dayClosedAt: number | null = catalogDayClosedAt;

  for (const item of events) {
    const normalizedEventType = String(item.type || "").replace(/[_-]/g, "").toLowerCase();
    if (normalizedEventType === "expensecategory") {
      if (item.deleted) {
        expenseCategoryRecords.delete(item.id);
      } else {
        const previous = expenseCategoryRecords.get(item.id);
        if (!previous || Number(item.serverTs || 0) >= Number(previous.serverTs || 0)) {
          expenseCategoryRecords.set(item.id, item);
        }
      }
      continue;
    }
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
    if (normalizedEventType === "endofday" || normalizedEventType === "dayclosed") {
      const payload = item.payload || {};
      const branchId = String(payload.branchId || item.branchId || "");
      if (branchId === terminal.branchId) {
        const closedAt = Number(
          payload.periodEndedAt
          || payload.closedAt
          || payload.ts
          || item.clientTs
          || item.serverTs
          || 0
        );
        if (Number.isFinite(closedAt) && closedAt > 0) {
          dayClosedAt = Math.max(dayClosedAt || 0, closedAt);
        }
        const startedAt = Number(payload.periodStartedAt || 0);
        if (Number.isFinite(startedAt) && startedAt > 0 && closedAt > startedAt) {
          const id = String(item.id || `${branchId}:${startedAt}:${closedAt}`);
          businessDayRecords.set(id, {
            id,
            branchId,
            businessDate: /^\d{4}-\d{2}-\d{2}$/.test(String(payload.businessDate || ""))
              ? String(payload.businessDate)
              : businessDateValue(closedAt),
            startedAt,
            endedAt: closedAt,
            closedAt: Number(payload.closedAt || closedAt)
          });
        }
      }
    }
    if (item.type === "setting" || item.type === "settings") {
      const payload = item.payload || {};
      const closedAt = Number(payload.lastEndDayByBranch?.[terminal.branchId] || 0);
      if (Number.isFinite(closedAt) && closedAt > 0) {
        dayClosedAt = Math.max(dayClosedAt || 0, closedAt);
      }
    }
    if (item.type === "invoiceNote") {
      const payload = item.payload || {};
      const invoiceId = payload.invoiceId || payload.id;
      if (invoiceId) {
        const ts = Number(payload.ts || item.serverTs || item.clientTs || 0);
        const previous = invoiceNotes.get(invoiceId);
        if (!previous || ts >= previous.ts) {
          invoiceNotes.set(invoiceId, { note: String(payload.note || ""), ts });
        }
      }
    }
    if (item.type === "invoiceVoidRequest") {
      const payload = item.payload || {};
      const invoiceId = String(payload.invoiceId || "");
      if (invoiceId) {
        const ts = Number(payload.requestedAt || payload.ts || item.serverTs || item.clientTs || 0);
        const previous = invoiceVoidRequests.get(invoiceId);
        if (!previous || ts >= previous.ts) {
          invoiceVoidRequests.set(invoiceId, { id: item.id, reason: String(payload.reason || ""), ts });
        }
      }
    }
    if (item.type === "invoiceVoidDecision") {
      const payload = item.payload || {};
      const invoiceId = String(payload.invoiceId || "");
      const decision = String(payload.decision || "").toLowerCase();
      if (invoiceId && (decision === "approved" || decision === "rejected")) {
        const ts = Number(payload.decidedAt || payload.ts || item.serverTs || item.clientTs || 0);
        const previous = invoiceVoidDecisions.get(invoiceId);
        if (!previous || ts >= previous.ts) {
          invoiceVoidDecisions.set(invoiceId, {
            requestId: String(payload.requestId || ""),
            decision,
            reason: String(payload.reason || payload.decisionReason || ""),
            ts
          });
        }
      }
    }
    if (item.type === "cashierJointDebt") {
      if (item.deleted) {
        cashierJointDebtRecords.delete(item.id);
      } else {
        const payload = item.payload || {};
        const debt: CashierJointDebt = {
          id: String(item.id || payload.id || ""),
          branchId: String(payload.branchId || item.branchId || ""),
          stockCountSessionId: String(payload.stockCountSessionId || "") || undefined,
          stockCountCode: String(payload.stockCountCode || payload.code || item.id || "Stock count"),
          status: String(payload.status || "open"),
          shortageUnits: Number(payload.shortageUnits || 0),
          totalCents: Number(payload.totalCents || 0),
          cashierCount: Number(payload.cashierCount || 0),
          items: Array.isArray(payload.items) ? payload.items.map((entry: any) => ({
            productId: String(entry.productId || ""),
            productName: String(entry.productName || entry.name || "Product"),
            sku: String(entry.sku || ""),
            missingQty: Number(entry.missingQty || 0),
            unitCostCents: Number(entry.unitCostCents || 0),
            amountCents: Number(entry.amountCents || 0)
          })) : [],
          shares: Array.isArray(payload.shares) ? payload.shares.map((share: any) => ({
            cashierId: String(share.cashierId || ""),
            cashierName: String(share.cashierName || "Cashier"),
            amountCents: Number(share.amountCents || 0),
            paidCents: Number(share.paidCents || 0)
          })) : [],
          source: String(payload.source || "stock_count"),
          ts: Number(payload.ts || item.clientTs || item.serverTs || 0)
        };
        if (debt.id && debt.branchId === terminal.branchId) cashierJointDebtRecords.set(debt.id, debt);
      }
    }
    if (item.type === "cashierJointDebtPayment") {
      const payload = item.payload || {};
      const debtId = String(payload.debtId || "");
      const cashierId = String(payload.cashierId || "");
      const status = String(payload.status || "captured").toLowerCase();
      const amountCents = Math.max(0, centsFromPayload(payload, ["amountCents", "amount_cents"], moneyToCentsFromPayload(payload, ["amount"])));
      if (debtId && cashierId && status === "captured" && amountCents > 0) {
        const key = `${debtId}:${cashierId}`;
        cashierJointDebtPaidCents.set(key, (cashierJointDebtPaidCents.get(key) || 0) + amountCents);
      }
    }
    if (item.type === "stockTransferRequest") {
      const payload = item.payload || {};
      const requestId = String(item.id || payload.id || "").trim();
      const fromBranchId = String(payload.fromBranchId || payload.branchId || item.branchId || "").trim();
      const toBranchId = String(payload.toBranchId || "").trim();
      const requestItems: StockTransferRequestItem[] = (Array.isArray(payload.items) ? payload.items : [])
        .map((entry: any) => ({
          productId: String(entry.productId || "").trim(),
          productName: String(entry.productName || entry.name || "Product").trim() || "Product",
          sku: String(entry.sku || "").trim(),
          qty: Math.max(0, Math.floor(Number(entry.qty || entry.quantity || 0)))
        }))
        .filter((entry: StockTransferRequestItem) => entry.productId && entry.qty > 0);
      if (requestId && fromBranchId && toBranchId && requestItems.length) {
        stockTransferRequestRecords.set(requestId, {
          id: requestId,
          fromBranchId,
          toBranchId,
          cashierId: String(payload.cashierId || "").trim(),
          cashierName: String(payload.cashierName || payload.cashier || "Cashier").trim() || "Cashier",
          note: String(payload.note || "").trim(),
          items: requestItems,
          status: "pending",
          requestedAt: Number(payload.requestedAt || payload.ts || item.clientTs || item.serverTs || 0)
        });
      }
    }
    if (item.type === "stockTransferDecision") {
      const payload = item.payload || {};
      const requestId = String(payload.requestId || "").trim();
      const decision = String(payload.decision || "").trim().toLowerCase();
      if (requestId && (decision === "approved" || decision === "rejected")) {
        const decidedAt = Number(payload.decidedAt || payload.ts || item.clientTs || item.serverTs || 0);
        const previous = stockTransferDecisions.get(requestId);
        if (!previous || decidedAt >= previous.decidedAt) {
          stockTransferDecisions.set(requestId, {
            decision,
            reason: String(payload.reason || payload.decisionReason || "").trim(),
            transferNumber: String(payload.transferNumber || "").trim() || undefined,
            decidedAt
          });
        }
      }
    }
    if (item.type === "stockMovement") {
      const payload = item.payload || {};
      const productId = payload.productId || item.productId;
      if (productId && (payload.branchId || item.branchId) === terminal.branchId) {
        addStock(stockByProduct, productId, eventQuantity(payload));
      }
    }
    if (item.type === "purchase") {
      const payload = item.payload || {};
      const status = String(payload.status || "").toLowerCase();
      if (["cancelled", "canceled", "void", "rejected"].includes(status)) continue;
      if ((payload.branchId || item.branchId) === terminal.branchId) {
        const lines = firstArray(payload.items, payload.lines, payload.products, payload.purchaseItems, payload.purchase_items, payload.stockItems);
        if (lines.length) {
          for (const line of lines) {
            addStock(stockByProduct, line.productId || line.product_id || line.productRecordId, eventQuantity(line));
          }
        } else {
          addStock(stockByProduct, payload.productId || payload.product_id || item.productId, eventQuantity(payload));
        }
      }
    }
  }

  const branches = Array.from(branchRecords.values()).map((item) => {
    const payload = item.payload || {};
    return { id: item.id, name: payload.name || payload.branchName || item.id, location: payload.location || "" };
  });

  const expenseCategories = Array.from(expenseCategoryRecords.values())
    .map((item) => {
      const payload = item.payload || {};
      return {
        id: String(item.id || payload.id || ""),
        name: String(payload.name || "Other").trim() || "Other",
        icon: String(payload.icon || "circle"),
        active: payload.active !== false,
        order: Number(payload.order || 0),
        serverTs: Number(item.serverTs || payload.updatedAt || 0)
      } satisfies ExpenseCategory;
    })
    .filter((category) => category.id && category.active)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || a.name.localeCompare(b.name));

  for (const item of productRecords.values()) {
    const product = normalizeProductForBranch({ id: item.id, serverTs: item.serverTs, ...(item.payload || {}) }, terminal.branchId);
    const key = productDedupeKey(product);
    productIdsByKey.set(key, [...(productIdsByKey.get(key) || []), product.id]);
    baseStockByKey.set(key, Math.max(baseStockByKey.get(key) || 0, product.stockQty));
    productGroups.set(key, [...(productGroups.get(key) || []), product]);
  }

  const invoices = Array.from(invoiceRecords.values())
    .map((invoice) => {
      const notePatch = invoiceNotes.get(invoice.id);
      const voidRequest = invoiceVoidRequests.get(invoice.id);
      const voidDecision = invoiceVoidDecisions.get(invoice.id);
      const voidRequestStatus: Invoice["voidRequestStatus"] = voidDecision?.decision || (voidRequest ? "pending" : undefined);
      const hydratedInvoice = {
        ...invoice,
        note: notePatch ? notePatch.note : invoice.note,
        paidCents: Math.max(invoice.paidCents, paidByInvoice.get(invoice.id) || 0),
        voidRequestId: voidRequest?.id,
        voidReason: voidRequest?.reason,
        voidRequestStatus,
        voidDecisionReason: voidDecision?.reason
      };
      const balance = Math.max(0, hydratedInvoice.totalCents - hydratedInvoice.paidCents);
      const invoiceTs = Number(hydratedInvoice.ts || 0);
      return balance > 0 && (
        carriedOverInvoiceIds.has(hydratedInvoice.id)
        || Boolean(dayClosedAt && invoiceTs > 0 && invoiceTs <= dayClosedAt)
      )
        ? { ...hydratedInvoice, carriedOver: true }
        : hydratedInvoice;
    })
    .filter((invoice) => invoice.branchId === terminal.branchId)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const fallbackProducts = dedupeCatalogProducts(Array.from(productGroups.entries())
    .flatMap(([key, rows]) => {
      const product = mergeProductGroup(rows);
      if (!product) return [];
      return [{
        ...product,
        stockQty: (baseStockByKey.get(key) || 0) + (productIdsByKey.get(key) || []).reduce((sum, id) => sum + (stockByProduct.get(id) || 0), 0)
      }];
    }));

  const products = dedupeCatalogProducts(serverCatalogProducts !== null ? serverCatalogProducts : fallbackProducts);
  const cashierJointDebts = Array.from(cashierJointDebtRecords.values())
    .map((debt) => ({
      ...debt,
      shares: debt.shares.map((share) => ({
        ...share,
        paidCents: Math.min(
          Math.max(0, Number(share.amountCents || 0)),
          Math.max(0, Number(share.paidCents || 0)) + (cashierJointDebtPaidCents.get(`${debt.id}:${share.cashierId}`) || 0)
        )
      }))
    }))
    .filter((debt) => debt.branchId === terminal.branchId)
    .sort((a, b) => b.ts - a.ts);

  const stockTransferRequests = Array.from(stockTransferRequestRecords.values())
    .filter((request) => request.fromBranchId === terminal.branchId)
    .map((request) => {
      const review = stockTransferDecisions.get(request.id);
      return review ? {
        ...request,
        status: review.decision,
        decisionReason: review.reason,
        transferNumber: review.transferNumber,
        decidedAt: review.decidedAt
      } : request;
    })
    .sort((a, b) => b.requestedAt - a.requestedAt);

  const businessDays = Array.from(businessDayRecords.values())
    .sort((a, b) => b.endedAt - a.endedAt);

  return { branches, invoices, products, cashierJointDebts, stockTransferRequests, expenseCategories, businessDays, dayClosedAt };
}

export async function resolveBarcode(terminal: TerminalCredentials, barcode: string): Promise<Product | null> {
  const data = await jsonFetch<any>("/api/barcodes/resolve", {
    method: "POST",
    headers: terminalHeaders(terminal),
    body: JSON.stringify({ barcode, branchId: terminal.branchId })
  });
  if (!data.available || !data.product) return null;
  const product = normalizeProductForBranch({ ...data.product, barcode }, terminal.branchId);
  return productIsEnabled(product) ? product : null;
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

export async function pushCheckout(terminal: TerminalCredentials, account: Account, receipt: Receipt): Promise<string> {
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
        date: businessDateValue(ts),
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
        unitCostCents: Math.max(0, Number(item.unitCostCents || 0)),
        invoiceId,
        reason: `Sale ${receipt.number}`,
        ts
      }
    }))
  ];

  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
  return result.invoiceNumbers?.[invoiceId] || receipt.number;
}

export async function patchInvoiceNote(
  terminal: TerminalCredentials,
  account: Account,
  invoice: Invoice,
  note: string
): Promise<void> {
  const ts = Date.now();
  const events = [{
    id: uid("note"),
    type: "invoiceNote",
    branchId: terminal.branchId,
    clientTs: ts,
    payload: {
      invoiceId: invoice.id,
      receiptNo: invoice.number,
      note,
      branchId: terminal.branchId,
      cashierId: account.id,
      cashierName: account.name,
      ts
    }
  }];

  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
}

export async function pushExpense(
  terminal: TerminalCredentials,
  account: Account,
  expense: { categoryId: string; category: string; amountCents: number; note?: string; source?: "cash_till" | "mpesa"; status?: "approved" | "pending" }
): Promise<void> {
  const ts = Date.now();
  const status = expense.status || (expense.amountCents > 50000 ? "pending" : "approved");
  const events = [{
        id: uid("ex"),
        type: "expense",
        branchId: terminal.branchId,
        clientTs: ts,
        payload: {
          categoryId: expense.categoryId,
          category: expense.category,
          amountCents: expense.amountCents,
          note: `Quick expense - ${account.name}${expense.note ? " - " + expense.note : ""}`,
          source: expense.source || "cash_till",
          status,
          enteredBy: account.name,
          cashierId: account.id,
          branchId: terminal.branchId,
          date: businessDateValue(ts),
          ts
        }
      }];
  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
}

export async function requestStockTransfer(
  terminal: TerminalCredentials,
  account: Account,
  request: { toBranchId: string; note?: string; items: StockTransferRequestItem[] }
): Promise<string> {
  const ts = Date.now();
  const requestId = uid("transfer-request");
  const events = [{
    id: requestId,
    type: "stockTransferRequest",
    branchId: terminal.branchId,
    clientTs: ts,
    payload: {
      id: requestId,
      fromBranchId: terminal.branchId,
      toBranchId: request.toBranchId,
      cashierId: account.id,
      cashierName: account.name,
      note: String(request.note || "").trim(),
      items: request.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        sku: item.sku || "",
        qty: Math.max(1, Math.floor(Number(item.qty || 0)))
      })),
      status: "pending",
      requestedAt: ts,
      ts
    }
  }];
  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
  return requestId;
}

export async function pushCashSessionEvent(
  terminal: TerminalCredentials,
  account: Account,
  mode: "open" | "close",
  amountCents: number
): Promise<void> {
  const ts = Date.now();
  const events = [{
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
      }];
  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
}

export async function requestInvoiceVoid(
  terminal: TerminalCredentials,
  account: Account,
  invoice: Invoice,
  reason: string
): Promise<void> {
  const ts = Date.now();
  const events = [{
    id: uid("void-request"),
    type: "invoiceVoidRequest",
    branchId: terminal.branchId,
    clientTs: ts,
    payload: {
      invoiceId: invoice.id,
      receiptNo: invoice.number,
      reason: reason.trim(),
      branchId: terminal.branchId,
      cashierId: account.id,
      cashierName: account.name,
      ts
    }
  }];

  const result = await pushSyncEvents(terminal, events);
  assertSyncAccepted(result, events);
}
