import assert from "node:assert/strict";
import { after, test } from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.PG_MEM = "1";
process.env.PG_MEM_AUTO_MIGRATE = "1";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/glovo";
process.env.DEVICE_TOKEN_SECRET = "test-device-token-secret";
process.env.DEVICE_SETUP_KEY = "test-setup-key";
process.env.ADMIN_EMAIL_CODE_REQUIRED = "0";
process.env.GLOVO_ENABLED = "1";
process.env.GLOVO_WEBHOOK_SECRET = "Basic dmlzaW9ucG9zOnRlc3Qtc2VjcmV0";
process.env.GLOVO_WEBHOOK_URL = "https://visionarypos.cloud/api/integrations/glovo/orders/webhook";
process.env.GLOVO_SIPCITY_VENDOR_ID = "b_sip";

const { pool, ready } = await import("../src/db.js");
await ready;
const { default: app } = await import("../src/server.js");

after(async () => pool.end());

const payload = {
  event_id: "glovo-test-order-1",
  order_id: "order-123",
  status: "RECEIVED",
  client: { external_partner_config_id: "b_sip" },
  items: [{ sku: "SIP0001", pricing: { quantity: 1, total_price: 100 } }],
};

test("Glovo webhook rejects unauthenticated deliveries", async () => {
  await request(app)
    .post("/api/integrations/glovo/orders/webhook")
    .send(payload)
    .expect(401, { error: "invalid_webhook_secret" });
});

test("Glovo webhook stores authenticated SIPCITY delivery once", async () => {
  const first = await request(app)
    .post("/api/integrations/glovo/orders/webhook")
    .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
    .send(payload)
    .expect(200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.orderId, "order-123");

  const duplicate = await request(app)
    .post("/api/integrations/glovo/orders/webhook")
    .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
    .send(payload)
    .expect(200);
  assert.equal(duplicate.body.duplicate, true);

  const stored = await pool.query("SELECT order_id, branch_id, status FROM glovo_webhook_events WHERE event_id = $1", ["glovo:glovo-test-order-1"]);
  assert.deepEqual(stored.rows[0], { order_id: "order-123", branch_id: "b_sip", status: "RECEIVED" });
  const audit = await pool.query("SELECT payload FROM events WHERE id = $1", ["glovo:glovo-test-order-1:audit"]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].payload.orderId, "order-123");
});

test("Glovo webhook rejects a callback for a different store", async () => {
  await request(app)
    .post("/api/integrations/glovo/orders/webhook")
    .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
    .send({ ...payload, event_id: "other-store", client: { external_partner_config_id: "b_cpt" } })
    .expect(422, { error: "glovo_vendor_not_mapped" });
});
