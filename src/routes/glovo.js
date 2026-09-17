import { Router } from "express";
import crypto from "node:crypto";
import { requireAdminOrSupervisor } from "../auth.js";
import { isMySql, q, serverNow, tx } from "../db.js";

const router = Router();

function text(value) {
  return String(value ?? "").trim();
}

function configured() {
  return process.env.GLOVO_ENABLED === "1"
    && Boolean(text(process.env.GLOVO_WEBHOOK_SECRET))
    && Boolean(text(process.env.GLOVO_SIPCITY_VENDOR_ID));
}

function equalSecret(left, right) {
  const actual = Buffer.from(text(left), "utf8");
  const expected = Buffer.from(text(right), "utf8");
  return actual.length > 0
    && actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected);
}

function authorized(req) {
  // Glovo sends the value entered in Partner Portal as the Authorization
  // header.  This deliberately supports both a random opaque string and the
  // documented `Basic <base64>` option without accepting query-string keys.
  return equalSecret(req.get("authorization"), process.env.GLOVO_WEBHOOK_SECRET);
}

function orderId(body = {}) {
  return text(body.order_id || body.orderId || body.id || body.order?.id);
}

function orderStatus(body = {}) {
  return text(body.status || body.order_status || body.order?.status).toUpperCase() || "RECEIVED";
}

function vendorId(body = {}) {
  const client = body.client || body.store || body.vendor || body.order?.client || {};
  return text(
    client.external_partner_config_id
    || client.externalPartnerConfigId
    || client.store_id
    || client.storeId
    || body.external_partner_config_id
    || body.store_id
  );
}

