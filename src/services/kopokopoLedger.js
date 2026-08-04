import { isMySql, tx } from "../db.js";
import { publishRealtimeEvent } from "../realtime.js";
import { redactKopokopoPayload } from "./kopokopo.js";

async function insertProviderEvent(client, parsed, body) {
  const existing = await client.query(
    "SELECT event_id FROM kopokopo_webhook_events WHERE event_id = $1 LIMIT 1",
    [parsed.eventId]
  );
  if (existing.rows[0]) return false;
  if (isMySql) {
    const result = await client.query(
      `INSERT IGNORE INTO kopokopo_webhook_events (event_id, topic, resource_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [parsed.eventId, parsed.topic, parsed.resourceId, JSON.stringify(redactKopokopoPayload(body))]
    );
    return Number(result.raw?.affectedRows || 0) > 0;
  }
  const result = await client.query(
    `INSERT INTO kopokopo_webhook_events (event_id, topic, resource_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [parsed.eventId, parsed.topic, parsed.resourceId, JSON.stringify(redactKopokopoPayload(body))]
  );
  return Boolean(result.rows[0]);
}

async function applyReceivedTransaction(client, parsed) {
  const existing = await client.query(
    "SELECT id, status FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2 LIMIT 1 FOR UPDATE",
    [parsed.resourceId, parsed.reference]
  );
  const row = existing.rows[0];
  if (row) {
    await client.query(
      `UPDATE kopokopo_transactions
          SET webhook_event_id = $2,
              amount_cents = $3,
              currency = $4,
              status = CASE WHEN lower(status) = 'reversed' THEN status ELSE $5 END,
              till_number = $6,
              branch_id = COALESCE($7, branch_id),
              payer_name = COALESCE(payer_name, $8),
              payer_phone_last4 = COALESCE(payer_phone_last4, $9),
              origination_time = COALESCE(origination_time, $10),
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [row.id, parsed.eventId, parsed.amountCents, parsed.currency, parsed.status, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.payerPhoneLast4, parsed.originationTime]
    );
    return;
  }
  await client.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, currency, status, till_number, branch_id, payer_name, payer_phone_last4, origination_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [parsed.resourceId, parsed.eventId, parsed.reference, parsed.referenceLast4, parsed.amountCents, parsed.currency, parsed.status, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.payerPhoneLast4, parsed.originationTime]
  );
}

async function enrichReceivedTransaction(client, parsed) {
  if (!parsed.payerName && !parsed.payerPhoneLast4 && !parsed.originationTime) return false;
  const existing = await client.query(
    `SELECT id, payer_name, payer_phone_last4, origination_time
       FROM kopokopo_transactions
      WHERE id = $1 OR upper(reference) = $2
      LIMIT 1
      FOR UPDATE`,
    [parsed.resourceId, parsed.reference]
  );
  const row = existing.rows[0];
  if (!row) return false;
  const payerName = row.payer_name ?? row.payerName;
  const payerPhoneLast4 = row.payer_phone_last4 ?? row.payerPhoneLast4;
  const originationTime = row.origination_time ?? row.originationTime;
  const enriched = (!payerName && parsed.payerName)
    || (!payerPhoneLast4 && parsed.payerPhoneLast4)
    || (!originationTime && parsed.originationTime);
  if (!enriched) return false;
  await client.query(
    `UPDATE kopokopo_transactions
        SET payer_name = COALESCE(payer_name, $2),
            payer_phone_last4 = COALESCE(payer_phone_last4, $3),
            origination_time = COALESCE(origination_time, $4),
            updated_at = ${isMySql ? "NOW()" : "now()"}
      WHERE id = $1`,
    [row.id, parsed.payerName, parsed.payerPhoneLast4, parsed.originationTime]
  );
  return true;
}

async function applyReversedTransaction(client, parsed) {
  const existing = await client.query(
    "SELECT id FROM kopokopo_transactions WHERE id = $1 OR upper(reference) = $2 LIMIT 1 FOR UPDATE",
    [parsed.resourceId, parsed.reference]
  );
  if (existing.rows[0]) {
    const transactionId = existing.rows[0].id;
    await client.query(
      `UPDATE kopokopo_transactions
          SET webhook_event_id = $2, status = 'Reversed', reversed_at = COALESCE($3, ${isMySql ? "NOW()" : "now()"}),
              updated_at = ${isMySql ? "NOW()" : "now()"}
        WHERE id = $1`,
      [transactionId, parsed.eventId, parsed.eventTime]
    );
    await client.query(
      `UPDATE kopokopo_allocations
          SET status = 'reversed'
        WHERE transaction_id = $1
          AND lower(status) = 'active'`,
      [transactionId]
    );
    return;
  }
  await client.query(
    `INSERT INTO kopokopo_transactions
      (id, webhook_event_id, reference, reference_last4, amount_cents, currency, status, till_number, branch_id, payer_name, payer_phone_last4, origination_time, reversed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Reversed', $7, $8, $9, $10, $11, COALESCE($12, ${isMySql ? "NOW()" : "now()"}))`,
    [parsed.resourceId, parsed.eventId, parsed.reference, parsed.referenceLast4, parsed.amountCents, parsed.currency, parsed.tillNumber || null, parsed.branchId, parsed.payerName, parsed.payerPhoneLast4, parsed.originationTime, parsed.eventTime]
  );
}

export async function storeKopokopoEvent(parsed, body) {
  if (!parsed?.supported || !parsed?.valid) throw new Error("invalid_kopokopo_event");
  const result = await tx(async (client) => {
    const inserted = await insertProviderEvent(client, parsed, body);
    if (!inserted) {
      const enriched = parsed.reversed ? false : await enrichReceivedTransaction(client, parsed);
      return { duplicate: true, enriched };
    }
    if (parsed.reversed) await applyReversedTransaction(client, parsed);
    else await applyReceivedTransaction(client, parsed);
    return { duplicate: false, enriched: false };
  });
  if (!result.duplicate || result.enriched) {
    publishRealtimeEvent("kopokopo", {
      source: "kopokopo",
      branchId: parsed.branchId || null,
      accepted: result.duplicate ? 0 : 1,
      types: ["kopokopoTransaction"],
    });
  }
  return result;
}
