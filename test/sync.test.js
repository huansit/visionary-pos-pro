import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.PG_MEM = "1";
process.env.PG_MEM_AUTO_MIGRATE = "0";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.DEVICE_TOKEN_SECRET = "test-device-token-secret";
process.env.DEVICE_SETUP_KEY = "test-setup-key";
process.env.BCRYPT_ROUNDS = "10";
process.env.ADMIN_EMAIL_CODE_REQUIRED = "0";

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
  adminSessionToken: null,
  tokenA: null,
  tokenB: null,
  tokenC: null,
  terminal: null,
  loginTerminal: null,
  cashierId: null,
  cashierPin: null,
  managerId: null,
  managerEmail: null,
  invoice: {
    id: "inv-001",
    type: "invoice",
    branchId: "b_sip",
    clientTs: 1000,
    payload: { total: 42.5, lineCount: 2 },
  },
};

async function activateTestTerminal(name = "SIPCITY Cashier Till", branchId = "b_sip") {
  const activation = await withAdminSession(request(app)
    .post("/api/auth/terminal-activations")
    .send({ branchId, terminalName: name }))
    .expect(200);

  const activated = await request(app)
    .post("/api/auth/terminals/activate")
    .send({ activationCode: activation.body.code, appVersion: "2.0.2" })
    .expect(200);

  return { ...activated.body.terminal, secret: activated.body.terminalSecret };
}

function withAdminSession(req) {
  return req.set("X-Session-Token", state.adminSessionToken);
}

function withTerminalAuth(req, terminal) {
  return req
    .set("X-Terminal-UUID", terminal.uuid)
    .set("X-Terminal-Secret", terminal.secret);
}

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

  const deviceC = await request(app)
    .post("/api/auth/device")
    .send({
      deviceId: "device-c",
      name: "Cape Town Register",
      branchId: "b_cpt",
      setupKey: "test-setup-key",
    })
    .expect(200);
  assert.equal(deviceC.body.deviceId, "device-c");
  assert.ok(deviceC.body.token);
  state.tokenC = deviceC.body.token;
});

test("1a. provisions an admin session for management routes", async () => {
  const passwordHash = await bcrypt.hash("Admin@123", 10);
  await pool.query(
    `INSERT INTO credentials (id, kind, name, email, password_hash, branch_id, rights, status, email_verified)
     VALUES ($1, 'admin', $2, $3, $4, NULL, $5::jsonb, 'active', true)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       rights = EXCLUDED.rights,
       status = 'active',
       email_verified = true`,
    ["admin-owner", "Owner Admin", "admin.auth@example.com", passwordHash, JSON.stringify({ admin: true, role: "Admin" })]
  );

  const login = await request(app)
    .post("/api/auth/login")
    .send({ identifier: "admin.auth@example.com", password: "Admin@123" })
    .expect(200);
  assert.equal(login.body.account.role, "Admin");
  assert.ok(login.body.sessionToken);
  state.adminSessionToken = login.body.sessionToken;
});

test("1b. activates a desktop terminal and authenticates sync with terminal headers", async () => {
  const activation = await withAdminSession(request(app)
    .post("/api/auth/terminal-activations")
    .send({ branchId: "b_sip", terminalName: "SIPCITY Till 1" }))
    .expect(200);
  assert.ok(activation.body.code);

  const activated = await request(app)
    .post("/api/auth/terminals/activate")
    .send({ activationCode: activation.body.code, appVersion: "2.0.2" })
    .expect(200);
  assert.ok(activated.body.terminal.uuid);
  assert.ok(activated.body.terminalSecret);
  state.terminal = { ...activated.body.terminal, secret: activated.body.terminalSecret };

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("X-Terminal-UUID", state.terminal.uuid)
    .set("X-Terminal-Secret", state.terminal.secret)
    .expect(200);

  await withAdminSession(request(app)
    .get("/api/auth/terminals")
    )
    .expect(200)
    .expect((res) => {
      assert.ok(res.body.terminals.some((terminal) => terminal.uuid === state.terminal.uuid));
    });
});

