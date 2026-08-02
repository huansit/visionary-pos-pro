import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
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
process.env.KOPOKOPO_API_KEY = "test-kopokopo-api-key";
process.env.KOPOKOPO_WEBHOOK_URL = "https://visionarypos.cloud/api/integrations/kopokopo/webhook";
process.env.KOPOKOPO_SANDBOX_BRANCH_ID = "b_sip";

const { pool, ready } = await import("../src/db.js");
await ready;
const { default: app } = await import("../src/server.js");

let sessionToken = "";
let branchSessionToken = "";

function signedWebhook(payload, secret = process.env.KOPOKOPO_API_KEY) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return request(app)
    .post("/api/integrations/kopokopo/webhook")
    .set("Content-Type", "application/json")
    .set("X-KopoKopo-Signature", signature)
    .send(body);
}

function webhookPayload({ topic = "buygoods_transaction_received", eventId = "evt-received-1", resourceId = "txn-1", status = "Received" } = {}) {
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
        reference: "TGH7AB12CD",
        till_number: "000000",
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

  for (const invoice of [
    { id: "inv-1", branchId: "b_sip", totalCents: 30000 },
    { id: "inv-2", branchId: "b_sip", totalCents: 20000 },
    { id: "inv-3", branchId: "b_sip", totalCents: 100000 },
    { id: "inv-cpt", branchId: "b_cpt", totalCents: 100000 },
  ]) {
    await pool.query(
      `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1, 'invoice', $2, NULL, 1, $3, $4::jsonb)`,
      [invoice.id, invoice.branchId, Date.now(), JSON.stringify(invoice)]
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

test("stores a verified payment once and exposes only a branch-scoped masked lookup", async () => {
  const payload = webhookPayload();
  await signedWebhook(payload).expect(200).expect({ ok: true, duplicate: false });
  await signedWebhook(payload).expect(200).expect({ ok: true, duplicate: true });

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
  assert.equal(lookup.body.transactions[0].payerName, "Test Customer");
  assert.equal("reference" in lookup.body.transactions[0], false);

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
  const allocated = await request(app)
    .post("/api/integrations/kopokopo/allocations")
    .set("X-Session-Token", sessionToken)
    .send(allocationRequest)
    .expect(200);
  assert.equal(allocated.body.duplicate, false);
  assert.equal(allocated.body.transaction.remainingCents, 50000);

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

