import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pool, q, ready, tx } from "../src/db.js";
import {
  kopokopoConfig,
  requestKopokopoAccessToken,
} from "../src/services/kopokopo.js";
import { ingestKopokopoIncomingPaymentStatus } from "../src/services/kopokopoIncomingPayments.js";

const config = kopokopoConfig();
const providerWaitMs = 60_000;
const webhookGraceMs = 10_000;
const diagnosticTill = process.env.KOPOKOPO_DIAGNOSTIC_TILL
  || (config.scope === "till" ? config.scopeReference : "000000");

function fail(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  throw error;
}

async function responseJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { message: raw.slice(0, 500) };
  }
}

function assertOfficialLocation(location) {
  if (!location) fail("Kopo Kopo did not return an incoming-payment resource location.");
  const expected = new URL(config.baseUrl);
  const actual = new URL(location);
  if (actual.origin !== expected.origin || !actual.pathname.startsWith("/api/v2/incoming_payments/")) {
    fail("Kopo Kopo returned an unexpected incoming-payment resource location.");
  }
  return actual.toString();
}

async function cleanupProbe(resourceId, eventId) {
  await tx(async (client) => {
    await client.query("DELETE FROM kopokopo_transactions WHERE id = $1", [resourceId]);
    await client.query("DELETE FROM kopokopo_webhook_events WHERE event_id = $1", [eventId]);
  });
}

async function verifyPublicIngress() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const eventId = `diag_evt_${crypto.randomUUID()}`;
  const resourceId = `diag_txn_${crypto.randomUUID()}`;
  const payload = {
    topic: "buygoods_transaction_received",
    id: eventId,
    created_at: new Date().toISOString(),
    event: {
      type: "Buygoods Transaction",
      resource: {
        id: resourceId,
        amount: "0.01",
        status: "Received",
        system: "VISIONPOS diagnostic",
        currency: "KES",
        reference: `VP${suffix}`,
        till_number: diagnosticTill,
        sender_first_name: "VISIONPOS",
        sender_last_name: "Diagnostic",
        origination_time: new Date().toISOString(),
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", config.apiKey).update(rawBody).digest("hex");
  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "VISIONPOS-KopoKopo-Diagnostic/1.0",
        "X-KopoKopo-Signature": signature,
      },
      body: rawBody,
    });
    const body = await responseJson(response);
    if (response.status !== 200 || body.ok !== true) {
      fail("The signed public webhook probe was rejected.", {
        providerStatus: response.status,
        providerMessage: body.error || body.message,
      });
    }
    const stored = await q(
      "SELECT id, amount_cents, branch_id, status FROM kopokopo_transactions WHERE id = $1",
      [resourceId]
    );
    const row = stored.rows[0];
    if (!row || Number(row.amount_cents) !== 1 || String(row.status).toLowerCase() !== "received") {
      fail("The public webhook returned success but did not persist the diagnostic transaction.");
    }
    console.log("PASS public ingress, API-key signature, and database persistence");
  } finally {
    await cleanupProbe(resourceId, eventId);
  }
}

async function createSandboxPayment(accessToken) {
  const callbackUrl = config.webhookUrl;
  const response = await fetch(`${config.baseUrl}/api/v2/incoming_payments`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "VISIONPOS-KopoKopo-Diagnostic/1.0",
    },
    body: JSON.stringify({
      payment_channel: "M-PESA STK Push",
      till_number: diagnosticTill,
      subscriber: {
        first_name: "VISIONPOS",
        last_name: "Diagnostic",
        phone_number: "+254999999999",
      },
      amount: { currency: "KES", value: 1 },
      metadata: {
        reference: `VISIONPOS-DIAG-${Date.now()}`,
        notes: "Sandbox webhook delivery diagnostic",
      },
      _links: { callback_url: callbackUrl },
    }),
  });
  const body = await responseJson(response);
  if (response.status !== 201) {
    fail("Kopo Kopo rejected the sandbox incoming-payment request.", {
      providerStatus: response.status,
      providerMessage: body.error_message || body.error || body.message,
    });
  }
  console.log("PASS sandbox incoming-payment request accepted");
  return assertOfficialLocation(response.headers.get("location"));
}

async function readPayment(accessToken, location) {
  const response = await fetch(location, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "VISIONPOS-KopoKopo-Diagnostic/1.0",
    },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    fail("Kopo Kopo rejected the incoming-payment status request.", {
      providerStatus: response.status,
      providerMessage: body.error_message || body.error || body.message,
    });
  }
  return body?.data?.attributes || {};
}