test("1c. terminal branch is server-owned and cannot be changed by clients", async () => {
  const activation = await withAdminSession(request(app)
    .post("/api/auth/terminal-activations")
    .send({ branchId: "b_cpt", terminalName: "Cape Town Till" }))
    .expect(200);
  assert.equal(activation.body.branchId, "b_cpt");

  const spoofed = await request(app)
    .post("/api/auth/terminals/activate")
    .send({ activationCode: activation.body.code, appVersion: "2.0.2" })
    .expect(200);
  assert.equal(spoofed.body.terminal.branchId, "b_cpt");

  await withAdminSession(request(app)
    .post(`/api/auth/terminals/${spoofed.body.terminal.uuid}`)
    .send({ branchId: "b_sip", terminalName: "Still Cape Town Till" }))
    .expect(200);

  await withAdminSession(request(app)
    .get("/api/auth/terminals")
    )
    .expect(200)
    .expect((res) => {
      const terminal = res.body.terminals.find((item) => item.uuid === spoofed.body.terminal.uuid);
      assert.equal(terminal.branchId, "b_cpt");
      assert.equal(terminal.terminalName, "Still Cape Town Till");
    });
});

test("1g. device tokens cannot access admin management routes", async () => {
  await request(app)
    .get("/api/auth/terminals")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .expect(401);

  await request(app)
    .post("/api/auth/users")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ id: "blocked-user", name: "Blocked User", role: "Cashier", branchId: "b_sip", pin: "9991" })
    .expect(401);

  await request(app)
    .post("/api/ai/ask")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ messages: [{ role: "user", content: "sales today" }] })
    .expect(401);

  await request(app)
    .get("/api/reconcile/oversell")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .expect(401);

  await request(app)
    .post("/api/whatsapp/commands/test")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ from: "+15550101", text: "today's sales" })
    .expect(401);
});

test("1d. terminal sync cannot submit transactions for a different branch", async () => {
  await withTerminalAuth(request(app).post("/api/sync/push"), state.terminal)
    .send({
      events: [{
        id: "inv-cross-branch-rejected",
        type: "invoice",
        branchId: "b_cpt",
        clientTs: 1100,
        payload: { branchId: "b_cpt", totalCents: 1000 },
      }],
    })
    .expect(200)
    .expect((res) => {
      assert.deepEqual(res.body.accepted, []);
      assert.equal(res.body.rejected[0]?.reason, "terminal_branch_mismatch");
    });
});

test("1e. branch-bound bearer devices cannot spoof transaction branches", async () => {
  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({
      events: [{
        id: "inv-bearer-cross-branch-rejected",
        type: "invoice",
        branchId: "b_cpt",
        clientTs: 1150,
        payload: { branchId: "b_cpt", totalCents: 1000 },
      }],
    })
    .expect(200)
    .expect((res) => {
      assert.deepEqual(res.body.accepted, []);
      assert.equal(res.body.rejected[0]?.reason, "terminal_branch_mismatch");
    });
});

