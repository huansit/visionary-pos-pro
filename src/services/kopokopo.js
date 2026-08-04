import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const RECEIVED_TOPICS = new Set(["buygoods_transaction_received", "b2b_transaction_received"]);
const REVERSED_TOPICS = new Set(["buygoods_transaction_reversed", "b2b_transaction_reversed"]);
const providerRequestTimeoutMs = 15_000;
const accessTokenCache = new Map();
const accessTokenRequests = new Map();
export const maxIncomingPaymentCents = 10_000_000_000;

function text(value) {
  return String(value ?? "").trim();
}

function cleanBaseUrl(value) {
  return text(value || "https://sandbox.kopokopo.com").replace(/\/+$/, "");
}

function parseTillMap(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, branchId]) => [text(key), text(branchId)]).filter(([key, branchId]) => key && branchId));
  } catch (_) {
    return {};
  }
}

function additionalAccountKeys() {
  return [...new Set(text(process.env.KOPOKOPO_ADDITIONAL_ACCOUNTS)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value)))];
}

function additionalAccountConfig(key, primary) {
  const prefix = `KOPOKOPO_${key}`;
  const tillNumber = text(process.env[`${prefix}_TILL_NUMBER`]);
  const branchId = text(process.env[`${prefix}_BRANCH_ID`]);
  const apiKey = text(process.env[`${prefix}_API_KEY`]);
  return {
    ...primary,
    accountId: key.toLowerCase(),
    accountKey: key,
    additional: true,
    clientId: text(process.env[`${prefix}_CLIENT_ID`]),
    clientSecret: text(process.env[`${prefix}_CLIENT_SECRET`]),
    apiKey,
    webhookSecret: text(process.env[`${prefix}_WEBHOOK_SECRET`] || apiKey),
    scope: "till",
    scopeReference: tillNumber,
    tillBranchMap: tillNumber && branchId ? { [tillNumber]: branchId } : {},
    sandboxBranchId: primary.mode === "sandbox" ? branchId : "",
  };
}

