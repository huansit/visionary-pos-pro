import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.PG_MEM = "1";
process.env.PG_MEM_AUTO_MIGRATE = "1";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/kopokopo";
process.env.DEVICE_TOKEN_SECRET = "test-device-token-secret";
process.env.DEVICE_SETUP_KEY = "test-setup-key";
process.env.BCRYPT_ROUNDS = "10";
process.env.ADMIN_EMAIL_CODE_REQUIRED = "0";
process.env.KOPOKOPO_ENABLED = "1";
process.env.KOPOKOPO_MODE = "sandbox";
process.env.KOPOKOPO_CLIENT_ID = "test-client-id";
process.env.KOPOKOPO_CLIENT_SECRET = "test-client-secret";
process.env.KOPOKOPO_API_KEY = "test-kopokopo-api-key";
process.env.KOPOKOPO_WEBHOOK_URL = "https://visionarypos.cloud/api/integrations/kopokopo/webhook";
process.env.KOPOKOPO_SANDBOX_BRANCH_ID = "b_sip";

const { pool, ready } = await import("../src/db.js");
await ready;
const { default: app } = await import("../src/server.js");
const {
  kopokopoConfig,
  kopokopoConfigForBranch,
  kopokopoConfigs,
  kopokopoPhoneLast4,
  clearKopokopoAccessTokenCache,
  pollKopokopoTransactions,
  readKopokopoIncomingPayment,
  requestKopokopoAccessToken,
  requestKopokopoIncomingPayment,
} = await import("../src/services/kopokopo.js");
const {
  ingestKopokopoIncomingPaymentStatus,
  pendingCheckDelayMs,
} = await import("../src/services/kopokopoIncomingPayments.js");
const { ingestKopokopoPollingTransactions } = await import("../src/services/kopokopoReconciler.js");
const { getLatestRealtimeEvent, publishRealtimeEvent } = await import("../src/realtime.js");

beforeEach(() => clearKopokopoAccessTokenCache());

let sessionToken = "";
let branchSessionToken = "";
let supervisorSessionToken = "";
let cashierSessionToken = "";

function signedWebhook(payload, secret = process.env.KOPOKOPO_API_KEY) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return request(app)
    .post("/api/integrations/kopokopo/webhook")
    .set("Content-Type", "application/json")
    .set("X-KopoKopo-Signature", signature)
    .send(body);
}

function webhookPayload({
  topic = "buygoods_transaction_received",
  eventId = "evt-received-1",
  resourceId = "txn-1",
  status = "Received",
  reference = "TGH7AB12CD",
  tillNumber = "000000",
} = {}) {
  return {
    topic,
    id: eventId,
    created_at: "2026-08-02T10:00:01+03:00",
    event: {
      type: "Buygoods Transaction",
      resource: {
        id: resourceId,
        amount: "1000.00",
        status,
        system: "Lipa Na M-PESA",
        currency: "KES",
        reference,
        till_number: tillNumber,
        sender_phone_number: "+254700000000",
        sender_first_name: "Test",
        sender_last_name: "Customer",
        origination_time: "2026-08-02T10:00:00+03:00",
      },
    },
  };
}

before(async () => {
  const passwordHash = await bcrypt.hash("Admin@123", 10);
  await pool.query(
    `INSERT INTO credentials (id, kind, name, email, password_hash, rights, status, email_verified)
     VALUES ($1, 'admin', $2, $3, $4, $5::jsonb, 'active', true)`,
    ["kopokopo-admin", "Kopo Admin", "kopokopo@example.com", passwordHash, JSON.stringify({ role: "Admin" })]
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "kopokopo@example.com", password: "Admin@123" })
    .expect(200);
  sessionToken = login.body.sessionToken;

  const branchPasswordHash = await bcrypt.hash("Manager@123", 10);
  await pool.query(
    `INSERT INTO credentials (id, kind, name, email, password_hash, branch_id, rights, status, email_verified)
     VALUES ($1, 'user', $2, $3, $4, $5, $6::jsonb, 'active', true)`,
    ["kopokopo-branch-manager", "SIP Manager", "sip.manager@example.com", branchPasswordHash, "b_sip", JSON.stringify({ role: "Manager" })]
  );
  const branchLogin = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "sip.manager@example.com", password: "Manager@123" })
    .expect(200);
  branchSessionToken = branchLogin.body.sessionToken;

  const supervisorPasswordHash = await bcrypt.hash("Supervisor@123", 10);
  await pool.query(
    `INSERT INTO credentials (id, kind, name, email, password_hash, branch_id, rights, status, email_verified)
     VALUES ($1, 'user', $2, $3, $4, $5, $6::jsonb, 'active', true)`,
    ["kopokopo-supervisor", "SIP Supervisor", "sip.supervisor@example.com", supervisorPasswordHash, "b_sip", JSON.stringify({ role: "Supervisor" })]
  );
  const supervisorLogin = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "sip.supervisor@example.com", password: "Supervisor@123" })
    .expect(200);
  supervisorSessionToken = supervisorLogin.body.sessionToken;

  const cashierPasswordHash = await bcrypt.hash("Cashier@123", 10);
  await pool.query(
    `INSERT INTO credentials (id, kind, name, email, password_hash, branch_id, rights, status, email_verified)
     VALUES ($1, 'user', $2, $3, $4, $5, $6::jsonb, 'active', true)`,
    ["kopokopo-cashier", "SIP Cashier", "sip.cashier@example.com", cashierPasswordHash, "b_sip", JSON.stringify({ role: "Cashier" })]
  );
  const cashierLogin = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "sip.cashier@example.com", password: "Cashier@123" })
    .expect(200);
  cashierSessionToken = cashierLogin.body.sessionToken;

  for (const invoice of [
    { id: "inv-1", number: "RCP-SIP-000001", branchId: "b_sip", totalCents: 30000 },
    { id: "inv-2", number: "RCP-SIP-000002", branchId: "b_sip", totalCents: 20000 },
    { id: "inv-3", number: "RCP-SIP-000003", branchId: "b_sip", totalCents: 100000 },
    { id: "inv-cash", number: "RCP-SIP-000004", branchId: "b_sip", totalCents: 50000 },
    { id: "inv-cash-small", number: "RCP-SIP-000005", branchId: "b_sip", totalCents: 10000 },
    { id: "inv-cpt", number: "RCP-CPT-000001", branchId: "b_cpt", totalCents: 100000 },
  ]) {
    await pool.query(
      `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1, 'invoice', $2, NULL, 1, $3, $4::jsonb)`,
      [invoice.id, invoice.branchId, Date.now(), JSON.stringify(invoice)]
    );
  }
  for (const payment of [
    { id: "cash-payment-1", invoiceId: "inv-cash", amountCents: 50000 },
    { id: "cash-payment-2", invoiceId: "inv-cash-small", amountCents: 10000 },
  ]) {
    await pool.query(
      `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1, 'payment', 'b_sip', NULL, 1, $2, $3::jsonb)`,
      [payment.id, Date.now(), JSON.stringify({ ...payment, branchId: "b_sip", method: "cash", status: "captured" })]
    );
  }
});

after(async () => {
  await pool.end();
});

test("rejects a webhook whose raw-body signature is invalid", async () => {
  await signedWebhook(webhookPayload(), "wrong-secret")
    .expect(401)
    .expect({ error: "invalid_kopokopo_signature" });
});

test("keeps unsupported and malformed subscription behavior stable", async () => {
  await signedWebhook({ topic: "unsupported_provider_event", id: "unsupported-event" })
    .expect(202)
    .expect({ ok: true, ignored: true });

  const malformed = webhookPayload({ eventId: "malformed-subscription-event" });
  delete malformed.event.resource.reference;
  await signedWebhook(malformed)
    .expect(400)
    .expect({ error: "invalid_kopokopo_webhook" });
});

test("derives only a privacy-safe payer phone ending", () => {
  assert.equal(kopokopoPhoneLast4("+254 711-222-333"), "2333");
  assert.equal(kopokopoPhoneLast4("123"), null);
  assert.equal(kopokopoPhoneLast4(null), null);
});