test("1f. registered cashier terminals cannot mutate privileged records through sync", async () => {
  await withTerminalAuth(request(app).post("/api/sync/push"), state.terminal)
    .send({
      events: [
        { id: "terminal-user-write-rejected", type: "user", updatedAt: 1200, payload: { name: "Injected User" } },
        { id: "terminal-setting-write-rejected", type: "setting", updatedAt: 1201, payload: { key: "danger", value: true } },
        { id: "terminal-day-close-rejected", type: "endOfDay", branchId: "b_sip", clientTs: 1202, payload: { branchId: "b_sip" } },
      ],
    })
    .expect(200)
    .expect((res) => {
      assert.deepEqual(res.body.accepted, []);
      assert.deepEqual(res.body.rejected.map((item) => item.reason), [
        "terminal_write_not_allowed",
        "terminal_write_not_allowed",
        "terminal_write_not_allowed",
      ]);
    });
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

test("14. disabled and revoked terminals cannot authenticate", async () => {
  await withAdminSession(request(app)
    .post(`/api/auth/terminals/${state.terminal.uuid}`)
    .send({ action: "disable" }))
    .expect(200);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("X-Terminal-UUID", state.terminal.uuid)
    .set("X-Terminal-Secret", state.terminal.secret)
    .expect(401);

  await withAdminSession(request(app)
    .post(`/api/auth/terminals/${state.terminal.uuid}`)
    .send({ action: "activate" }))
    .expect(200);

  await withAdminSession(request(app)
    .post(`/api/auth/terminals/${state.terminal.uuid}`)
    .send({ action: "revoke" }))
    .expect(200);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("X-Terminal-UUID", state.terminal.uuid)
    .set("X-Terminal-Secret", state.terminal.secret)
    .expect(401);
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

test("5b. Cape Town terminal invoice reaches admin sync feed", async () => {
  const capeTownTerminal = await activateTestTerminal("Cape Town Till", "b_cpt");
  const saleEvents = [
    {
      id: "inv-cpt-terminal-001",
      type: "invoice",
      branchId: "b_cpt",
      clientTs: 3200,
      payload: {
        id: "inv-cpt-terminal-001",
        number: "RCP-B_CPT-001",
        branchId: "b_cpt",
        cashierId: "cashier-cpt-001",
        cashier: "Cape Town Cashier",
        customerName: "Walk-in",
        totalCents: 35000,
        paidCents: 0,
        status: "open",
        carriedOver: false,
        items: [{ productId: "prod-cpt-001", name: "Cape Product", qty: 1, priceCents: 35000 }],
      },
    },
    {
      id: "stock-cpt-terminal-001",
      type: "stockMovement",
      branchId: "b_cpt",
      clientTs: 3201,
      payload: { productId: "prod-cpt-001", branchId: "b_cpt", qty: -1, reason: "Sale RCP-B_CPT-001" },
    },
  ];

  const pushed = await withTerminalAuth(request(app).post("/api/sync/push"), capeTownTerminal)
    .send({ events: saleEvents })
    .expect(200);

  assert.deepEqual(pushed.body.accepted.sort(), saleEvents.map((event) => event.id).sort());
  assert.equal(pushed.body.rejected.length, 0);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .expect(200)
    .expect((res) => {
      const invoice = res.body.events.find((event) => event.id === "inv-cpt-terminal-001");
      const movement = res.body.events.find((event) => event.id === "stock-cpt-terminal-001");
      assert.ok(invoice, "admin sync feed should include the Cape Town invoice");
      assert.ok(movement, "admin sync feed should include the Cape Town stock movement");
      assert.equal(invoice.branchId, "b_cpt");
      assert.equal(invoice.payload.branchId, "b_cpt");
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

test("6b. product records are shared globally by SKU and duplicate pushes tombstone the extra id", async () => {
  const sipProduct = {
    id: "prod-global-sip",
    type: "product",
    branchId: "b_sip",
    updatedAt: 2100,
    payload: {
      branchId: "b_sip",
      name: "Shared Gin",
      sku: "GIN001",
      barcode: "SGIN001",
      barcodeCatalogId: "bc_shared_gin",
      category: "Gin",
      costCents: 48000,
      priceCents: 65000,
    },
  };
  const cptProduct = {
    id: "prod-global-cpt",
    type: "product",
    branchId: "b_cpt",
    updatedAt: 2200,
    payload: {
      branchId: "b_cpt",
      name: "Shared Gin",
      sku: "GIN001",
      barcode: "SGIN001",
      barcodeCatalogId: "bc_shared_gin",
      category: "Gin",
      costCents: 48000,
      priceCents: 72000,
    },
  };
  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ events: [sipProduct, cptProduct] })
    .expect(200);

  await request(app)
    .post("/api/sync/push")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({
      events: [{
        ...sipProduct,
        updatedAt: 2300,
        payload: {
          ...sipProduct.payload,
          name: "Shared Gin Updated",
          costCents: 51000,
          priceCents: 66000,
        },
      }],
    })
    .expect(200);

  await request(app)
    .get("/api/sync/pull?since=0")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .expect(200)
    .expect((res) => {
      const active = res.body.events.filter((event) => event.type === "product" && !event.deleted && event.payload?.sku === "GIN001");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, "prod-global-sip");
      assert.equal(active[0].branchId, null);
      assert.equal(active[0].payload.name, "Shared Gin Updated");
      assert.equal(active[0].payload.costCents, 51000);
      assert.equal(active[0].payload.priceCents, 66000);
      assert.equal(active[0].payload.branchId, undefined);

      const tombstone = res.body.events.find((event) => event.id === "prod-global-cpt" && event.type === "product");
      assert.ok(tombstone);
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.payload.dedupedInto, "prod-global-sip");
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
      assert.equal(res.body.product.costPrice, 4800);
      assert.equal(res.body.product.stock, 12);
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

  await request(app)
    .post("/api/barcodes/products")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({
      id: "prod-bc-cpt-ignored",
      branchId: "b_cpt",
      barcode: "3245990043300",
      name: "Hennessy VS 750ML Updated",
      categoryId: "Spirits",
      costPrice: 5100,
      sellingPrice: 7200,
      stock: 3,
      reorderLevel: 2,
    })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.product.branchId, "b_cpt");
      assert.equal(res.body.product.name, "Hennessy VS 750ML Updated");
      assert.equal(res.body.product.costPrice, 5100);
      assert.equal(res.body.product.sellingPrice, 7200);
      assert.equal(res.body.product.stock, 3);
    });

  await request(app)
    .post("/api/barcodes/resolve")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ branchId: "b_sip", barcode: "3245990043300" })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.available, true);
      assert.equal(res.body.product.name, "Hennessy VS 750ML Updated");
      assert.equal(res.body.product.costPrice, 5100);
      assert.equal(res.body.product.sellingPrice, 6500);
      assert.equal(res.body.product.stock, 12);
    });

  await request(app)
    .post("/api/barcodes/products")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({
      branchId: "b_sip",
      barcode: "3245990043300",
      name: "Hennessy VS 750ML Final",
      categoryId: "Spirits",
      costPrice: 5200,
      sellingPrice: 6600,
      stock: 9,
      reorderLevel: 5,
    })
    .expect(200);

  await request(app)
    .post("/api/barcodes/resolve")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({ branchId: "b_cpt", barcode: "3245990043300" })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.available, true);
      assert.equal(res.body.product.name, "Hennessy VS 750ML Final");
      assert.equal(res.body.product.costPrice, 5200);
      assert.equal(res.body.product.sellingPrice, 7200);
      assert.equal(res.body.product.stock, 3);
    });
});