export function kopokopoConfig() {
  const mode = text(process.env.KOPOKOPO_MODE || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
  const apiKey = text(process.env.KOPOKOPO_API_KEY);
  const defaultApiUrl = mode === "live" ? "https://api.kopokopo.com" : "https://sandbox.kopokopo.com";
  const defaultAuthUrl = mode === "live" ? "https://app.kopokopo.com" : "https://sandbox.kopokopo.com";
  return {
    accountId: "primary",
    accountKey: "PRIMARY",
    additional: false,
    enabled: process.env.KOPOKOPO_ENABLED === "1",
    mode,
    baseUrl: cleanBaseUrl(process.env.KOPOKOPO_BASE_URL || defaultApiUrl),
    authUrl: cleanBaseUrl(process.env.KOPOKOPO_AUTH_URL || defaultAuthUrl),
    clientId: text(process.env.KOPOKOPO_CLIENT_ID),
    clientSecret: text(process.env.KOPOKOPO_CLIENT_SECRET),
    apiKey,
    webhookSecret: text(process.env.KOPOKOPO_WEBHOOK_SECRET || apiKey),
    webhookUrl: text(process.env.KOPOKOPO_WEBHOOK_URL),
    scope: text(process.env.KOPOKOPO_SCOPE || "company").toLowerCase() === "till" ? "till" : "company",
    scopeReference: text(process.env.KOPOKOPO_SCOPE_REFERENCE),
    tillBranchMap: parseTillMap(process.env.KOPOKOPO_TILL_BRANCH_MAP),
    sandboxBranchId: text(process.env.KOPOKOPO_SANDBOX_BRANCH_ID),
  };
}

export function kopokopoConfigs() {
  const primary = kopokopoConfig();
  return [primary, ...additionalAccountKeys().map((key) => additionalAccountConfig(key, primary))];
}

export function kopokopoConfigForBranch(branchId) {
  const wanted = text(branchId);
  if (!wanted) return null;
  return kopokopoConfigs().find((config) => (
    Object.values(config.tillBranchMap || {}).includes(wanted)
    || (config.mode === "sandbox" && config.sandboxBranchId === wanted)
  )) || null;
}

export function kopokopoEnabled() {
  return kopokopoConfigs().some((config) => config.enabled);
}

export function branchForTill(tillNumber, config = kopokopoConfig()) {
  const till = text(tillNumber);
  if (till && config.tillBranchMap[till]) return config.tillBranchMap[till];
  if (config.mode === "sandbox") return config.sandboxBranchId || null;
  return null;
}

export function normalizeKopokopoReference(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function kopokopoPhoneLast4(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function amountToCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round((amount + Number.EPSILON) * 100) : -1;
}

export function parseKopokopoWebhook(body, config = kopokopoConfig()) {
  const topic = text(body?.topic).toLowerCase();
  if (!RECEIVED_TOPICS.has(topic) && !REVERSED_TOPICS.has(topic)) {
    return { supported: false, topic };
  }
  const resource = body?.event?.resource;
  const eventId = text(body?.id);
  const resourceId = text(resource?.id);
  const reference = normalizeKopokopoReference(resource?.reference);
  const amountCents = amountToCents(resource?.amount);
  if (!eventId || !resourceId || !reference || amountCents < 0) {
    return { supported: true, valid: false, topic };
  }
  const reversed = REVERSED_TOPICS.has(topic);
  const payerName = [resource?.sender_first_name, resource?.sender_middle_name, resource?.sender_last_name]
    .map(text)
    .filter(Boolean)
    .join(" ")
    .slice(0, 255);
  return {
    supported: true,
    valid: true,
    reversed,
    eventId,
    topic,
    resourceId,
    reference,
    referenceLast4: reference.slice(-4),
    amountCents,
    status: reversed ? "Reversed" : text(resource?.status || "Received"),
    currency: text(resource?.currency || "KES").toUpperCase(),
    tillNumber: text(resource?.till_number),
    branchId: branchForTill(resource?.till_number, config),
    payerName: payerName || null,
    payerPhoneLast4: kopokopoPhoneLast4(resource?.sender_phone_number),
    originationTime: text(resource?.origination_time || body?.created_at) || null,
    eventTime: text(body?.created_at) || null,
  };
}

export function kopokopoTransactionEvent(transaction, {
  source = "kopokopo_polling",
  eventIdPrefix = "poll",
  index = 0,
  eventTime = new Date().toISOString(),
} = {}) {
  const resource = transaction?.resource;
  if (text(transaction?.type).toLowerCase() !== "buygoods transaction" || !text(resource?.id)) {
    return null;
  }
  const status = text(resource?.status).toLowerCase();
  if (status !== "received" && status !== "reversed") return null;
  return {
    topic: status === "reversed" ? "buygoods_transaction_reversed" : "buygoods_transaction_received",
    id: `${eventIdPrefix}:${text(resource.id)}:${status}`,
    created_at: text(resource.origination_time) || eventTime,
    event: {
      type: "Buygoods Transaction",
      resource,
    },
    _links: { source, index },
  };
}

export function normalizeKopokopoCallback(body) {
  if (text(body?.topic)) {
    return { kind: "subscription", recognized: true, received: 1, events: [body] };
  }

  const data = body?.data;
  const attributes = data?.attributes;
  if (!attributes || typeof attributes !== "object") {
    return { kind: "unknown", recognized: false, received: 0, events: [] };
  }

  const eventTime = text(attributes.created_at) || new Date().toISOString();
  if (Array.isArray(attributes.transactions)) {
    const events = attributes.transactions
      .map((transaction, index) => kopokopoTransactionEvent(transaction, {
        source: "kopokopo_polling",
        index,
        eventTime,
      }))
      .filter(Boolean);
    return { kind: "polling", recognized: true, received: attributes.transactions.length, events };
  }

  const resource = attributes?.event?.resource;
  if (resource && typeof resource === "object") {
    const event = kopokopoTransactionEvent({ type: "Buygoods Transaction", resource }, {
      source: "kopokopo_incoming_payment",
      eventIdPrefix: "incoming",
      eventTime,
    });
    return { kind: "incoming_payment", recognized: true, received: event ? 1 : 0, events: event ? [event] : [] };
  }

  if (text(data?.type).toLowerCase().includes("incoming") || text(data?.type).toLowerCase() === "polling") {
    return { kind: text(data.type).toLowerCase(), recognized: true, received: 0, events: [] };
  }
  return { kind: "unknown", recognized: false, received: 0, events: [] };
}

export function redactKopokopoPayload(body) {
  const payload = JSON.parse(JSON.stringify(body || {}));
  const redactResource = (resource) => {
    if (!resource || typeof resource !== "object") return;
    for (const field of ["sender_phone_number", "sender_first_name", "sender_middle_name", "sender_last_name"]) {
      delete resource[field];
    }
  };
  redactResource(payload?.event?.resource);
  redactResource(payload?.data?.attributes?.event?.resource);
  for (const transaction of (Array.isArray(payload?.data?.attributes?.transactions) ? payload.data.attributes.transactions : [])) {
    redactResource(transaction?.resource);
  }
  return payload;
}

function signatureBuffer(value) {
  const signature = text(value).replace(/^sha256=/i, "");
  if (/^[a-f0-9]{64}$/i.test(signature)) return Buffer.from(signature, "hex");
  try {
    const decoded = Buffer.from(signature, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch (_) {
    return null;
  }
}

export function validKopokopoSignature(rawBody, signature, secret = kopokopoConfig().webhookSecret) {
  if (!Buffer.isBuffer(rawBody) || !secret) return false;
  const supplied = signatureBuffer(signature);
  if (!supplied) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function providerJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return { message: raw.slice(0, 500) }; }
}

export function officialKopokopoLocation(location, pathPrefix, config = kopokopoConfig()) {
  if (!location) throw new Error("kopokopo_resource_location_missing");
  const expected = new URL(config.baseUrl);
  const actual = new URL(location);
  if (actual.origin !== expected.origin || !actual.pathname.startsWith(pathPrefix)) {
    throw new Error("kopokopo_resource_location_invalid");
  }
  return actual.toString();
}

export function tillForBranch(branchId, config = kopokopoConfig()) {
  const wanted = text(branchId);
  const matches = Object.entries(config.tillBranchMap)
    .filter(([, mappedBranchId]) => mappedBranchId === wanted)
    .map(([till]) => till);
  if (matches.length === 1) return matches[0];
  if (config.mode === "sandbox" && wanted === config.sandboxBranchId) {
    return config.scope === "till" && config.scopeReference ? config.scopeReference : "000000";
  }
  return null;
}

function accessTokenCacheKey(config) {
  const secretDigest = crypto.createHash("sha256").update(text(config.clientSecret)).digest("hex");
  return [config.accountId, config.authUrl, config.clientId, secretDigest].map(text).join("|");
}

export function clearKopokopoAccessTokenCache(config = null) {
  if (!config) {
    accessTokenCache.clear();
    accessTokenRequests.clear();
    return;
  }
  const key = accessTokenCacheKey(config);
  accessTokenCache.delete(key);
  accessTokenRequests.delete(key);
}

export async function requestKopokopoAccessToken(config = kopokopoConfig()) {
  if (!config.clientId || !config.clientSecret) throw new Error("kopokopo_oauth_not_configured");
  const key = accessTokenCacheKey(config);
  const cached = accessTokenCache.get(key);
  if (cached?.token && cached.expiresAt > Date.now()) return cached.token;
  if (accessTokenRequests.has(key)) return accessTokenRequests.get(key);

  const request = (async () => {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
    });
    const response = await fetch(`${config.authUrl}/oauth/token`, {
      method: "POST",
      signal: AbortSignal.timeout(providerRequestTimeoutMs),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "VISIONPOS/1.0",
      },
      body,
    });
    const payload = await providerJson(response);
    if (!response.ok || !payload.access_token) {
      const error = new Error("kopokopo_token_request_failed");
      error.providerStatus = response.status;
      error.providerMessage = payload.error_message || payload.error || payload.message;
      throw error;
    }
    const providerLifetime = Number(payload.expires_in || payload.expiresIn || 3_600);
    const lifetimeSeconds = Number.isFinite(providerLifetime)
      ? Math.max(30, Math.min(86_400, providerLifetime))
      : 3_600;
    const safetyMs = Math.min(60_000, lifetimeSeconds * 1_000 * 0.1);
    accessTokenCache.set(key, {
      token: payload.access_token,
      expiresAt: Date.now() + (lifetimeSeconds * 1_000) - safetyMs,
    });
    return payload.access_token;
  })();
  accessTokenRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (accessTokenRequests.get(key) === request) accessTokenRequests.delete(key);
  }
}