test("keeps additional Kopo Kopo applications isolated by branch and signing key", async () => {
  const names = {
    KOPOKOPO_MODE: "live",
    KOPOKOPO_ADDITIONAL_ACCOUNTS: "SIPCITY",
    KOPOKOPO_SIPCITY_CLIENT_ID: "sipcity-client-id",
    KOPOKOPO_SIPCITY_CLIENT_SECRET: "sipcity-client-secret",
    KOPOKOPO_SIPCITY_API_KEY: "sipcity-api-key",
    KOPOKOPO_SIPCITY_BRANCH_ID: "b_cpt",
    KOPOKOPO_SIPCITY_TILL_NUMBER: "3432381",
  };
  const previous = Object.fromEntries(Object.keys(names).map((name) => [name, process.env[name]]));
  Object.assign(process.env, names);
  const payload = webhookPayload({
    eventId: "evt-sipcity-account",
    resourceId: "txn-sipcity-account",
    reference: "SIPCITY77GH",
    tillNumber: "3432381",
  });
  try {
    const configs = kopokopoConfigs();
    assert.equal(configs.length, 2);
    assert.equal(kopokopoConfigForBranch("b_cpt").accountId, "sipcity");
    assert.equal(kopokopoConfigForBranch("b_cpt").clientId, "sipcity-client-id");

    await signedWebhook(payload).expect(202).expect({ ok: true, ignored: true });
    await signedWebhook(payload, "sipcity-api-key").expect(200).expect({ ok: true, duplicate: false });
    const stored = await pool.query(
      "SELECT branch_id, till_number FROM kopokopo_transactions WHERE id = $1",
      [payload.event.resource.id]
    );
    assert.equal(stored.rows[0].branch_id, "b_cpt");
    assert.equal(stored.rows[0].till_number, "3432381");
  } finally {
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", [payload.event.resource.id]);
    await pool.query("DELETE FROM kopokopo_webhook_events WHERE event_id = $1", [payload.id]);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("stores a verified payment once and exposes only a branch-scoped masked lookup", async () => {
  const payload = webhookPayload();
  await signedWebhook(payload).expect(200).expect({ ok: true, duplicate: false });
  await signedWebhook(payload).expect(200).expect({ ok: true, duplicate: true });
  assert.equal(getLatestRealtimeEvent("kopokopo").branchId, "b_sip");
  assert.deepEqual(getLatestRealtimeEvent("kopokopo").types, ["kopokopoTransaction"]);

  await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip&last4=12CD")
    .expect(401);

  const lookup = await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip&last4=12CD")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(lookup.body.transactions.length, 1);
  assert.equal(lookup.body.transactions[0].referenceMasked, "****12CD");
  assert.equal(lookup.body.transactions[0].amountCents, 100000);
  assert.equal(lookup.body.transactions[0].remainingCents, 100000);
  assert.equal(lookup.body.transactions[0].providerVerified, true);
  assert.equal(lookup.body.providerRequired, true);
  assert.equal(lookup.body.transactions[0].payerName, "Test Customer");
  assert.equal(lookup.body.transactions[0].payerPhoneLast4, "0000");
  assert.equal(lookup.body.transactions[0].originationTime, "2026-08-02T07:00:00.000Z");
  assert.equal("reference" in lookup.body.transactions[0], false);
  assert.equal(JSON.stringify(lookup.body).includes("+254700000000"), false);

  const branchPolicy = await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(branchPolicy.body.providerRequired, true);
  assert.deepEqual(branchPolicy.body.transactions, []);

  const storedEvent = await pool.query("SELECT payload FROM kopokopo_webhook_events WHERE event_id = $1", [payload.id]);
  assert.equal(storedEvent.rows[0].payload.event.resource.sender_phone_number, undefined);
  assert.equal(storedEvent.rows[0].payload.event.resource.sender_first_name, undefined);

  const wrongBranch = await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_cpt&last4=12CD")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(wrongBranch.body.transactions.length, 0);

  await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_cpt&last4=12CD")
    .set("X-Session-Token", branchSessionToken)
    .expect(403)
    .expect({ error: "branch_not_authorized" });
});

test("enriches a received transaction when Kopo Kopo repeats the event with a verified payer name", async () => {
  const payload = webhookPayload({
    eventId: "evt-delayed-payer-name",
    resourceId: "txn-delayed-payer-name",
    reference: "DELAYEDNAME7K2P",
  });
  const firstPayload = structuredClone(payload);
  delete firstPayload.event.resource.sender_first_name;
  delete firstPayload.event.resource.sender_last_name;

  try {
    await signedWebhook(firstPayload).expect(200).expect({ ok: true, duplicate: false });
    const before = await pool.query(
      "SELECT amount_cents, payer_name FROM kopokopo_transactions WHERE id = $1",
      [payload.event.resource.id]
    );
    assert.equal(Number(before.rows[0].amount_cents), 100000);
    assert.equal(before.rows[0].payer_name, null);

    await signedWebhook(payload).expect(200).expect({ ok: true, duplicate: true });
    const after = await pool.query(
      "SELECT amount_cents, payer_name FROM kopokopo_transactions WHERE id = $1",
      [payload.event.resource.id]
    );
    assert.equal(Number(after.rows[0].amount_cents), 100000);
    assert.equal(after.rows[0].payer_name, "Test Customer");
  } finally {
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", [payload.event.resource.id]);
    await pool.query("DELETE FROM kopokopo_webhook_events WHERE event_id = $1", [payload.id]);
  }
});

test("lists a filtered, paginated, branch-scoped M-Pesa transaction ledger", async () => {
  await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip")
    .expect(401);

  const ledger = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip&search=customer&status=available&from=2026-08-02T00:00:00.000Z&to=2026-08-03T00:00:00.000Z&limit=1&offset=0")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(ledger.body.transactions.length, 1);
  assert.equal(ledger.body.transactions[0].referenceMasked, "****12CD");
  assert.equal(ledger.body.transactions[0].payerName, "Test Customer");
  assert.equal(ledger.body.transactions[0].payerPhoneLast4, "0000");
  assert.equal(ledger.body.transactions[0].amountCents, 100000);
  assert.equal(ledger.body.transactions[0].remainingCents, 100000);
  assert.equal("reference" in ledger.body.transactions[0], false);
  assert.deepEqual(ledger.body.page, { total: 1, limit: 1, offset: 0 });
  assert.deepEqual(ledger.body.summary, {
    amountCents: 100000,
    allocatedCents: 0,
    remainingCents: 100000,
    branches: [{ branchId: "b_sip", transactionCount: 1, amountCents: 100000, allocatedCents: 0, remainingCents: 100000 }],
  });

  const phoneSearch = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip&search=0000")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(phoneSearch.body.transactions.length, 1);
  assert.equal(phoneSearch.body.transactions[0].id, "txn-1");

  await pool.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, allocated_cents, currency, status, till_number, branch_id, payer_name, origination_time, reversed_at)
     VALUES ($1, $2, $3, $4, $5, 0, 'KES', 'Received', $6, $7, $8, $9, $10)`,
    ["txn-ledger-reversed", "evt-ledger-reversed", "REVERSED9XYZ", "9XYZ", 25000, "3018421", "b_sip", "Reversed Payer", "2026-08-02T09:00:00.000Z", "2026-08-02T09:05:00.000Z"]
  );
  try {
    const receivedLedger = await request(app)
      .get("/api/integrations/kopokopo/transactions?branchId=b_sip&status=received")
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(receivedLedger.body.transactions.length, 1);
    assert.equal(receivedLedger.body.transactions[0].id, "txn-1");
    assert.equal(receivedLedger.body.summary.amountCents, 100000);
  } finally {
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", ["txn-ledger-reversed"]);
  }

  const supervisorLedger = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip")
    .set("X-Session-Token", supervisorSessionToken)
    .expect(200);
  assert.equal(supervisorLedger.body.transactions.length, 1);

  const cashierLedger = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip")
    .set("X-Session-Token", cashierSessionToken)
    .expect(200);
  assert.equal(cashierLedger.body.transactions.length, 1);
  assert.equal(cashierLedger.body.transactions[0].branchId, "b_sip");

  await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=all")
    .set("X-Session-Token", cashierSessionToken)
    .expect(403)
    .expect({ error: "branch_not_authorized" });

  await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_cpt")
    .set("X-Session-Token", cashierSessionToken)
    .expect(403)
    .expect({ error: "branch_not_authorized" });

  await pool.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, allocated_cents, currency, status, till_number, branch_id, payer_name, origination_time)
     VALUES ($1, $2, $3, $4, $5, $6, 'KES', 'Received', $7, $8, $9, $10)`,
    ["txn-ledger-cpt", "evt-ledger-cpt", "CPTPAY34EF", "34EF", 50000, 10000, "3432381", "b_cpt", "Cape Payer", "2026-08-02T08:00:00.000Z"]
  );
  try {
    const allBranches = await request(app)
      .get("/api/integrations/kopokopo/transactions?branchId=all&from=2026-08-02T00:00:00.000Z&to=2026-08-03T00:00:00.000Z")
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(allBranches.body.branchId, "all");
    assert.equal(allBranches.body.page.total, 2);
    assert.deepEqual(allBranches.body.summary, {
      amountCents: 150000,
      allocatedCents: 10000,
      remainingCents: 140000,
      branches: [
        { branchId: "b_cpt", transactionCount: 1, amountCents: 50000, allocatedCents: 10000, remainingCents: 40000 },
        { branchId: "b_sip", transactionCount: 1, amountCents: 100000, allocatedCents: 0, remainingCents: 100000 },
      ],
    });

    const currentBusinessDay = await request(app)
      .get("/api/integrations/kopokopo/transactions")
      .query({
        branchId: "all",
        status: "received",
        branchStarts: JSON.stringify({
          b_cpt: "2026-08-02T07:30:00.000Z",
          b_sip: "2026-08-02T07:30:00.000Z",
        }),
      })
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(currentBusinessDay.body.page.total, 1);
    assert.equal(currentBusinessDay.body.transactions[0].id, "txn-ledger-cpt");
    assert.equal(currentBusinessDay.body.summary.amountCents, 50000);

    const closedBusinessDay = await request(app)
      .get("/api/integrations/kopokopo/transactions")
      .query({
        branchId: "all",
        status: "received",
        branchPeriods: JSON.stringify({
          b_cpt: { from: "2026-08-02T07:30:00.000Z", to: "2026-08-02T08:00:00.000Z" },
          b_sip: { from: "2026-08-02T07:00:00.000Z", to: "2026-08-02T09:00:00.000Z" },
        }),
      })
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(closedBusinessDay.body.page.total, 1);
    assert.equal(closedBusinessDay.body.transactions[0].id, "txn-ledger-cpt");
    assert.equal(closedBusinessDay.body.summary.amountCents, 50000);

    const branchClosedBusinessDay = await request(app)
      .get("/api/integrations/kopokopo/transactions")
      .query({
        branchId: "b_sip",
        branchPeriods: JSON.stringify({
          b_sip: { from: "2026-08-02T06:59:59.999Z", to: "2026-08-02T07:00:00.000Z" },
        }),
      })
      .set("X-Session-Token", cashierSessionToken)
      .expect(200);
    assert.equal(branchClosedBusinessDay.body.page.total, 1);
    assert.equal(branchClosedBusinessDay.body.transactions[0].id, "txn-1");

    await request(app)
      .get("/api/integrations/kopokopo/transactions")
      .query({
        branchId: "b_sip",
        branchPeriods: JSON.stringify({
          b_sip: { from: "2026-08-02T07:00:00.000Z", to: "2026-08-02T07:00:00.000Z" },
        }),
      })
      .set("X-Session-Token", sessionToken)
      .expect(400)
      .expect({ error: "invalid_kopokopo_transaction_dates" });

    await request(app)
      .get("/api/integrations/kopokopo/transactions")
      .query({
        branchId: "all",
        from: "2026-08-02T00:00:00.000Z",
        branchStarts: JSON.stringify({ b_cpt: "2026-08-02T07:30:00.000Z" }),
      })
      .set("X-Session-Token", sessionToken)
      .expect(400)
      .expect({ error: "invalid_kopokopo_transaction_dates" });

    await request(app)
      .get("/api/integrations/kopokopo/transactions?branchId=all")
      .set("X-Session-Token", supervisorSessionToken)
      .expect(403)
      .expect({ error: "branch_not_authorized" });
  } finally {
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", ["txn-ledger-cpt"]);
  }

  await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_cpt")
    .set("X-Session-Token", branchSessionToken)
    .expect(403)
    .expect({ error: "branch_not_authorized" });

  await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip&status=unknown")
    .set("X-Session-Token", sessionToken)
    .expect(400)
    .expect({ error: "invalid_kopokopo_transaction_filters" });
});

test("streams branch-scoped M-Pesa changes to an authenticated cashier", async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const controller = new AbortController();
  let reader;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sync/stream?sessionToken=${encodeURIComponent(cashierSessionToken)}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const connected = await reader.read();
    assert.match(decoder.decode(connected.value), /event: connected/);

    publishRealtimeEvent("kopokopo", {
      branchId: "b_sip",
      types: ["kopokopoTransaction"],
    });
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("cashier_realtime_timeout")), 2000)),
    ]);
    const eventText = decoder.decode(next.value);
    assert.match(eventText, /event: kopokopo/);
    assert.match(eventText, /"branchId":"b_sip"/);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stores signed polling callbacks instead of silently ignoring them", async () => {
  const payload = {
    data: {
      id: "polling-result-1",
      type: "polling",
      attributes: {
        status: "Success",
        created_at: "2026-08-02T11:01:00+03:00",
        transactions: [{
          type: "Buygoods Transaction",
          resource: {
            id: "callback-poll-transaction",
            amount: "275.50",
            status: "Received",
            currency: "KES",
            reference: "CALLBACK5678",
            till_number: "000000",
            sender_phone_number: "+254711111111",
            sender_first_name: "Callback",
            sender_last_name: "Customer",
            origination_time: "2026-08-02T11:00:00+03:00",
          },
        }, {
          type: "External Till to Till Transaction",
          resource: { id: "callback-ignored-b2b", status: "Complete" },
        }],
      },
    },
  };

  const response = await signedWebhook(payload).expect(200);
  assert.deepEqual(response.body, {
    ok: true,
    kind: "polling",
    received: 2,
    stored: 1,
    duplicates: 0,
    ignored: 1,
  });
  await signedWebhook(payload).expect(200).expect((result) => {
    assert.equal(result.body.stored, 0);
    assert.equal(result.body.duplicates, 1);
  });

  const stored = await pool.query(
    "SELECT reference_last4, amount_cents, payer_name, payer_phone_last4 FROM kopokopo_transactions WHERE id = $1",
    ["callback-poll-transaction"]
  );
  assert.equal(stored.rows[0].reference_last4, "5678");
  assert.equal(Number(stored.rows[0].amount_cents), 27550);
  assert.equal(stored.rows[0].payer_name, "Callback Customer");
  assert.equal(stored.rows[0].payer_phone_last4, "1111");

  const audit = await pool.query(
    "SELECT payload FROM kopokopo_webhook_events WHERE event_id = $1",
    ["poll:callback-poll-transaction:received"]
  );
  assert.equal(audit.rows[0].payload.event.resource.sender_phone_number, undefined);
  assert.equal(audit.rows[0].payload.event.resource.sender_first_name, undefined);
});

