import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.PG_MEM = "1";
process.env.PG_MEM_AUTO_MIGRATE = "0";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.DEVICE_TOKEN_SECRET = "test-device-token-secret";
process.env.DEVICE_SETUP_KEY = "test-setup-key";
process.env.BCRYPT_ROUNDS = "10";

const { pool } = await import("../src/db.js");
const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .replace(/,\s*CONSTRAINT devices_token_hash_is_bcrypt CHECK \(token_hash ~ '[^']+'\)/g, "")
  .replace(/,\s*CONSTRAINT user_records_have_no_plain_credentials CHECK \([\s\S]*?\n  \)/g, "")
  .replace(/,\s*CONSTRAINT credential_pin_hash_is_bcrypt CHECK \(pin_hash IS NULL OR pin_hash ~ '[^']+'\)/g, "")
  .replace(/,\s*CONSTRAINT credential_password_hash_is_bcrypt CHECK \(password_hash IS NULL OR password_hash ~ '[^']+'\)/g, "")
  .replace(/,\s*CONSTRAINT auth_verification_code_hash_is_bcrypt CHECK \(code_hash ~ '[^']+'\)/g, "");
await pool.query(schema);
const { default: app } = await import("../src/server.js");

after(async () => {
  await pool.end();
});

const state = {
  tokenA: null,
  tokenB: null,
  invoice: {
    id: "inv-001",
    type: "invoice",
    branchId: "b_sip",
    clientTs: 1000,
    payload: { total: 42.5, lineCount: 2 },
  },
};

test("1. registers two devices via /api/auth/device", async () => {
  const deviceA = await request(app)
    .post("/api/auth/device")
    .send({
      deviceId: "device-a",
      name: "Register A",
      branchId: "b_sip",
      setupKey: "test-setup-key",
    })
    .expect(200);
  assert.equal(deviceA.body.deviceId, "device-a");
  assert.ok(deviceA.body.token);
  state.tokenA = deviceA.body.token;

  const deviceB = await request(app)
    .post("/api/auth/device")
    .send({
      deviceId: "device-b",
      name: "Register B",
      branchId: "b_sip",
      setupKey: "test-setup-key",
    })
    .expect(200);
  assert.equal(deviceB.body.deviceId, "device-b");
  assert.ok(deviceB.body.token);
  state.tokenB = deviceB.body.token;
});

test("2. pushes an invoice event from device A to /api/sync/push", async () => {
  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [state.invoice] })
    .expect(200)
    .expect((res) => {
      assert.deepEqual(res.body.accepted, ["inv-001"]);
      assert.equal(res.body.rejected.length, 0);
      assert.ok(res.body.serverTs["inv-001"]);
    });
});

test("3. pulls from device B via /api/sync/pull and receives the invoice", async () => {
  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .expect(200)
    .expect((res) => {
      const pulled = res.body.events.filter((event) => event.id === "inv-001");
      assert.equal(pulled.length, 1);
      assert.equal(pulled[0].type, "invoice");
      assert.deepEqual(pulled[0].payload, state.invoice.payload);
    });
});

test("4. pushing the same event again is idempotent with no duplicate", async () => {
  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [state.invoice] })
    .expect(200);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .expect(200)
    .expect((res) => {
      const pulled = res.body.events.filter((event) => event.id === "inv-001");
      assert.equal(pulled.length, 1);
    });
});

test("5. two devices sync a complete transaction sale across invoice, payment, and stock movement", async () => {
  const saleEvents = [
    {
      id: "inv-two-device-001",
      type: "invoice",
      branchId: "b_sip",
      clientTs: 3000,
      payload: { totalCents: 120000, paidCents: 120000, customerId: null, lines: [{ productId: "prod-two-device-001", qty: 2, priceCents: 60000 }] },
    },
    {
      id: "pay-two-device-001",
      type: "payment",
      branchId: "b_sip",
      clientTs: 3001,
      payload: { invoiceId: "inv-two-device-001", method: "cash", amountCents: 120000 },
    },
    {
      id: "stock-two-device-001",
      type: "stockMovement",
      branchId: "b_sip",
      clientTs: 3002,
      payload: { productId: "prod-two-device-001", qty: -2, reason: "sale", invoiceId: "inv-two-device-001" },
    },
  ];

  const pushed = await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: saleEvents })
    .expect(200);
  assert.deepEqual(pushed.body.accepted.sort(), saleEvents.map((event) => event.id).sort());

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .expect(200)
    .expect((res) => {
      const byId = new Map(res.body.events.map((event) => [event.id, event]));
      for (const event of saleEvents) {
        assert.ok(byId.has(event.id), `${event.id} should be pulled by device B`);
        assert.equal(byId.get(event.id).type, event.type);
        assert.deepEqual(byId.get(event.id).payload, event.payload);
      }
    });
});

test("6. product record last-write-wins keeps newer updatedAt and ignores older", async () => {
  const newerProduct = {
    id: "prod-001",
    type: "product",
    branchId: "b_sip",
    updatedAt: 2000,
    payload: { name: "Coffee", price: 5 },
  };
  const olderProduct = {
    id: "prod-001",
    type: "product",
    branchId: "b_sip",
    updatedAt: 1500,
    payload: { name: "Coffee", price: 1 },
  };

  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [newerProduct] })
    .expect(200);

  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [olderProduct] })
    .expect(200);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .expect(200)
    .expect((res) => {
      const products = res.body.events.filter((event) => event.id === "prod-001" && event.type === "product");
      assert.equal(products.length, 1);
      assert.equal(products[0].updatedAt, 2000);
      assert.deepEqual(products[0].payload, newerProduct.payload);
    });
});

test("7. barcode catalog resolves by branch and reports unavailable branch products", async () => {
  await request(app)
    .post("/api/barcodes/products")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({
      id: "prod-bc-001",
      branchId: "b_sip",
      barcode: "3245990043300",
      name: "Hennessy VS 750ML",
      categoryId: "Spirits",
      costPrice: 4800,
      sellingPrice: 6500,
      stock: 12,
      reorderLevel: 4,
    })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.barcodeCatalog.barcode, "3245990043300");
      assert.equal(res.body.product.branchId, "b_sip");
      assert.equal(res.body.product.barcodeCatalogId, res.body.barcodeCatalog.id);
    });

  await request(app)
    .post("/api/barcodes/resolve")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ branchId: "b_sip", barcode: "3245990043300" })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.available, true);
      assert.equal(res.body.product.name, "Hennessy VS 750ML");
      assert.equal(res.body.product.sellingPrice, 6500);
    });

  await request(app)
    .post("/api/barcodes/resolve")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ branchId: "b_cpt", barcode: "3245990043300" })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.found, true);
      assert.equal(res.body.available, false);
      assert.equal(res.body.message, "This product is not available in this branch.");
    });
});

test("8. AI endpoint reports missing server configuration without exposing provider calls", async () => {
  await request(app)
    .post("/api/ai/ask")
    .send({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "hello" }],
    })
    .expect(503)
    .expect((res) => {
      assert.equal(res.body.error, "ai_not_configured");
    });
});

test("9. sync push reports rejected invalid events so clients can clear non-retryable queue items", async () => {
  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [{ id: "bad-sync-001", type: "notARealType", payload: { value: true } }] })
    .expect(200)
    .expect((res) => {
      assert.deepEqual(res.body.accepted, []);
      assert.equal(res.body.rejected.length, 1);
      assert.equal(res.body.rejected[0].id, "bad-sync-001");
      assert.equal(res.body.rejected[0].reason, "unknown_type");
    });
});
