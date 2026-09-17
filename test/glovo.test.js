import assert from "node:assert/strict";
import { after, test } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";

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
  assert.equal(audit.rows[0].payload.channel, "glovo");

  const order = await pool.query("SELECT branch_id, status, order_total_cents, stock_state FROM glovo_orders WHERE order_id = $1", ["order-123"]);
  assert.deepEqual(order.rows[0], {
    branch_id: "b_sip",
    status: "RECEIVED",
    order_total_cents: 0,
    stock_state: "pending_sandbox_validation",
  });
  const line = await pool.query("SELECT sku, quantity, stock_state FROM glovo_order_lines WHERE order_id = $1", ["order-123"]);
  assert.deepEqual(line.rows[0], { sku: "SIP0001", quantity: 1, stock_state: "pending_sandbox_validation" });
  const history = await pool.query("SELECT status FROM glovo_order_events WHERE event_id = $1", ["glovo:glovo-test-order-1"]);
  assert.deepEqual(history.rows[0], { status: "RECEIVED" });
});

test("Glovo webhook rejects a callback for a different store", async () => {
  await request(app)
    .post("/api/integrations/glovo/orders/webhook")
    .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
    .send({ ...payload, event_id: "other-store", client: { external_partner_config_id: "b_cpt" } })
    .expect(422, { error: "glovo_vendor_not_mapped" });
});

test("Glovo ledger totals stay separate from cashier and M-Pesa tables", async () => {
  const totals = await pool.query("SELECT COUNT(*) AS count, COALESCE(SUM(order_total_cents), 0) AS total FROM glovo_orders WHERE branch_id = $1", ["b_sip"]);
  assert.equal(Number(totals.rows[0].count), 1);
  assert.equal(Number(totals.rows[0].total), 0);
});

test("a fulfilled mapped Glovo order posts stock once and a later cancellation restores it once", async () => {
  const productId = "glovo-test-product-sip";
  const orderId = "glovo-stock-order-1";
  try {
    await pool.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1, 'product', 'b_sip', NULL, $2, $2, false, $3)`,
      [productId, Date.now(), { id: productId, branchId: "b_sip", name: "Glovo Stock Product", sku: "GLOVO-STOCK-001", costCents: 12500 }]
    );
    const fulfilled = {
      event_id: "glovo-stock-order-fulfilled",
      order_id: orderId,
      status: "DISPATCHED",
      client: { external_partner_config_id: "b_sip" },
      payment: { order_total: 300 },
      items: [{ line_id: "line-1", sku: "GLOVO-STOCK-001", pricing: { quantity: 2, unit_price: 150, total_price: 300 } }],
    };
    await request(app)
      .post("/api/integrations/glovo/orders/webhook")
      .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
      .send(fulfilled)
      .expect(200, { ok: true, orderId, status: "DISPATCHED", duplicate: false, stockState: "posted" });

    const posted = await pool.query("SELECT payload FROM events WHERE id = $1", [`glovo-stock:${orderId}:line-1`]);
    assert.equal(posted.rows.length, 1);
    assert.equal(posted.rows[0].payload.productId, productId);
    assert.equal(posted.rows[0].payload.qty, -2);
    assert.equal(posted.rows[0].payload.source, "glovo");

    await request(app)
      .post("/api/integrations/glovo/orders/webhook")
      .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
      .send({ ...fulfilled, event_id: "glovo-stock-order-cancelled", status: "CANCELLED" })
      .expect(200, { ok: true, orderId, status: "CANCELLED", duplicate: false, stockState: "reversed" });
    const reversed = await pool.query("SELECT payload FROM events WHERE id = $1", [`glovo-stock-reversal:${orderId}:line-1`]);
    assert.equal(reversed.rows.length, 1);
    assert.equal(reversed.rows[0].payload.qty, 2);

    await request(app)
      .post("/api/integrations/glovo/orders/webhook")
      .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
      .send({ ...fulfilled, event_id: "glovo-stock-order-late-dispatch" })
      .expect(200, { ok: true, orderId, status: "DISPATCHED", duplicate: false, stockState: "reversed" });
    const stockEvents = await pool.query("SELECT id FROM events WHERE id LIKE $1", [`glovo-stock:${orderId}:%`]);
    assert.equal(stockEvents.rows.length, 1, "a status replay must not deduct stock twice");
  } finally {
    await pool.query("DELETE FROM events WHERE id LIKE $1", [`glovo-stock%:${orderId}%`]);
    await pool.query("DELETE FROM glovo_order_events WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_order_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_webhook_events WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_orders WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM records WHERE type = 'product' AND id = $1", [productId]);
  }
});

test("Glovo reports expose fulfilled online revenue, product lines, and daily totals", async () => {
  const productId = "glovo-report-product-sip";
  const orderId = "glovo-report-order-1";
  const adminId = "glovo-report-admin";
  try {
    await pool.query(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1, 'product', 'b_sip', NULL, $2, $2, false, $3)`,
      [productId, Date.now(), { id: productId, branchId: "b_sip", name: "Glovo Report Product", sku: "GLOVO-REPORT-001", costCents: 12000 }]
    );
    await request(app)
      .post("/api/integrations/glovo/orders/webhook")
      .set("Authorization", process.env.GLOVO_WEBHOOK_SECRET)
      .send({
        event_id: "glovo-report-order-fulfilled",
        order_id: orderId,
        status: "DELIVERED",
        client: { external_partner_config_id: "b_sip" },
        payment: { order_total: 420 },
        items: [{ line_id: "line-1", sku: "GLOVO-REPORT-001", pricing: { quantity: 2, unit_price: 210, total_price: 420 } }],
      })
      .expect(200, { ok: true, orderId, status: "DELIVERED", duplicate: false, stockState: "posted" });

    await pool.query(
      `INSERT INTO credentials (id, kind, name, email, password_hash, rights, status, email_verified)
       VALUES ($1, 'admin', $2, $3, $4, $5::jsonb, 'active', true)`,
      [adminId, "Glovo Report Admin", "glovo.report@example.com", await bcrypt.hash("Admin@123", 10), JSON.stringify({ role: "Admin" })]
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "glovo.report@example.com", password: "Admin@123" })
      .expect(200);
    const report = await request(app)
      .get("/api/integrations/glovo/pnl")
      .set("X-Session-Token", login.body.sessionToken)
      .expect(200);

    assert.equal(Number(report.body.revenueCents), 42000);
    assert.equal(Number(report.body.orderCount), 1);
    assert.deepEqual(report.body.lines.map((line) => ({ productId: line.productId, quantity: Number(line.quantity), revenueCents: Number(line.revenueCents) })), [{ productId, quantity: 2, revenueCents: 42000 }]);
    assert.equal(report.body.daily.length, 1);
    assert.equal(Number(report.body.daily[0].revenueCents), 42000);
  } finally {
    await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [adminId]);
    await pool.query("DELETE FROM credentials WHERE id = $1", [adminId]);
    await pool.query("DELETE FROM events WHERE id LIKE $1", [`glovo-stock%:${orderId}%`]);
    await pool.query("DELETE FROM glovo_order_events WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_order_lines WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_webhook_events WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM glovo_orders WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM records WHERE type = 'product' AND id = $1", [productId]);
  }
});