test("8. AI endpoint reports missing server configuration without exposing provider calls", async () => {
  await withAdminSession(request(app)
    .post("/api/ai/ask")
    .send({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "hello" }],
    }))
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

test("10. user credentials created on one device work for login on another device", async () => {
  state.loginTerminal = await activateTestTerminal();
  const unique = Date.now().toString(36);
  const cashierId = `cashier-cloud-${unique}`;
  const cashierPin = unique.replace(/\D/g, "").padEnd(4, "8").slice(0, 4);
  const managerId = `manager-cloud-${unique}`;
  const managerEmail = `cloud.manager.${unique}@example.com`;
  state.cashierId = cashierId;
  state.cashierPin = cashierPin;
  state.managerId = managerId;
  state.managerEmail = managerEmail;

  await withAdminSession(request(app)
    .post("/api/auth/users")
    .send({
      id: cashierId,
      name: "Cloud Cashier",
      role: "Cashier",
      pin: cashierPin,
      branchId: "b_sip",
      rights: ["sell", "customers"],
    }))
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.ok, true);
      assert.equal(res.body.account.id, cashierId);
    });

  await request(app)
    .post("/api/auth/login")
    .set("Authorization", `Bearer ${state.tokenB}`)
    .send({ identifier: cashierId, pin: cashierPin, branchId: "b_sip" })
    .expect(401)
    .expect((res) => {
      assert.equal(res.body.error, "registered_terminal_required");
    });

  await withTerminalAuth(request(app).post("/api/auth/login"), state.loginTerminal)
    .send({ identifier: cashierId, pin: cashierPin, branchId: "b_sip" })
    .expect(200)
    .expect((res) => {
      assert.ok(res.body.account, `Expected account in login response, got ${JSON.stringify(res.body)}`);
      assert.equal(res.body.account.id, cashierId);
      assert.equal(res.body.account.name, "Cloud Cashier");
      assert.equal(res.body.account.branchId, "b_sip");
      assert.ok(res.body.sessionToken);
    });

  await withAdminSession(request(app)
    .post("/api/auth/users")
    .send({
      id: managerId,
      name: "Cloud Manager",
      role: "Manager",
      email: managerEmail,
      password: "Manager@123",
      branchId: "b_sip",
      rights: ["sell", "users"],
    }))
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.ok, true);
      assert.equal(res.body.account.id, managerId);
    });

  await request(app)
    .post("/api/auth/login")
    .send({ identifier: managerEmail, password: "Manager@123" })
    .expect(200)
    .expect((res) => {
      assert.ok(res.body.account, `Expected account in manager login response, got ${JSON.stringify(res.body)}`);
      assert.equal(res.body.account.id, managerId);
      assert.equal(res.body.account.name, "Cloud Manager");
      assert.ok(res.body.sessionToken);
    });

  await withAdminSession(request(app)
    .post("/api/auth/users")
    .send({
      id: "admin",
      name: "Owner Admin",
      role: "Admin",
      email: "admin.cloud@example.com",
      password: "Admin@123",
    }))
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.account.id, "admin");
      assert.equal(res.body.account.kind, "admin");
      assert.equal(res.body.account.role, "Admin");
    });
  await pool.query("UPDATE credentials SET email_verified = true WHERE id = 'admin'");

  await request(app)
    .post("/api/auth/login")
    .send({ identifier: "admin.cloud@example.com", password: "Admin@123" })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.account.id, "admin");
      assert.equal(res.body.account.role, "Admin");
      assert.ok(res.body.sessionToken);
    });
});