async function waitForProviderResult(accessToken, location) {
  const deadline = Date.now() + providerWaitMs;
  let attributes = {};
  while (Date.now() < deadline) {
    attributes = await readPayment(accessToken, location);
    const status = String(attributes.status || "").toLowerCase();
    if (status === "failed" || attributes?.event?.resource) return attributes;
    await delay(2_000);
  }
  return attributes;
}

async function waitForStoredProviderTransaction(resource) {
  if (!resource?.id && !resource?.reference) return null;
  const deadline = Date.now() + webhookGraceMs;
  while (Date.now() < deadline) {
    const result = await q(
      "SELECT id, webhook_event_id, reference_last4, amount_cents, status, branch_id FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2 LIMIT 1",
      [String(resource.id || ""), String(resource.reference || "").toUpperCase()]
    );
    if (result.rows[0]) return result.rows[0];
    await delay(2_000);
  }
  return null;
}

async function cleanupProviderTransaction(row) {
  if (!row) return;
  const id = row.id;
  const eventId = row.webhook_event_id ?? row.webhookEventId;
  await tx(async (client) => {
    await client.query("DELETE FROM kopokopo_transactions WHERE id = $1", [id]);
    if (eventId) await client.query("DELETE FROM kopokopo_webhook_events WHERE event_id = $1", [eventId]);
  });
}

async function main() {
  if (!config.enabled) fail("KOPOKOPO_ENABLED must be 1.");
  if (config.mode !== "sandbox") fail("This diagnostic refuses to create a payment outside sandbox mode.");
  if (!config.apiKey) fail("KOPOKOPO_API_KEY is not configured.");
  if (!config.webhookUrl.startsWith("https://")) fail("KOPOKOPO_WEBHOOK_URL must use HTTPS.");
  if (!diagnosticTill) fail("A diagnostic till is required for a till-scoped subscription.");
  await ready;

  console.log("VISIONPOS Kopo Kopo sandbox diagnostic");
  console.log(`Webhook: ${config.webhookUrl}`);
  console.log(`Scope: ${config.scope}${config.scopeReference ? ` (${config.scopeReference})` : ""}`);

  const accessToken = await requestKopokopoAccessToken(config);
  console.log("PASS OAuth client credentials");
  await verifyPublicIngress();

  const location = await createSandboxPayment(accessToken);
  console.log(`Payment resource: ${new URL(location).pathname.split("/").pop()}`);
  const attributes = await waitForProviderResult(accessToken, location);
  const callbackUrl = attributes?._links?.callback_url || null;
  const providerStatus = attributes.status || "Unknown";
  const resource = attributes?.event?.resource || null;
  console.log(`Provider status: ${providerStatus}`);
  console.log(`Provider callback: ${callbackUrl || "missing"}`);
  if (callbackUrl !== config.webhookUrl) fail("Kopo Kopo stored a different callback URL from VISIONPOS configuration.");
  if (!resource) {
    fail("Kopo Kopo did not produce a successful Buygoods resource.", {
      providerMessage: Array.isArray(attributes?.event?.errors) ? attributes.event.errors.join("; ") : null,
    });
  }

  let stored = await waitForStoredProviderTransaction(resource);
  if (stored) {
    console.log("PASS Kopo Kopo Buygoods webhook delivered and stored");
  } else {
    console.log("WARN Kopo Kopo did not deliver the Buygoods webhook; testing authenticated status recovery");
    const recovered = await ingestKopokopoIncomingPaymentStatus(attributes, {
      branchId: config.sandboxBranchId,
      tillNumber: diagnosticTill,
      amountCents: 100,
    }, config);
    if (recovered.pending) fail("Kopo Kopo status resource did not contain a completed Buygoods transaction.");
    stored = await waitForStoredProviderTransaction(resource);
    if (!stored) fail("VISIONPOS could not persist the authenticated Kopo Kopo status result.");
    console.log("PASS authenticated payment-status recovery stored the missing Buygoods transaction");
  }
  await cleanupProviderTransaction(stored);
  console.log("PASS diagnostic database rows cleaned up");
}

main()
  .catch((error) => {
    console.error(`FAIL ${error.message}`);
    if (error.providerStatus) console.error(`Provider HTTP status: ${error.providerStatus}`);
    if (error.providerMessage) console.error(`Provider message: ${error.providerMessage}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