test("stores signed incoming-payment callbacks through the shared ledger", async () => {
  const payload = {
    data: {
      id: "incoming-request-1",
      type: "incoming_payment",
      attributes: {
        status: "Success",
        created_at: "2026-08-02T11:31:00+03:00",
        event: {
          type: "Incoming Payment Request",
          resource: {
            id: "incoming-callback-transaction",
            amount: "125.00",
            status: "Received",
            currency: "KES",
            reference: "INCOMING4321",
            till_number: "000000",
            sender_first_name: "Incoming",
            sender_last_name: "Customer",
            origination_time: "2026-08-02T11:30:00+03:00",
          },
        },
      },
    },
  };

  await signedWebhook(payload).expect(200).expect((response) => {
    assert.equal(response.body.kind, "incoming_payment");
    assert.equal(response.body.stored, 1);
  });
  const stored = await pool.query(
    "SELECT reference_last4, amount_cents, payer_name FROM kopokopo_transactions WHERE id = $1",
    ["incoming-callback-transaction"]
  );
  assert.equal(stored.rows[0].reference_last4, "4321");
  assert.equal(Number(stored.rows[0].amount_cents), 12500);
  assert.equal(stored.rows[0].payer_name, "Incoming Customer");
});

test("recovers an accepted incoming payment from its authenticated status without duplicating a late webhook", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const providerLocation = "https://sandbox.kopokopo.com/api/v2/incoming_payments/recovery-request-1";
  const providerResource = {
    id: "status-recovery-transaction",
    amount: "125.00",
    status: "Received",
    currency: "KES",
    reference: "RECOVERY9Z8Y",
    till_number: "000000",
    sender_phone_number: "+254711111111",
    sender_first_name: "Recovery",
    sender_last_name: "Customer",
    origination_time: "2026-08-02T11:45:00+03:00",
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/incoming_payments") && options.method === "POST") {
      return new Response("", { status: 201, headers: { Location: providerLocation } });
    }
    assert.equal(String(url), providerLocation);
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    return new Response(JSON.stringify({
      data: {
        type: "incoming_payment",
        attributes: {
          status: "Received",
          event: { type: "Incoming Payment Request", resource: providerResource },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const payload = {
    idempotencyKey: "invoice-settlement-recovery-1",
    branchId: "b_sip",
    tillNumber: "999999",
    amountCents: 12500,
    phoneNumber: "+254711111111",
    firstName: "Recovery",
    lastName: "Customer",
    reference: "INV-RECOVERY-1",
  };
  try {
    const created = await request(app)
      .post("/api/integrations/kopokopo/incoming-payments")
      .set("X-Session-Token", sessionToken)
      .send(payload)
      .expect(202);
    assert.equal(created.body.duplicate, false);
    assert.equal(created.body.request.status, "pending");
    assert.equal("providerLocation" in created.body.request, false);
    const requestId = created.body.request.id;

    const duplicate = await request(app)
      .post("/api/integrations/kopokopo/incoming-payments")
      .set("X-Session-Token", sessionToken)
      .send(payload)
      .expect(200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.request.id, requestId);
    assert.equal(calls.filter((entry) => entry.url.endsWith("/api/v2/incoming_payments")).length, 1);

    await request(app)
      .post("/api/integrations/kopokopo/incoming-payments")
      .set("X-Session-Token", sessionToken)
      .send({ ...payload, amountCents: 12600 })
      .expect(409)
      .expect(({ body }) => assert.equal(body.error, "kopokopo_idempotency_key_reused"));
    assert.equal(calls.filter((entry) => entry.url.endsWith("/api/v2/incoming_payments")).length, 1);

    const requestBody = JSON.parse(calls.find((entry) => entry.url.endsWith("/api/v2/incoming_payments")).options.body);
    assert.equal(requestBody.amount.value, 125);
    assert.equal(requestBody.till_number, "000000");
    assert.equal(requestBody._links.callback_url, process.env.KOPOKOPO_WEBHOOK_URL);

    const recovered = await request(app)
      .get(`/api/integrations/kopokopo/incoming-payments/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(recovered.body.request.status, "completed");
    assert.equal(recovered.body.request.providerTransactionId, providerResource.id);
    assert.equal("providerLocation" in recovered.body.request, false);
    assert.equal(recovered.body.transaction.referenceLast4, "9Z8Y");
    assert.equal(recovered.body.transaction.amountCents, 12500);
    assert.equal(recovered.body.transaction.payerName, "Recovery Customer");
    assert.equal(recovered.body.transaction.payerPhoneLast4, "1111");
    assert.equal(calls.filter((entry) => entry.url.endsWith("/oauth/token")).length, 1);

    const ledgerRows = await pool.query(
      "SELECT id, reference_last4, amount_cents, payer_name, payer_phone_last4 FROM kopokopo_transactions WHERE id = $1",
      [providerResource.id]
    );
    assert.equal(ledgerRows.rows.length, 1);
    assert.equal(ledgerRows.rows[0].reference_last4, "9Z8Y");
    assert.equal(Number(ledgerRows.rows[0].amount_cents), 12500);
    assert.equal(ledgerRows.rows[0].payer_name, "Recovery Customer");
    assert.equal(ledgerRows.rows[0].payer_phone_last4, "1111");

    const requestRows = await pool.query(
      "SELECT * FROM kopokopo_incoming_payment_requests WHERE id = $1",
      [requestId]
    );
    assert.equal("phone_number" in requestRows.rows[0], false);

    const lateWebhook = {
      topic: "buygoods_transaction_received",
      id: "late-recovery-webhook",
      created_at: "2026-08-02T11:45:02+03:00",
      event: { type: "Buygoods Transaction", resource: providerResource },
    };
    await signedWebhook(lateWebhook).expect(200);
    const afterWebhook = await pool.query(
      "SELECT COUNT(*) AS count FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2",
      [providerResource.id, providerResource.reference]
    );
    assert.equal(Number(afterWebhook.rows[0].count), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps a successful STK request pending until Kopo Kopo supplies the verified payer name", async () => {
  const originalFetch = globalThis.fetch;
  const providerLocation = "https://sandbox.kopokopo.com/api/v2/incoming_payments/delayed-name-request";
  const providerResource = {
    id: "delayed-name-status-transaction",
    amount: "75.00",
    status: "Received",
    currency: "KES",
    reference: "DELAYEDSTK4N8Q",
    till_number: "000000",
    sender_phone_number: "+254722222222",
    origination_time: "2026-08-04T10:15:00+03:00",
  };
  let statusReads = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "delayed-name-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/incoming_payments") && options.method === "POST") {
      return new Response("", { status: 201, headers: { Location: providerLocation } });
    }
    assert.equal(String(url), providerLocation);
    statusReads += 1;
    const resource = statusReads > 1
      ? { ...providerResource, sender_first_name: "Verified", sender_last_name: "Holder" }
      : providerResource;
    return new Response(JSON.stringify({
      data: {
        type: "incoming_payment",
        attributes: {
          status: "Received",
          event: { type: "Incoming Payment Request", resource },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  let requestId = "";
  try {
    const created = await request(app)
      .post("/api/integrations/kopokopo/incoming-payments")
      .set("X-Session-Token", sessionToken)
      .send({
        idempotencyKey: "invoice-settlement-delayed-name",
        branchId: "b_sip",
        amountCents: 7500,
        phoneNumber: "+254722222222",
        firstName: "Typed",
        lastName: "Customer",
        reference: "INV-DELAYED-NAME",
      })
      .expect(202);
    requestId = created.body.request.id;

    const firstCheck = await request(app)
      .get(`/api/integrations/kopokopo/incoming-payments/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(firstCheck.body.request.status, "pending");
    assert.equal(firstCheck.body.transaction, null);

    const firstStored = await pool.query(
      "SELECT amount_cents, payer_name FROM kopokopo_transactions WHERE id = $1",
      [providerResource.id]
    );
    assert.equal(Number(firstStored.rows[0].amount_cents), 7500);
    assert.equal(firstStored.rows[0].payer_name, null);

    await pool.query(
      "UPDATE kopokopo_incoming_payment_requests SET next_check_at = $2 WHERE id = $1",
      [requestId, new Date(Date.now() - 1000)]
    );
    const completed = await request(app)
      .get(`/api/integrations/kopokopo/incoming-payments/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(completed.body.request.status, "completed");
    assert.equal(completed.body.transaction.payerName, "Verified Holder");
    assert.notEqual(completed.body.transaction.payerName, "Typed Customer");
    assert.equal(completed.body.transaction.amountCents, 7500);
  } finally {
    globalThis.fetch = originalFetch;
    if (requestId) await pool.query("DELETE FROM kopokopo_incoming_payment_requests WHERE id = $1", [requestId]);
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", [providerResource.id]);
    await pool.query("DELETE FROM kopokopo_webhook_events WHERE resource_id = $1", [providerResource.id]);
  }
});

test("lets only administrators run an isolated sandbox payment test and removes its ledger data", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const providerLocation = "https://sandbox.kopokopo.com/api/v2/incoming_payments/admin-sandbox-test-1";
  const providerResource = {
    id: "admin-sandbox-test-transaction",
    amount: "10.00",
    status: "Received",
    currency: "KES",
    reference: "ADMINTESTABCD",
    till_number: "000000",
    sender_first_name: "Admin",
    sender_last_name: "Sandbox",
    origination_time: "2026-08-02T12:00:00+03:00",
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "sandbox-admin-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/incoming_payments") && options.method === "POST") {
      return new Response("", { status: 201, headers: { Location: providerLocation } });
    }
    assert.equal(String(url), providerLocation);
    return new Response(JSON.stringify({
      data: {
        type: "incoming_payment",
        attributes: {
          status: "Received",
          event: { type: "Incoming Payment Request", resource: providerResource },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .send({ phoneNumber: "+254999999999", amountCents: 1000 })
      .expect(401);
    await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .set("X-Session-Token", branchSessionToken)
      .send({ phoneNumber: "+254999999999", amountCents: 1000 })
      .expect(403);

    const created = await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .set("X-Session-Token", sessionToken)
      .send({ phoneNumber: "+254999999999", amountCents: 1000, branchId: "b_cpt" })
      .expect(202);
    assert.equal(created.body.branchId, "b_sip");
    assert.equal(created.body.request.branchId, "b_sip");
    assert.equal(created.body.request.amountCents, 1000);

    const providerBody = JSON.parse(calls.find((entry) => entry.url.endsWith("/api/v2/incoming_payments")).options.body);
    assert.equal(providerBody._links.callback_url, "https://visionarypos.cloud/api/integrations/kopokopo/sandbox-test-webhook");
    assert.equal(providerBody.amount.value, 10);

    const checked = await request(app)
      .get(`/api/integrations/kopokopo/sandbox-tests/${created.body.request.id}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(checked.body.request.status, "completed");
    assert.equal(checked.body.transaction.referenceMasked, "****ABCD");
    assert.equal(checked.body.transaction.payerName, "Admin Sandbox");
    assert.equal(checked.body.transaction.status, "SandboxTest");

    const lookup = await request(app)
      .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip&last4=ABCD")
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(lookup.body.transactions.length, 0);
    await request(app)
      .post("/api/integrations/kopokopo/allocations")
      .set("X-Session-Token", sessionToken)
      .send({
        transactionId: providerResource.id,
        branchId: "b_sip",
        idempotencyKey: "sandbox-test-allocation-refused",
        allocations: [{ invoiceId: "inv-1", localPaymentId: "sandbox-test-payment-refused", amountCents: 1000 }],
      })
      .expect(409)
      .expect(({ body }) => assert.equal(body.error, "kopokopo_transaction_unavailable"));

    const stored = await pool.query(
      "SELECT webhook_event_id FROM kopokopo_transactions WHERE id = $1",
      [providerResource.id]
    );
    assert.equal(stored.rows.length, 1);
    const webhookEventId = stored.rows[0].webhook_event_id;

    await request(app)
      .delete(`/api/integrations/kopokopo/sandbox-tests/${created.body.request.id}`)
      .set("X-Session-Token", sessionToken)
      .expect(200)
      .expect({ removed: true });

    const remainingRequest = await pool.query(
      "SELECT id FROM kopokopo_incoming_payment_requests WHERE id = $1",
      [created.body.request.id]
    );
    const remainingTransaction = await pool.query(
      "SELECT id FROM kopokopo_transactions WHERE id = $1",
      [providerResource.id]
    );
    const remainingEvent = await pool.query(
      "SELECT event_id FROM kopokopo_webhook_events WHERE event_id = $1",
      [webhookEventId]
    );
    assert.equal(remainingRequest.rows.length, 0);
    assert.equal(remainingTransaction.rows.length, 0);
    assert.equal(remainingEvent.rows.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const callback = webhookPayload({
    eventId: "admin-sandbox-noop-event",
    resourceId: "admin-sandbox-noop-transaction",
  });
  const rawBody = JSON.stringify(callback);
  const signature = crypto.createHmac("sha256", process.env.KOPOKOPO_API_KEY).update(rawBody).digest("hex");
  await request(app)
    .post("/api/integrations/kopokopo/sandbox-test-webhook")
    .set("Content-Type", "application/json")
    .set("X-KopoKopo-Signature", signature)
    .send(rawBody)
    .expect(200)
    .expect({ ok: true, test: true });
  const ignoredCallback = await pool.query(
    "SELECT id FROM kopokopo_transactions WHERE id = $1",
    ["admin-sandbox-noop-transaction"]
  );
  assert.equal(ignoredCallback.rows.length, 0);
});

test("allocates a sandbox payment only to its temporary invoice and removes every test record", async () => {
  const originalFetch = globalThis.fetch;
  const providerLocation = "https://sandbox.kopokopo.com/api/v2/incoming_payments/admin-allocation-test-1";
  const providerResource = {
    id: "admin-allocation-test-transaction",
    amount: "10.00",
    status: "Received",
    currency: "KES",
    reference: "ALLOCATION5678",
    till_number: "000000",
    sender_first_name: "Allocation",
    sender_last_name: "Sandbox",
    origination_time: "2026-08-02T12:10:00+03:00",
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "sandbox-allocation-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/incoming_payments") && options.method === "POST") {
      return new Response("", { status: 201, headers: { Location: providerLocation } });
    }
    assert.equal(String(url), providerLocation);
    return new Response(JSON.stringify({
      data: {
        type: "incoming_payment",
        attributes: {
          status: "Received",
          event: { type: "Incoming Payment Request", resource: providerResource },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .set("X-Session-Token", sessionToken)
      .send({ phoneNumber: "+254999999999", amountCents: 1000, testType: "unknown" })
      .expect(400)
      .expect({ error: "invalid_kopokopo_sandbox_test_type" });

    const created = await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .set("X-Session-Token", sessionToken)
      .send({ phoneNumber: "+254999999999", amountCents: 1000, testType: "allocation", branchId: "b_cpt" })
      .expect(202);
    assert.equal(created.body.request.testType, "allocation");
    assert.equal(created.body.request.branchId, "b_sip");
    const requestId = created.body.request.id;
    const invoiceId = `sandbox-invoice:${requestId}`;

    const exposedInvoice = await pool.query(
      "SELECT id FROM events WHERE id = $1 AND type = 'invoice'",
      [invoiceId]
    );
    assert.equal(exposedInvoice.rows.length, 0);

    const checked = await request(app)
      .get(`/api/integrations/kopokopo/sandbox-tests/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(checked.body.request.testType, "allocation");
    assert.equal(checked.body.transaction.status, "SandboxTest");
    assert.equal(checked.body.transaction.allocatedCents, 1000);
    assert.equal(checked.body.transaction.remainingCents, 0);
    assert.equal(checked.body.allocationTest.invoiceId, invoiceId);
    assert.equal(checked.body.allocationTest.allocatedCents, 1000);
    assert.equal(checked.body.allocationTest.invoiceBalanceCents, 0);
    assert.equal(checked.body.allocationTest.verified, true);

    const rechecked = await request(app)
      .get(`/api/integrations/kopokopo/sandbox-tests/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(rechecked.body.transaction.allocatedCents, 1000);
    assert.equal(rechecked.body.allocationTest.allocationId, checked.body.allocationTest.allocationId);

    const storedAllocation = await pool.query(
      "SELECT invoice_id, amount_cents, local_payment_id, status FROM kopokopo_allocations WHERE transaction_id = $1",
      [providerResource.id]
    );
    assert.equal(storedAllocation.rows.length, 1);
    assert.equal(storedAllocation.rows[0].invoice_id, invoiceId);
    assert.equal(Number(storedAllocation.rows[0].amount_cents), 1000);
    assert.equal(storedAllocation.rows[0].status, "active");

    const storedTransaction = await pool.query(
      "SELECT webhook_event_id FROM kopokopo_transactions WHERE id = $1",
      [providerResource.id]
    );
    const webhookEventId = storedTransaction.rows[0].webhook_event_id;

    await request(app)
      .delete(`/api/integrations/kopokopo/sandbox-tests/${requestId}`)
      .set("X-Session-Token", sessionToken)
      .expect(200)
      .expect({ removed: true });

    for (const [sql, value] of [
      ["SELECT id FROM kopokopo_incoming_payment_requests WHERE id = $1", requestId],
      ["SELECT id FROM kopokopo_transactions WHERE id = $1", providerResource.id],
      ["SELECT id FROM kopokopo_allocations WHERE transaction_id = $1", providerResource.id],
      ["SELECT id FROM events WHERE id = $1 AND type = 'invoice'", invoiceId],
      ["SELECT event_id FROM kopokopo_webhook_events WHERE event_id = $1", webhookEventId],
    ]) {
      const remaining = await pool.query(sql, [value]);
      assert.equal(remaining.rows.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the admin sandbox tester unavailable in live mode", async () => {
  const originalMode = process.env.KOPOKOPO_MODE;
  process.env.KOPOKOPO_MODE = "live";
  try {
    await request(app)
      .post("/api/integrations/kopokopo/sandbox-tests")
      .set("X-Session-Token", sessionToken)
      .send({ phoneNumber: "+254999999999", amountCents: 1000 })
      .expect(409)
      .expect({ error: "kopokopo_sandbox_test_unavailable" });
  } finally {
    process.env.KOPOKOPO_MODE = originalMode;
  }
});

test("uses separate official production OAuth and API hosts", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const liveConfig = {
    ...kopokopoConfig(),
    mode: "live",
    baseUrl: "https://api.kopokopo.com",
    authUrl: "https://app.kopokopo.com",
    tillBranchMap: { "1234567": "b_sip" },
    sandboxBranchId: "",
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url) === "https://app.kopokopo.com/oauth/token") {
      return new Response(JSON.stringify({ access_token: "live-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(String(url), "https://api.kopokopo.com/api/v2/incoming_payments");
    return new Response("", {
      status: 201,
      headers: { Location: "https://api.kopokopo.com/api/v2/incoming_payments/live-request-1" },
    });
  };

  try {
    assert.equal(await requestKopokopoAccessToken(liveConfig), "live-access-token");
    const payment = await requestKopokopoIncomingPayment({
      tillNumber: "1234567",
      phoneNumber: "+254712345678",
      amountCents: 1000,
      reference: "RCP-SIP-TEST",
    }, liveConfig);
    assert.equal(payment.providerRequestId, "live-request-1");
    assert.deepEqual(calls.map((entry) => entry.url), [
      "https://app.kopokopo.com/oauth/token",
      "https://api.kopokopo.com/api/v2/incoming_payments",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes a cached Kopo Kopo access token once after an unauthorized response", async () => {
  const originalFetch = globalThis.fetch;
  const liveConfig = {
    ...kopokopoConfig(),
    mode: "live",
    baseUrl: "https://api.kopokopo.com",
    authUrl: "https://app.kopokopo.com",
  };
  const location = "https://api.kopokopo.com/api/v2/incoming_payments/live-request-2";
  let tokenRequests = 0;
  let statusRequests = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://app.kopokopo.com/oauth/token") {
      tokenRequests += 1;
      return new Response(JSON.stringify({
        access_token: `live-access-token-${tokenRequests}`,
        expires_in: 3_600,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    assert.equal(String(url), location);
    statusRequests += 1;
    assert.equal(options.headers.Authorization, `Bearer live-access-token-${statusRequests}`);
    if (statusRequests === 1) return new Response("", { status: 401 });
    return new Response(JSON.stringify({ data: { attributes: { status: "Received" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.equal(await requestKopokopoAccessToken(liveConfig), "live-access-token-1");
    assert.deepEqual(await readKopokopoIncomingPayment(location, liveConfig), { status: "Received" });
    assert.equal(await requestKopokopoAccessToken(liveConfig), "live-access-token-2");
    assert.equal(tokenRequests, 2);
    assert.equal(statusRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checks healthy pending Kopo Kopo prompts frequently without aggressive backoff", () => {
  assert.equal(pendingCheckDelayMs(1), 2_000);
  assert.equal(pendingCheckDelayMs(10), 2_000);
  assert.equal(pendingCheckDelayMs(11), 5_000);
  assert.equal(pendingCheckDelayMs(30), 5_000);
  assert.equal(pendingCheckDelayMs(31), 10_000);
});

test("recovers a sandbox result without a simulated M-Pesa reference and supports amount objects", async () => {
  const resourceId = "sandbox-result-without-reference-9z8y";
  const result = await ingestKopokopoIncomingPaymentStatus({
    status: "Success",
    event: {
      type: "Incoming Payment Request",
      resource: {
        id: resourceId,
        amount: { currency: "KES", value: "125.00" },
        status: "Received",
        till_number: "000000",
        sender_first_name: "Sandbox",
        sender_last_name: "Customer",
        origination_time: "2026-08-02T11:48:00+03:00",
      },
    },
  }, {
    branchId: "b_sip",
    tillNumber: "000000",
    amountCents: 12500,
  }, kopokopoConfig());

  assert.equal(result.pending, false);
  assert.equal(result.transactionId, resourceId);
  const stored = await pool.query(
    "SELECT reference, reference_last4, amount_cents FROM kopokopo_transactions WHERE id = $1",
    [resourceId]
  );
  assert.equal(stored.rows[0].reference, "SANDBOXSANDBOXRESULTWITHOUTREFERENCE9Z8Y");
  assert.equal(stored.rows[0].reference_last4, "9Z8Y");
  assert.equal(Number(stored.rows[0].amount_cents), 12500);
});

test("still rejects a production payment result without a genuine provider reference", async () => {
  const attributes = {
    status: "Success",
    event: {
      type: "Incoming Payment Request",
      resource: {
        id: "production-result-without-reference",
        amount: "125.00",
        currency: "KES",
        status: "Received",
        till_number: "000000",
      },
    },
  };
  const liveConfig = {
    ...kopokopoConfig(),
    mode: "live",
    sandboxBranchId: "",
    tillBranchMap: { "000000": "b_sip" },
  };
  await assert.rejects(
    ingestKopokopoIncomingPaymentStatus(attributes, {
      branchId: "b_sip",
      tillNumber: "000000",
      amountCents: 12500,
    }, liveConfig),
    (error) => error.message === "invalid_kopokopo_incoming_payment_result"
      && error.providerMessage.includes('"hasReference":false')
  );
  const stored = await pool.query(
    "SELECT id FROM kopokopo_transactions WHERE id = $1",
    [attributes.event.resource.id]
  );
  assert.equal(stored.rows.length, 0);
});

test("fails closed when the authenticated incoming-payment result does not match the requested amount", async () => {
  const originalFetch = globalThis.fetch;
  const providerLocation = "https://sandbox.kopokopo.com/api/v2/incoming_payments/mismatched-request-1";
  const transactionId = "mismatched-status-transaction";
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/incoming_payments") && options.method === "POST") {
      return new Response("", { status: 201, headers: { Location: providerLocation } });
    }
    assert.equal(String(url), providerLocation);
    return new Response(JSON.stringify({
      data: {
        type: "incoming_payment",
        attributes: {
          status: "Received",
          event: {
            type: "Incoming Payment Request",
            resource: {
              id: transactionId,
              amount: "124.99",
              status: "Received",
              currency: "KES",
              reference: "MISMATCH1234",
              till_number: "000000",
              origination_time: "2026-08-02T11:50:00+03:00",
            },
          },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const created = await request(app)
      .post("/api/integrations/kopokopo/incoming-payments")
      .set("X-Session-Token", sessionToken)
      .send({
        idempotencyKey: "invoice-settlement-mismatch-1",
        branchId: "b_sip",
        tillNumber: "000000",
        amountCents: 12500,
        phoneNumber: "+254711111111",
        reference: "INV-MISMATCH-1",
      })
      .expect(202);

    const checked = await request(app)
      .get(`/api/integrations/kopokopo/incoming-payments/${created.body.request.id}`)
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(checked.body.request.status, "failed");

    const ledgerRows = await pool.query("SELECT id FROM kopokopo_transactions WHERE id = $1", [transactionId]);
    assert.equal(ledgerRows.rows.length, 0);
    const requestRows = await pool.query(
      "SELECT status, last_error, next_check_at FROM kopokopo_incoming_payment_requests WHERE id = $1",
      [created.body.request.id]
    );
    assert.equal(requestRows.rows[0].status, "failed");
    assert.equal(requestRows.rows[0].last_error, "kopokopo_result_amount_mismatch");
    assert.equal(requestRows.rows[0].next_check_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires an authenticated supervisor or administrator to create incoming payments", async () => {
  await request(app)
    .post("/api/integrations/kopokopo/incoming-payments")
    .send({})
    .expect(401);
});

test("rejects incoming-payment status resources outside Kopo Kopo before making a request", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("unexpected_fetch");
  };
  try {
    await assert.rejects(
      readKopokopoIncomingPayment(
        "https://example.com/api/v2/incoming_payments/stolen",
        kopokopoConfig(),
        "test-access-token"
      ),
      /kopokopo_resource_location_invalid/
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("polls the official provider endpoint using the configured company scope", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const progress = [];
  const polledTransaction = {
    type: "Buygoods Transaction",
    resource: {
      id: "provider-poll-transaction",
      amount: "125.00",
      status: "Received",
      currency: "KES",
      reference: "POLLAPI4321",
      till_number: "000000",
      origination_time: "2026-08-02T11:00:00+03:00",
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/v2/polling") && options.method === "POST") {
      return new Response("", {
        status: 201,
        headers: { Location: "https://sandbox.kopokopo.com/api/v2/polling/poll-request-1" },
      });
    }
    return new Response(JSON.stringify({
      data: {
        attributes: {
          status: "Success",
          transactions: [polledTransaction],
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = {
      ...kopokopoConfig(),
      clientId: "poll-client-id",
      clientSecret: "poll-client-secret",
      scope: "company",
      scopeReference: "",
    };
    const result = await pollKopokopoTransactions({
      fromTime: "2026-08-02T07:00:00.000Z",
      toTime: "2026-08-02T08:00:00.000Z",
      onProgress: (entry) => progress.push(entry),
    }, config);
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].resource.id, "provider-poll-transaction");
    assert.equal(calls.length, 3);
    const requestBody = JSON.parse(calls[1].options.body);
    assert.equal(requestBody.scope, "company");
    assert.equal(requestBody.scope_reference, "");
    assert.equal(requestBody._links.callback_url, process.env.KOPOKOPO_WEBHOOK_URL);
    assert.equal(calls[2].url, "https://sandbox.kopokopo.com/api/v2/polling/poll-request-1");
    assert.deepEqual(progress.map((entry) => entry.status), ["Accepted", "Success"]);
    assert.ok(progress.every((entry) => entry.providerResourceId === "poll-request-1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a polling resource location outside the configured provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(options.method, "POST");
    return new Response("", {
      status: 201,
      headers: { Location: "https://example.com/api/v2/polling/stolen-token" },
    });
  };
  try {
    await assert.rejects(
      pollKopokopoTransactions({
        fromTime: "2026-08-02T07:00:00.000Z",
        toTime: "2026-08-02T08:00:00.000Z",
      }, {
        ...kopokopoConfig(),
        clientId: "poll-client-id",
        clientSecret: "poll-client-secret",
      }),
      /kopokopo_resource_location_invalid/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("polling recovery stores missing Buygoods transactions once and redacts its audit payload", async () => {
  const transactions = [
    {
      type: "Buygoods Transaction",
      resource: {
        id: "poll-recovery-transaction",
        amount: "275.50",
        status: "Received",
        system: "Lipa Na M-PESA",
        currency: "KES",
        reference: "POLLREC1234",
        till_number: "000000",
        sender_phone_number: "+254711111111",
        sender_first_name: "Polling",
        sender_last_name: "Customer",
        origination_time: "2026-08-02T12:00:00+03:00",
      },
    },
    {
      type: "External Till to Till Transaction",
      resource: { id: "ignored-poll-transaction" },
    },
  ];
  const first = await ingestKopokopoPollingTransactions(transactions);
  assert.deepEqual(first, { received: 2, stored: 1, duplicates: 0, ignored: 1 });
  const second = await ingestKopokopoPollingTransactions(transactions);
  assert.deepEqual(second, { received: 2, stored: 0, duplicates: 1, ignored: 1 });

  const stored = await pool.query(
    "SELECT reference_last4, amount_cents, branch_id, payer_name, payer_phone_last4, status FROM kopokopo_transactions WHERE id = $1",
    ["poll-recovery-transaction"]
  );
  assert.equal(stored.rows[0].reference_last4, "1234");
  assert.equal(Number(stored.rows[0].amount_cents), 27550);
  assert.equal(stored.rows[0].branch_id, "b_sip");
  assert.equal(stored.rows[0].payer_name, "Polling Customer");
  assert.equal(stored.rows[0].payer_phone_last4, "1111");
  assert.equal(stored.rows[0].status, "Received");

  const audit = await pool.query(
    "SELECT payload FROM kopokopo_webhook_events WHERE event_id = $1",
    ["poll:poll-recovery-transaction:received"]
  );
  assert.equal(audit.rows[0].payload.event.resource.sender_phone_number, undefined);
  assert.equal(audit.rows[0].payload.event.resource.sender_first_name, undefined);
});

test("polling recovery applies a provider reversal through the existing ledger controls", async () => {
  const received = {
    type: "Buygoods Transaction",
    resource: {
      id: "poll-reversed-transaction",
      amount: "50.00",
      status: "Received",
      currency: "KES",
      reference: "POLLREV9876",
      till_number: "000000",
      origination_time: "2026-08-02T12:30:00+03:00",
    },
  };
  await ingestKopokopoPollingTransactions([received]);
  await ingestKopokopoPollingTransactions([{
    ...received,
    resource: { ...received.resource, status: "Reversed" },
  }]);
  const stored = await pool.query(
    "SELECT status, reversed_at FROM kopokopo_transactions WHERE id = $1",
    ["poll-reversed-transaction"]
  );
  assert.equal(stored.rows[0].status, "Reversed");
  assert.ok(stored.rows[0].reversed_at);
});

test("allocates atomically, rejects excess, and makes retries idempotent", async () => {
  const allocationRequest = {
    transactionId: "txn-1",
    branchId: "b_sip",
    idempotencyKey: "settlement-batch-1",
    allocations: [
      { invoiceId: "inv-1", amountCents: 30000, localPaymentId: "pay-1" },
      { invoiceId: "inv-2", amountCents: 20000, localPaymentId: "pay-2" },
    ],
  };
  await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", cashierSessionToken)
    .send(allocationRequest)
    .expect(403)
    .expect({ error: "insufficient_role" });

  const allocated = await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send(allocationRequest)
    .expect(200);
  assert.equal(allocated.body.duplicate, false);
  assert.equal(allocated.body.transaction.remainingCents, 50000);
  assert.equal(getLatestRealtimeEvent("kopokopo").branchId, "b_sip");
  assert.deepEqual(getLatestRealtimeEvent("kopokopo").types, ["kopokopoAllocation"]);

  const ledger = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  const ledgerTransaction = ledger.body.transactions.find((transaction) => transaction.id === "txn-1");
  assert.ok(ledgerTransaction);
  assert.deepEqual(ledgerTransaction.allocations.map((allocation) => ({
    invoiceId: allocation.invoiceId,
    invoiceNumber: allocation.invoiceNumber,
    amountCents: allocation.amountCents,
    allocatedByName: allocation.allocatedByName,
  })).sort((left, right) => left.invoiceId.localeCompare(right.invoiceId)), [
    { invoiceId: "inv-1", invoiceNumber: "RCP-SIP-000001", amountCents: 30000, allocatedByName: "Kopo Admin" },
    { invoiceId: "inv-2", invoiceNumber: "RCP-SIP-000002", amountCents: 20000, allocatedByName: "Kopo Admin" },
  ]);
  assert.ok(ledgerTransaction.allocations.every((allocation) => allocation.allocatedAt));

  const receiptSearch = await request(app)
    .get("/api/integrations/kopokopo/transactions?branchId=b_sip&search=0002")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(receiptSearch.body.transactions.length, 1);
  assert.equal(receiptSearch.body.transactions[0].id, "txn-1");
  assert.ok(receiptSearch.body.transactions[0].allocations.some((allocation) => allocation.invoiceNumber === "RCP-SIP-000002"));

  const retried = await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send(allocationRequest)
    .expect(200);
  assert.equal(retried.body.duplicate, true);
  assert.equal(retried.body.transaction.remainingCents, 50000);

  const excess = await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send({
      transactionId: "txn-1",
      branchId: "b_sip",
      idempotencyKey: "settlement-batch-2",
      allocations: [{ invoiceId: "inv-3", amountCents: 50001, localPaymentId: "pay-3" }],
    })
    .expect(409);
  assert.equal(excess.body.error, "kopokopo_amount_exceeds_balance");
  assert.equal(excess.body.remainingCents, 50000);
});

test("rejects allocations for missing, cross-branch, or overpaid invoices", async () => {
  await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send({
      transactionId: "txn-1",
      branchId: "b_sip",
      idempotencyKey: "missing-invoice-batch",
      allocations: [{ invoiceId: "invoice-does-not-exist", amountCents: 100, localPaymentId: "missing-pay" }],
    })
    .expect(409)
    .expect((response) => assert.equal(response.body.error, "kopokopo_invoice_not_found"));

  await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send({
      transactionId: "txn-1",
      branchId: "b_sip",
      idempotencyKey: "cross-branch-invoice-batch",
      allocations: [{ invoiceId: "inv-cpt", amountCents: 100, localPaymentId: "cross-branch-pay" }],
    })
    .expect(409)
    .expect((response) => assert.equal(response.body.error, "kopokopo_invoice_branch_mismatch"));

  await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send({
      transactionId: "txn-1",
      branchId: "b_sip",
      idempotencyKey: "overpaid-invoice-batch",
      allocations: [{ invoiceId: "inv-1", amountCents: 1, localPaymentId: "overpaid-pay" }],
    })
    .expect(409)
    .expect((response) => {
      assert.equal(response.body.error, "kopokopo_invoice_balance_exceeded");
      assert.equal(response.body.invoiceRemainingCents, 0);
    });
});

test("offsets cash deposited to till without turning it into another invoice payment", async () => {
  const transactionId = "txn-cash-deposit-offset";
  await pool.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, allocated_cents, currency, status, till_number, branch_id, payer_name, origination_time)
     VALUES ($1, $2, $3, $4, 60000, 0, 'KES', 'Received', '3018421', 'b_sip', 'Cash Deposit', $5)`,
    [transactionId, "evt-cash-deposit-offset", "CASHDEPOSIT0F01", "0F01", "2026-08-02T13:00:00.000Z"]
  );
  const firstRequest = {
    transactionId,
    invoiceId: "inv-cash",
    branchId: "b_sip",
    amountCents: 30000,
    note: "Cash deposited after invoice payment",
    idempotencyKey: "cash-offset-request-1",
  };
  try {
    await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", cashierSessionToken)
      .send(firstRequest)
      .expect(403)
      .expect({ error: "insufficient_role" });

    const noCashInvoice = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send({ ...firstRequest, invoiceId: "inv-3", amountCents: 10000, idempotencyKey: "cash-offset-no-cash" })
      .expect(409);
    assert.equal(noCashInvoice.body.error, "kopokopo_invoice_has_no_cash_payment");

    const first = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", supervisorSessionToken)
      .send(firstRequest)
      .expect(200);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.offset.invoiceNumber, "RCP-SIP-000004");
    assert.equal(first.body.transaction.remainingCents, 30000);
    assert.deepEqual(getLatestRealtimeEvent("kopokopo").types, ["kopokopoOffset"]);

    const retried = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", supervisorSessionToken)
      .send(firstRequest)
      .expect(200);
    assert.equal(retried.body.duplicate, true);
    assert.equal(retried.body.transaction.remainingCents, 30000);

    const tooMuchCash = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send({ ...firstRequest, amountCents: 20001, idempotencyKey: "cash-offset-too-much" })
      .expect(409);
    assert.equal(tooMuchCash.body.error, "kopokopo_offset_exceeds_cash_payment");
    assert.equal(tooMuchCash.body.cashRemainingCents, 20000);

    const ledger = await request(app)
      .get("/api/integrations/kopokopo/transactions?branchId=b_sip&search=0004")
      .set("X-Session-Token", sessionToken)
      .expect(200);
    const ledgerTransaction = ledger.body.transactions.find((transaction) => transaction.id === transactionId);
    assert.ok(ledgerTransaction);
    assert.equal(ledgerTransaction.allocations.length, 0);
    assert.equal(ledgerTransaction.offsets.length, 1);
    assert.equal(ledgerTransaction.offsets[0].invoiceNumber, "RCP-SIP-000004");
    assert.equal(ledgerTransaction.offsets[0].offsetByName, "SIP Supervisor");

    const failedBatch = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send({
        transactionId,
        branchId: "b_sip",
        offsets: [
          { invoiceId: "inv-cash", amountCents: 19000 },
          { invoiceId: "inv-cash-small", amountCents: 11000 },
        ],
        idempotencyKey: "cash-offset-batch-invalid",
      })
      .expect(409);
    assert.equal(failedBatch.body.error, "kopokopo_offset_exceeds_cash_payment");
    assert.equal(failedBatch.body.invoiceId, "inv-cash-small");
    const afterFailedBatch = await pool.query(
      "SELECT allocated_cents FROM kopokopo_transactions WHERE id = $1",
      [transactionId]
    );
    assert.equal(Number(afterFailedBatch.rows[0].allocated_cents), 30000);
    const offsetsAfterFailedBatch = await pool.query(
      "SELECT COUNT(*) AS count FROM kopokopo_offsets WHERE transaction_id = $1",
      [transactionId]
    );
    assert.equal(Number(offsetsAfterFailedBatch.rows[0].count), 1);

    const batchRequest = {
      transactionId,
      branchId: "b_sip",
      offsets: [
        { invoiceId: "inv-cash", amountCents: 20000 },
        { invoiceId: "inv-cash-small", amountCents: 10000 },
      ],
      note: "One till deposit covering two cash receipts",
      idempotencyKey: "cash-offset-request-batch",
    };
    const completed = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send(batchRequest)
      .expect(200);
    assert.equal(completed.body.duplicate, false);
    assert.equal(completed.body.offsets.length, 2);
    assert.deepEqual(completed.body.offsets.map((entry) => entry.invoiceNumber).sort(), ["RCP-SIP-000004", "RCP-SIP-000005"]);
    assert.equal(completed.body.transaction.remainingCents, 0);

    const completedRetry = await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send(batchRequest)
      .expect(200);
    assert.equal(completedRetry.body.duplicate, true);
    assert.equal(completedRetry.body.offsets.length, 2);
    assert.equal(completedRetry.body.transaction.remainingCents, 0);

    await request(app)
      .post("/api/integrations/kopokopo/offsets")
      .set("X-Session-Token", sessionToken)
      .send({ ...batchRequest, offsets: [{ invoiceId: "inv-cash", amountCents: 10000 }] })
      .expect(409)
      .expect((response) => assert.equal(response.body.error, "idempotency_key_reused"));

    const lookup = await request(app)
      .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip&last4=0F01")
      .set("X-Session-Token", sessionToken)
      .expect(200);
    assert.equal(lookup.body.transactions.length, 0);

    const stored = await pool.query(
      "SELECT invoice_id, amount_cents, reason, status FROM kopokopo_offsets WHERE transaction_id = $1 ORDER BY invoice_id, amount_cents DESC",
      [transactionId]
    );
    assert.deepEqual(stored.rows.map((row) => ({
      invoiceId: row.invoice_id,
      amountCents: Number(row.amount_cents),
      reason: row.reason,
      status: row.status,
    })), [
      { invoiceId: "inv-cash", amountCents: 30000, reason: "cash_to_till", status: "active" },
      { invoiceId: "inv-cash", amountCents: 20000, reason: "cash_to_till", status: "active" },
      { invoiceId: "inv-cash-small", amountCents: 10000, reason: "cash_to_till", status: "active" },
    ]);
  } finally {
    await pool.query("DELETE FROM kopokopo_offsets WHERE transaction_id = $1", [transactionId]);
    await pool.query("DELETE FROM kopokopo_offset_batches WHERE transaction_id = $1", [transactionId]);
    await pool.query("DELETE FROM kopokopo_transactions WHERE id = $1", [transactionId]);
  }
});

test("a verified reversal removes the transaction from settlement lookup", async () => {
  await signedWebhook(webhookPayload({
    topic: "buygoods_transaction_reversed",
    eventId: "evt-reversed-1",
    resourceId: "txn-reversal-resource",
    status: "Reversed",
  })).expect(200);

  const lookup = await request(app)
    .get("/api/integrations/kopokopo/transactions/lookup?branchId=b_sip&last4=12CD")
    .set("X-Session-Token", sessionToken)
    .expect(200);
  assert.equal(lookup.body.transactions.length, 0);
  const allocations = await pool.query(
    "SELECT status FROM kopokopo_allocations WHERE transaction_id = $1",
    ["txn-1"]
  );
  assert.ok(allocations.rows.length > 0);
  assert.ok(allocations.rows.every((allocation) => allocation.status === "reversed"));
});