test("10b. cashier PINs must be unique", async () => {
  await withAdminSession(request(app)
    .post("/api/auth/users")
    .send({
      id: "duplicate-pin-cashier",
      name: "Duplicate Pin Cashier",
      role: "Cashier",
      pin: state.cashierPin,
      branchId: "b_sip",
      rights: ["sell"],
    }))
    .expect(409)
    .expect((res) => {
      assert.equal(res.body.error, "duplicate_pin");
    });
});

test("11. cloud login sessions can be validated and revoked", async () => {
  const login = await withTerminalAuth(request(app).post("/api/auth/login"), state.loginTerminal)
    .send({ identifier: state.cashierId, pin: state.cashierPin, branchId: "b_sip", deviceName: "Test Till" })
    .expect(200);
  const token = login.body.sessionToken;
  assert.ok(token);

  await request(app)
    .post("/api/auth/session")
    .send({ sessionToken: token })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.account.id, state.cashierId);
      assert.equal(res.body.account.status, "active");
    });

  await request(app)
    .post("/api/auth/logout")
    .send({ sessionToken: token })
    .expect(200);

  await request(app)
    .post("/api/auth/session")
    .send({ sessionToken: token })
    .expect(401);
});

test("11b. revoking a terminal invalidates employee sessions from that terminal", async () => {
  const terminal = await activateTestTerminal("Session Revoke Till");
  const login = await withTerminalAuth(request(app).post("/api/auth/login"), terminal)
    .send({ identifier: state.cashierId, pin: state.cashierPin, branchId: "b_sip" })
    .expect(200);

  await withAdminSession(request(app)
    .post(`/api/auth/terminals/${terminal.uuid}`)
    .send({ action: "revoke" }))
    .expect(200);

  await request(app)
    .post("/api/auth/session")
    .send({ sessionToken: login.body.sessionToken })
    .expect(401);

  await withTerminalAuth(request(app).post("/api/sync/push"), terminal)
    .send({ events: [] })
    .expect(401);
});

