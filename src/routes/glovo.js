import { Router } from "express";
import crypto from "node:crypto";
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
  const explicit = text(body.event_id || body.eventId || body.id);
  if (explicit) return `glovo:${explicit}`.slice(0, 191);
  return `glovo:${crypto.createHash("sha256").update(rawBody || JSON.stringify(body)).digest("hex")}`;
}

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
      return { duplicate: inserted === 0 };
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
      }]
    );

    return res.status(200).json({ ok: true, orderId: id, status, duplicate: result.duplicate });
  } catch (error) {
    return next(error);
  }
});

export default router;