async function fetchWithKopokopoAccessToken(url, options, config, suppliedAccessToken = "") {
  let accessToken = suppliedAccessToken || await requestKopokopoAccessToken(config);
  const send = () => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  let response = await send();
  if (response.status === 401) {
    clearKopokopoAccessTokenCache(config);
    accessToken = await requestKopokopoAccessToken(config);
    response = await send();
  }
  return response;
}

export async function requestKopokopoIncomingPayment({
  tillNumber,
  phoneNumber,
  amountCents,
  firstName = "VISIONPOS",
  lastName = "Customer",
  reference,
  notes = "VISIONPOS invoice settlement",
} = {}, config = kopokopoConfig()) {
  const till = text(tillNumber);
  const phone = text(phoneNumber);
  const cents = Number(amountCents);
  const normalizedReference = text(reference).slice(0, 100);
  if (!config.enabled) throw new Error("kopokopo_not_configured");
  if (!till || !/^\+254\d{9}$/.test(phone) || !Number.isSafeInteger(cents) || cents <= 0 || cents > maxIncomingPaymentCents) {
    throw new Error("invalid_kopokopo_incoming_payment");
  }
  if (!normalizedReference) throw new Error("kopokopo_payment_reference_required");
  const response = await fetchWithKopokopoAccessToken(`${config.baseUrl}/api/v2/incoming_payments`, {
    method: "POST",
    signal: AbortSignal.timeout(providerRequestTimeoutMs),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "VISIONPOS/1.0",
    },
    body: JSON.stringify({
      payment_channel: "M-PESA STK Push",
      till_number: till,
      subscriber: {
        first_name: text(firstName).slice(0, 80) || "VISIONPOS",
        last_name: text(lastName).slice(0, 80) || "Customer",
        phone_number: phone,
      },
      amount: { currency: "KES", value: cents / 100 },
      metadata: {
        reference: normalizedReference,
        notes: text(notes).slice(0, 255),
      },
      _links: { callback_url: config.webhookUrl },
    }),
  }, config);
  const payload = await providerJson(response);
  if (response.status !== 201) {
    const error = new Error("kopokopo_incoming_payment_request_failed");
    error.providerStatus = response.status;
    error.providerMessage = payload.error_message || payload.error || payload.message;
    throw error;
  }
  const location = officialKopokopoLocation(
    response.headers.get("location"),
    "/api/v2/incoming_payments/",
    config
  );
  return {
    location,
    providerRequestId: new URL(location).pathname.split("/").filter(Boolean).pop(),
  };
}