test("12. deleted users are inactive immediately and cannot log in again", async () => {
  await withAdminSession(request(app)
    .post("/api/auth/users")
    .send({
      id: "delete-me-cashier",
      name: "Delete Me",
      role: "Cashier",
      pin: "8899",
      branchId: "b_sip",
      rights: ["sell"],
    }))
    .expect(200);

  await withTerminalAuth(request(app).post("/api/auth/login"), state.loginTerminal)
    .send({ identifier: "delete-me-cashier", pin: "8899", branchId: "b_sip" })
    .expect(200);

  await withAdminSession(request(app)
    .post("/api/auth/users/delete-me-cashier/delete")
    .send({}))
    .expect(200);

  await withTerminalAuth(request(app).post("/api/auth/login"), state.loginTerminal)
    .send({ identifier: "delete-me-cashier", pin: "8899", branchId: "b_sip" })
    .expect(401);
});

test("13. fingerprint templates are encrypted at rest and can issue cloud sessions", async () => {
  const template = "SECUGEN_TEMPLATE_BASE64_SAMPLE";
  await withAdminSession(request(app)
    .post("/api/auth/fingerprints/enroll")
    .send({ userId: state.cashierId, template, deviceSerial: "HAMSTER-001" }))
    .expect(200);

  const stored = await pool.query("SELECT finger_template, device_serial FROM user_fingerprints WHERE user_id = $1", [state.cashierId]);
  assert.equal(stored.rows[0].device_serial, "HAMSTER-001");
  assert.notEqual(stored.rows[0].finger_template, template);
  assert.match(stored.rows[0].finger_template, /^v1:/);

  await request(app)
    .post("/api/auth/fingerprints/templates")
    .set("Authorization", `Bearer ${state.tokenA}`)
    .send({})
    .expect(200)
    .expect((res) => {
      const hit = res.body.templates.find((row) => row.userId === state.cashierId);
      assert.equal(hit.template, template);
    });

  await request(app)
    .post("/api/auth/fingerprints/login")
    .send({ userId: state.cashierId, deviceSerial: "HAMSTER-001" })
    .expect(401);

  const login = await withTerminalAuth(request(app).post("/api/auth/fingerprints/login"), state.loginTerminal)
    .send({ userId: state.cashierId, branchId: "b_sip", deviceSerial: "HAMSTER-001" })
    .expect(200);
  assert.ok(login.body.sessionToken);

  await request(app)
    .post("/api/auth/fingerprints/checkout")
    .send({ userId: state.cashierId, sessionToken: login.body.sessionToken, branchId: "b_sip", deviceSerial: "HAMSTER-001" })
    .expect(200);
});

test("15. sync stream notifies clients after a committed push", async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/sync/stream?token=${encodeURIComponent(state.tokenA)}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readEvent(name) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (block.includes(`event: ${name}`)) return block;
      }
    }
    throw new Error(`missing_${name}_event`);
  }

  try {
    await readEvent("connected");
    await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${state.tokenA}`)
      .send({
        events: [{
          id: "inv-stream-001",
          type: "invoice",
          branchId: "b_sip",
          clientTs: Date.now(),
          payload: { totalCents: 1000, status: "open" },
        }],
      })
      .expect(200);
    const block = await readEvent("sync");
    assert.match(block, /"types":\["invoice"\]/);
  } finally {
    controller.abort();
    server.close();
  }
});
