import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const RECEIVED_TOPICS = new Set(["buygoods_transaction_received", "b2b_transaction_received"]);
const REVERSED_TOPICS = new Set(["buygoods_transaction_reversed", "b2b_transaction_reversed"]);
const providerRequestTimeoutMs = 15_000;

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

export function kopokopoConfig() {
  const mode = text(process.env.KOPOKOPO_MODE || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
  const apiKey = text(process.env.KOPOKOPO_API_KEY);
  return {
    enabled: process.env.KOPOKOPO_ENABLED === "1",
    mode,
    baseUrl: cleanBaseUrl(process.env.KOPOKOPO_BASE_URL || (mode === "live" ? "https://api.kopokopo.com" : "https://sandbox.kopokopo.com")),
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

export function branchForTill(tillNumber, config = kopokopoConfig()) {
  const till = text(tillNumber);
  if (till && config.tillBranchMap[till]) return config.tillBranchMap[till];
  if (config.mode === "sandbox") return config.sandboxBranchId || null;
  return null;
}

export function normalizeKopokopoReference(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
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
    originationTime: text(resource?.origination_time || body?.created_at) || null,
    eventTime: text(body?.created_at) || null,
  };
}

export function redactKopokopoPayload(body) {
  const payload = JSON.parse(JSON.stringify(body || {}));
  const resource = payload?.event?.resource;
  if (resource && typeof resource === "object") {
    for (const field of ["sender_phone_number", "sender_first_name", "sender_middle_name", "sender_last_name"]) {
      delete resource[field];
    }
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

function officialProviderLocation(location, pathPrefix, config) {
  if (!location) throw new Error("kopokopo_resource_location_missing");
  const expected = new URL(config.baseUrl);
  const actual = new URL(location);
  if (actual.origin !== expected.origin || !actual.pathname.startsWith(pathPrefix)) {
    throw new Error("kopokopo_resource_location_invalid");
  }
  return actual.toString();
}

export async function requestKopokopoAccessToken(config = kopokopoConfig()) {
  if (!config.clientId || !config.clientSecret) throw new Error("kopokopo_oauth_not_configured");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetch(`${config.baseUrl}/oauth/token`, {
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
  return payload.access_token;
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

export async function pollKopokopoTransactions({ fromTime, toTime, timeoutMs = 300_000 } = {}, config = kopokopoConfig()) {
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
  const location = officialProviderLocation(
    response.headers.get("location"),
    "/api/v2/polling/",
    config
  );
  const deadline = Date.now() + Math.max(5_000, Math.min(Number(timeoutMs) || 300_000, 15 * 60_000));
  let lastStatus = "Pending";
  let lastErrors = null;
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
  error.providerResourceId = new URL(location).pathname.split("/").filter(Boolean).pop();
  error.providerMessage = lastErrors?.join("; ") || "Polling resource did not reach Success before the configured deadline.";
  throw error;
}