export async function readKopokopoIncomingPayment(location, config = kopokopoConfig(), suppliedAccessToken = "") {
  const officialLocation = officialKopokopoLocation(location, "/api/v2/incoming_payments/", config);
  const response = await fetchWithKopokopoAccessToken(officialLocation, {
    signal: AbortSignal.timeout(providerRequestTimeoutMs),
    headers: {
      Accept: "application/json",
      "User-Agent": "VISIONPOS/1.0",
    },
  }, config, suppliedAccessToken);
  const payload = await providerJson(response);
  if (!response.ok) {
    const error = new Error("kopokopo_incoming_payment_status_failed");
    error.providerStatus = response.status;
    error.providerMessage = payload.error_message || payload.error || payload.message;
    throw error;
  }
  return payload?.data?.attributes || {};
}

export async function createKopokopoSubscriptions(config = kopokopoConfig()) {
  if (!config.webhookUrl.startsWith("https://")) throw new Error("kopokopo_https_webhook_required");
  if (config.scope === "till" && !config.scopeReference) throw new Error("kopokopo_scope_reference_required");
  const accessToken = await requestKopokopoAccessToken(config);
  const eventTypes = ["buygoods_transaction_received", "buygoods_transaction_reversed"];
  const subscriptions = [];
  for (const eventType of eventTypes) {
    const requestBody = {
      event_type: eventType,
      url: config.webhookUrl,
      scope: config.scope,
      enable_daraja_payload: false,
    };
    if (config.scopeReference) requestBody.scope_reference = config.scopeReference;
    const response = await fetch(`${config.baseUrl}/api/v2/webhook_subscriptions`, {
      method: "POST",
      signal: AbortSignal.timeout(providerRequestTimeoutMs),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "VISIONPOS/1.0",
      },
      body: JSON.stringify(requestBody),
    });
    const payload = await providerJson(response);
    if (!response.ok) {
      const error = new Error("kopokopo_subscription_failed");
      error.providerStatus = response.status;
      error.providerMessage = payload.error_message || payload.error || payload.message;
      throw error;
    }
    subscriptions.push({ eventType, location: response.headers.get("location") || null });
  }
  return subscriptions;
}