function eventId(body, rawBody) {
  // `id` is commonly the order identifier. Treating it as a callback ID
  // would make a later cancellation or fulfilment callback look like a retry.
  const explicit = text(body.event_id || body.eventId);
  if (explicit) return `glovo:${explicit}`.slice(0, 191);
  return `glovo:${crypto.createHash("sha256").update(rawBody || JSON.stringify(body)).digest("hex")}`;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function json(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function moneyCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
}

function quantity(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function optionalDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function orderBody(body = {}) {
  return object(body.order).order_id ? object(body.order) : object(body);
}

function orderLines(body = {}) {
  const order = orderBody(body);
  return Array.isArray(order.items) ? order.items.filter((item) => item && typeof item === "object") : [];
}

async function productIdForSku(client, sku) {
  const wanted = text(sku).toLowerCase();
  if (!wanted) return null;
  // Product records are the live shared catalogue. Resolving here keeps the
  // Glovo ledger aligned with the same SKU aliases used by every terminal.
  const result = await client.query("SELECT id, payload FROM records WHERE type = 'product' AND deleted = false");
  const row = (result.rows || []).find((candidate) => text(json(candidate.payload).sku).toLowerCase() === wanted);
  return row ? String(row.id) : null;
}

async function writeGlovoOrderLedger(client, { event, orderId: id, vendorId: vendor, status, body }) {
  const order = orderBody(body);
  const payment = object(order.payment);
  const externalOrderId = text(order.external_order_id || order.externalOrderId) || null;
  const orderCode = text(order.order_code || order.orderCode) || null;
  const paymentType = text(payment.type || order.payment_type || order.paymentType) || null;
  const currency = text(payment.currency || order.currency) || null;
  const subTotalCents = moneyCents(payment.sub_total ?? payment.subTotal);
  const orderTotalCents = moneyCents(payment.order_total ?? payment.orderTotal ?? payment.total);
  const stockState = "pending_sandbox_validation";

  if (isMySql) {
    await client.query(
      `INSERT INTO glovo_orders
         (order_id, branch_id, vendor_id, external_order_id, order_code, status, payment_type, currency, sub_total_cents, order_total_cents, stock_state, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON DUPLICATE KEY UPDATE
         external_order_id=VALUES(external_order_id), order_code=VALUES(order_code), status=VALUES(status),
         payment_type=VALUES(payment_type), currency=VALUES(currency), sub_total_cents=VALUES(sub_total_cents),
         order_total_cents=VALUES(order_total_cents), stock_state=VALUES(stock_state), payload=VALUES(payload)`,
      [id, "b_sip", vendor, externalOrderId, orderCode, status, paymentType, currency, subTotalCents, orderTotalCents, stockState, body]
    );
  } else {
    await client.query(
      `INSERT INTO glovo_orders
         (order_id, branch_id, vendor_id, external_order_id, order_code, status, payment_type, currency, sub_total_cents, order_total_cents, stock_state, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (order_id) DO UPDATE SET
         external_order_id=EXCLUDED.external_order_id, order_code=EXCLUDED.order_code, status=EXCLUDED.status,
         payment_type=EXCLUDED.payment_type, currency=EXCLUDED.currency, sub_total_cents=EXCLUDED.sub_total_cents,
         order_total_cents=EXCLUDED.order_total_cents, stock_state=EXCLUDED.stock_state, payload=EXCLUDED.payload,
         updated_at=now()`,
      [id, "b_sip", vendor, externalOrderId, orderCode, status, paymentType, currency, subTotalCents, orderTotalCents, stockState, body]
    );
  }

  let mappedLines = 0;
  for (const [index, rawLine] of orderLines(body).entries()) {
    const line = object(rawLine);
    const pricing = object(line.pricing);
    const sku = text(line.sku || line.product_sku || line.productSku) || null;
    const lineId = text(line._id || line.line_id || line.lineId || sku || `line-${index + 1}`).slice(0, 191);
    const productId = await productIdForSku(client, sku);
    if (productId) mappedLines += 1;
    const values = [
      id, lineId, sku, productId, text(line.name || line.product_name || line.productName) || null,
      quantity(pricing.quantity ?? line.quantity ?? line.qty), text(pricing.pricing_type || line.pricing_type || line.pricingType) || null,
      moneyCents(pricing.unit_price ?? line.unit_price ?? line.unitPrice), moneyCents(pricing.total_price ?? line.total_price ?? line.totalPrice),
      stockState, line,
    ];
    if (isMySql) {
      await client.query(
        `INSERT INTO glovo_order_lines
           (order_id,line_id,sku,product_id,product_name,quantity,pricing_type,unit_price_cents,total_price_cents,stock_state,raw_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON DUPLICATE KEY UPDATE sku=VALUES(sku), product_id=VALUES(product_id), product_name=VALUES(product_name),
           quantity=VALUES(quantity), pricing_type=VALUES(pricing_type), unit_price_cents=VALUES(unit_price_cents),
           total_price_cents=VALUES(total_price_cents), stock_state=VALUES(stock_state), raw_item=VALUES(raw_item)`,
        values
      );
    } else {
      await client.query(
        `INSERT INTO glovo_order_lines
           (order_id,line_id,sku,product_id,product_name,quantity,pricing_type,unit_price_cents,total_price_cents,stock_state,raw_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (order_id,line_id) DO UPDATE SET sku=EXCLUDED.sku, product_id=EXCLUDED.product_id,
           product_name=EXCLUDED.product_name, quantity=EXCLUDED.quantity, pricing_type=EXCLUDED.pricing_type,
           unit_price_cents=EXCLUDED.unit_price_cents, total_price_cents=EXCLUDED.total_price_cents,
           stock_state=EXCLUDED.stock_state, raw_item=EXCLUDED.raw_item, updated_at=now()`,
        values
      );
    }
  }

  if (isMySql) {
    await client.query(
      "INSERT IGNORE INTO glovo_order_events (event_id,order_id,branch_id,status,payload) VALUES ($1,$2,$3,$4,$5)",
      [event, id, "b_sip", status, body]
    );
  } else {
    await client.query(
      "INSERT INTO glovo_order_events (event_id,order_id,branch_id,status,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING",
      [event, id, "b_sip", status, body]
    );
  }
  return { mappedLines, lineCount: orderLines(body).length, stockState, orderTotalCents, paymentType };
}

router.get("/orders", requireAdminOrSupervisor, async (_req, res, next) => {
  try {
    const result = await q(
      isMySql
        ? `SELECT order_id AS orderId, branch_id AS branchId, external_order_id AS externalOrderId, order_code AS orderCode,
                  status, payment_type AS paymentType, currency, sub_total_cents AS subTotalCents, order_total_cents AS orderTotalCents,
                  stock_state AS stockState, created_at AS createdAt, updated_at AS updatedAt
             FROM glovo_orders WHERE branch_id = 'b_sip' ORDER BY updated_at DESC LIMIT 250`
        : `SELECT order_id AS "orderId", branch_id AS "branchId", external_order_id AS "externalOrderId", order_code AS "orderCode",
                  status, payment_type AS "paymentType", currency, sub_total_cents AS "subTotalCents", order_total_cents AS "orderTotalCents",
                  stock_state AS "stockState", created_at AS "createdAt", updated_at AS "updatedAt"
             FROM glovo_orders WHERE branch_id = 'b_sip' ORDER BY updated_at DESC LIMIT 250`
    );
    res.json({ branchId: "b_sip", orders: result.rows || [] });
  } catch (error) { next(error); }
});

router.get("/report", requireAdminOrSupervisor, async (_req, res, next) => {
  try {
    const result = await q(
      `SELECT
         COUNT(*) AS order_count,
         COALESCE(SUM(order_total_cents), 0) AS gross_order_cents,
         COALESCE(SUM(CASE WHEN status IN ('CANCELLED', 'CANCELED') THEN order_total_cents ELSE 0 END), 0) AS cancelled_order_cents,
         COALESCE(SUM(CASE WHEN stock_state = 'pending_sandbox_validation' THEN 1 ELSE 0 END), 0) AS pending_stock_validation_count
       FROM glovo_orders WHERE branch_id = $1`,
      ["b_sip"]
    );
    const byStatus = await q(
      "SELECT status, COUNT(*) AS order_count, COALESCE(SUM(order_total_cents), 0) AS gross_order_cents FROM glovo_orders WHERE branch_id = $1 GROUP BY status ORDER BY status",
      ["b_sip"]
    );
    res.json({
      branchId: "b_sip",
      channel: "glovo",
      ...result.rows[0],
      byStatus: byStatus.rows || [],
      feesCents: null,
      payoutCents: null,
      note: "Glovo fees and payout reconciliation require Glovo's settlement feed; no fee is estimated by VisionPOS.",
    });
  } catch (error) { next(error); }
});

router.get("/pnl", requireAdminOrSupervisor, async (req, res, next) => {
  try {
    const from = optionalDate(req.query.from);
    const to = optionalDate(req.query.to);
    if (from === undefined || to === undefined || (from && to && from > to)) {
      return res.status(422).json({ error: "invalid_date_range" });
    }
    // A Glovo sale becomes reportable only after dispatch. This is deliberately
    // conservative: RECEIVED and READY_FOR_PICKUP orders are still subject to
    // cancellation or item changes. The first live sandbox flow will confirm
    // whether Glovo sends an additional delivered status for this merchant.
    const where = ["o.branch_id = $1", "o.status = 'DISPATCHED'", "o.stock_state = 'posted'"];
    const values = ["b_sip"];
    if (from) { values.push(from); where.push(`o.updated_at >= $${values.length}`); }
    if (to) { values.push(to); where.push(`o.updated_at <= $${values.length}`); }
    const filter = where.join(" AND ");
    const summary = await q(
      isMySql
        ? `SELECT COUNT(*) AS orderCount, COALESCE(SUM(o.order_total_cents), 0) AS revenueCents
             FROM glovo_orders o WHERE ${filter}`
        : `SELECT COUNT(*) AS "orderCount", COALESCE(SUM(o.order_total_cents), 0) AS "revenueCents"
             FROM glovo_orders o WHERE ${filter}`,
      values
    );
    const lines = await q(
      isMySql
        ? `SELECT l.product_id AS productId, l.sku, l.product_name AS productName,
                  COALESCE(SUM(l.quantity), 0) AS quantity,
                  COALESCE(SUM(l.total_price_cents), 0) AS revenueCents
             FROM glovo_order_lines l JOIN glovo_orders o ON o.order_id = l.order_id
             WHERE ${filter}
             GROUP BY l.product_id, l.sku, l.product_name
             ORDER BY revenueCents DESC`
        : `SELECT l.product_id AS "productId", l.sku, l.product_name AS "productName",
                  COALESCE(SUM(l.quantity), 0) AS quantity,
                  COALESCE(SUM(l.total_price_cents), 0) AS "revenueCents"
             FROM glovo_order_lines l JOIN glovo_orders o ON o.order_id = l.order_id
             WHERE ${filter}
             GROUP BY l.product_id, l.sku, l.product_name
             ORDER BY "revenueCents" DESC`,
      values
    );
    res.json({
      branchId: "b_sip",
      channel: "glovo",
      recognition: "dispatched",
      from: from || null,
      to: to || null,
      ...(summary.rows[0] || { orderCount: 0, revenueCents: 0 }),
      lines: lines.rows || [],
      note: "Only dispatched Glovo orders whose stock movement has been posted are included. Cost of goods is calculated from the mapped SIPCITY product cost; provider fees and payout require Glovo's settlement feed.",
    });
  } catch (error) { next(error); }
});

router.post("/orders/webhook", async (req, res, next) => {
  try {
    // A disabled integration behaves as absent. This prevents an unconfigured
    // URL from becoming a public ingestion surface.
    if (!configured()) return res.status(404).json({ error: "not_found" });
    if (!authorized(req)) return res.status(401).json({ error: "invalid_webhook_secret" });

    const id = orderId(req.body);
    const incomingVendorId = vendorId(req.body);
    const expectedVendorId = text(process.env.GLOVO_SIPCITY_VENDOR_ID);
    if (!id) return res.status(422).json({ error: "glovo_order_id_required" });
    if (!incomingVendorId || incomingVendorId !== expectedVendorId) {
      return res.status(422).json({ error: "glovo_vendor_not_mapped" });
    }

    const event = eventId(req.body, req.rawBody);
    const status = orderStatus(req.body);
    const receivedAt = new Date().toISOString();
    const result = await tx(async (client) => {
      const existing = await client.query("SELECT event_id FROM glovo_webhook_events WHERE event_id = $1", [event]);
      if (existing.rows.length) return { duplicate: true };
      let insert;
      if (isMySql) {
        insert = await client.query(
          `INSERT IGNORE INTO glovo_webhook_events
             (event_id, order_id, branch_id, vendor_id, status, payload, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
          [event, id, "b_sip", incomingVendorId, status, req.body || {}]
        );
      } else {
        insert = await client.query(
          `INSERT INTO glovo_webhook_events
             (event_id, order_id, branch_id, vendor_id, status, payload, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [event, id, "b_sip", incomingVendorId, status, req.body || {}]
        );
      }
      // The unique primary key is the final concurrency guard. A concurrent
      // retry can therefore be acknowledged without producing a second order.
      const inserted = isMySql
        ? Number(insert.raw?.affectedRows || 0)
        : Number(insert.rows?.length || 0);
      if (inserted === 0) return { duplicate: true };
      return { duplicate: false, ...(await writeGlovoOrderLedger(client, { event, orderId: id, vendorId: incomingVendorId, status, body: req.body || {} })) };
    });

    // Publish a branch-scoped append-only audit event for the admin PWA. It
    // intentionally does not issue invoices or change stock: that requires a
    // tested catalogue mapping and confirmed delivery-payment policy.
    await q(
      isMySql
        ? `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
           VALUES ($1,'glovoOrderWebhook',$2,NULL,$3,$4,$5)`
        : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
           VALUES ($1,'glovoOrderWebhook',$2,NULL,$3,$4,$5)
           ON CONFLICT (id) DO NOTHING`,
      [`${event}:audit`.slice(0, 191), "b_sip", Date.now(), serverNow(), {
        orderId: id,
        vendorId: incomingVendorId,
        status,
        receivedAt,
        source: "glovo",
        channel: "glovo",
        stockState: result.stockState || "pending_sandbox_validation",
        mappedLines: result.mappedLines || 0,
        lineCount: result.lineCount || 0,
        orderTotalCents: result.orderTotalCents || 0,
        paymentType: result.paymentType || null,
      }]
    );

    return res.status(200).json({ ok: true, orderId: id, status, duplicate: result.duplicate, stockState: result.stockState || "pending_sandbox_validation" });
  } catch (error) {
    return next(error);
  }
});

export default router;