export async function pollKopokopoTransactions({ fromTime, toTime, timeoutMs = 300_000, onProgress } = {}, config = kopokopoConfig()) {
  if (!config.enabled) throw new Error("kopokopo_not_configured");
  if (!fromTime || !toTime) throw new Error("kopokopo_polling_range_required");
  const accessToken = await requestKopokopoAccessToken(config);
  const response = await fetch(`${config.baseUrl}/api/v2/polling`, {
    method: "POST",
    signal: AbortSignal.timeout(providerRequestTimeoutMs),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "VISIONPOS/1.0",
    },
    body: JSON.stringify({
      scope: config.scope,
      scope_reference: config.scopeReference || "",
      from_time: fromTime,
      to_time: toTime,
      _links: { callback_url: config.webhookUrl },
    }),
  });
  const payload = await providerJson(response);
  if (response.status !== 201) {
    const error = new Error("kopokopo_polling_request_failed");
    error.providerStatus = response.status;
    error.providerMessage = payload.error_message || payload.error || payload.message;
    throw error;
  }
  const location = officialKopokopoLocation(
    response.headers.get("location"),
    "/api/v2/polling/",
    config
  );
  const providerResourceId = new URL(location).pathname.split("/").filter(Boolean).pop();
  const deadline = Date.now() + Math.max(5_000, Math.min(Number(timeoutMs) || 300_000, 15 * 60_000));
  const startedAt = Date.now();
  let lastStatus = "Pending";
  let lastErrors = null;
  let lastReportedStatus = "";
  let nextProgressAt = 0;
  if (typeof onProgress === "function") {
    onProgress({ phase: "created", status: "Accepted", providerResourceId, elapsedMs: 0 });
  }
  while (Date.now() < deadline) {
    const statusResponse = await fetch(location, {
      signal: AbortSignal.timeout(providerRequestTimeoutMs),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "VISIONPOS/1.0",
      },
    });
    const statusPayload = await providerJson(statusResponse);
    if (!statusResponse.ok) {
      const error = new Error("kopokopo_polling_status_failed");
      error.providerStatus = statusResponse.status;
      error.providerMessage = statusPayload.error_message || statusPayload.error || statusPayload.message;
      throw error;
    }
    const attributes = statusPayload?.data?.attributes || {};
    const status = text(attributes.status).toLowerCase();
    lastStatus = text(attributes.status) || lastStatus;
    lastErrors = Array.isArray(attributes.errors) ? attributes.errors : null;
    const now = Date.now();
    if (typeof onProgress === "function" && (lastStatus !== lastReportedStatus || now >= nextProgressAt)) {
      onProgress({ phase: "waiting", status: lastStatus, providerResourceId, elapsedMs: now - startedAt });
      lastReportedStatus = lastStatus;
      nextProgressAt = now + 10_000;
    }
    if (status === "failed") {
      const error = new Error("kopokopo_polling_failed");
      error.providerMessage = Array.isArray(attributes.errors) ? attributes.errors.join("; ") : null;
      throw error;
    }
    if (status === "success" || Array.isArray(attributes.transactions)) {
      return {
        location,
        status: attributes.status || "Success",
        transactions: Array.isArray(attributes.transactions) ? attributes.transactions : [],
      };
    }
    await delay(1_000);
  }
  const error = new Error("kopokopo_polling_timeout");
  error.providerStatus = lastStatus;
  error.providerResourceId = providerResourceId;
  error.providerMessage = lastErrors?.join("; ") || "Polling resource did not reach Success before the configured deadline.";
  throw error;
}
