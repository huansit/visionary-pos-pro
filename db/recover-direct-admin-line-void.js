import { isMySql, pool } from "../src/db.js";

// This is an operator-only recovery for an item void that was visibly applied
// in an older admin browser but never reached the cloud ledger. It creates the
// same three append-only records that a normal approved line void creates:
// request, approval, and stock return. It is dry-run by default and requires
// an exact receipt confirmation before it can write anything.

function usage(message = "") {
  if (message) console.error(`ERROR: ${message}`);
  console.log("Usage: node --env-file=.env.live db/recover-direct-admin-line-void.js --invoice RCP-CPT-001255 --line 0 --qty 1 [--reason \"Confirmed direct admin item void\"] [--apply --confirm RCP-CPT-001255]");
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const result = { apply: false, reason: "Confirmed direct admin item void" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [key, inlineValue] = arg.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[index + 1];
    if (key === "--apply") result.apply = true;
    else if (key === "--invoice") { result.invoice = value; if (inlineValue === undefined) index += 1; }
    else if (key === "--line") { result.line = value; if (inlineValue === undefined) index += 1; }
    else if (key === "--qty") { result.qty = value; if (inlineValue === undefined) index += 1; }
    else if (key === "--reason") { result.reason = value; if (inlineValue === undefined) index += 1; }
    else if (key === "--confirm") { result.confirm = value; if (inlineValue === undefined) index += 1; }
    else if (key === "--help" || key === "-h") return { help: true };
    else throw new Error(`unknown option ${arg}`);
  }
  return result;
}

function text(value) { return String(value ?? "").trim(); }
function payloadOf(row) {
  if (!row?.payload) return {};
  if (typeof row.payload === "object") return row.payload;
  try { return JSON.parse(row.payload); } catch { return {}; }
}

async function insertEvent(client, event, timestamp) {
  const query = isMySql
    ? "INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)"
    : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`;
  await client.query(query, [event.id, event.type, event.branchId, "historical-direct-admin-void-recovery", timestamp, timestamp, event.payload]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const invoiceReference = text(options.invoice);
  const lineIndex = Number(options.line);
  const qty = Number(options.qty);
  const reason = text(options.reason);
  if (!invoiceReference) return usage("--invoice is required");
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return usage("--line must be a zero-based item number");
  if (!Number.isInteger(qty) || qty <= 0) return usage("--qty must be a positive whole number");
  if (reason.length < 3) return usage("--reason must contain at least three characters");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoiceRows = (await client.query("SELECT id, branch_id, payload FROM events WHERE type = 'invoice' ORDER BY server_ts, id")).rows;
    const matches = invoiceRows.filter((row) => {
      const payload = payloadOf(row);
      return [row.id, payload.number, payload.receiptNo].some((value) => text(value).toLowerCase() === invoiceReference.toLowerCase());
    });
    if (matches.length !== 1) throw new Error(matches.length ? `invoice reference ${invoiceReference} is not unique` : `invoice ${invoiceReference} was not found`);
    const invoice = matches[0];
    const invoicePayload = payloadOf(invoice);
    const invoiceNumber = text(invoicePayload.number || invoicePayload.receiptNo || invoice.id);
    const branchId = text(invoice.branch_id || invoicePayload.branchId);
    const item = Array.isArray(invoicePayload.items) ? invoicePayload.items[lineIndex] : null;
    const lineQty = Number(item?.qty ?? item?.quantity ?? 0);
    const productId = text(item?.productId);
    if (!branchId || !item || !productId || !Number.isFinite(lineQty) || lineQty <= 0 || qty > lineQty) {
      throw new Error(`line ${lineIndex} is not a valid invoice product line for a quantity of ${qty}`);
    }

    const lineVoids = (await client.query("SELECT id, type, payload FROM events WHERE type IN ('invoiceLineVoidRequest', 'invoiceLineVoidDecision')")).rows
      .filter((row) => text(payloadOf(row).invoiceId) === text(invoice.id) && Number(payloadOf(row).lineIndex) === lineIndex);
    if (lineVoids.length) throw new Error(`invoice line ${lineIndex} already has ${lineVoids.length} void audit record(s); use the reconciliation audit instead`);

    const paymentRows = (await client.query("SELECT payload FROM events WHERE type = 'payment'")).rows;
    const paymentCents = paymentRows.reduce((sum, row) => {
      const payment = payloadOf(row);
      if (text(payment.invoiceId || payment.orderId) !== text(invoice.id) || (payment.status && payment.status !== "captured")) return sum;
      return sum + Math.max(0, Number(payment.amountCents) || 0);
    }, 0);
    const totalCents = Math.max(0, Number(invoicePayload.totalCents ?? invoicePayload.total) || 0);
    const paidCents = Math.max(0, Number(invoicePayload.paidCents ?? invoicePayload.paid) || 0, paymentCents);
    const unitPriceCents = Math.max(0, Number(item?.priceCents ?? item?.unitPriceCents ?? 0) || 0);
    const lineValueCents = Math.round(unitPriceCents * qty);
    if (paidCents > Math.max(0, totalCents - lineValueCents)) {
      throw new Error("the invoice payment is greater than the revised total; record the customer refund before recovering this void");
    }

    const requestId = `recover-direct-line-void-request:${invoice.id}:${lineIndex}`;
    const decisionId = `recover-direct-line-void-decision:${invoice.id}:${lineIndex}`;
    const stockMovementId = `void-line-stock:${invoice.id}:${lineIndex}:${requestId}`;
    const plan = {
      invoiceId: invoice.id, invoiceNumber, branchId, lineIndex, productId,
      productName: text(item?.name || item?.productName || "Product"), qty,
      requestId, decisionId, stockMovementId, reason,
    };

    if (!options.apply) {
      console.log(JSON.stringify({ mode: "dry-run", recovery: plan, message: "No records were changed. Re-run with --apply --confirm " + invoiceNumber + " to write the request, approval, and stock return." }, null, 2));
      await client.query("ROLLBACK");
      return;
    }
    if (text(options.confirm) !== invoiceNumber) throw new Error(`--confirm must exactly equal ${invoiceNumber}`);

    let timestamp = Date.now();
    const requestPayload = {
      invoiceId: invoice.id, branchId, lineIndex, qty, reason, status: "pending",
      requestedBy: "historical-direct-admin-recovery", requestedByName: "Historical direct admin recovery",
      requestedByRole: "admin", requestedAt: timestamp, ts: timestamp,
    };
    await insertEvent(client, { id: requestId, type: "invoiceLineVoidRequest", branchId, payload: requestPayload }, timestamp);
    timestamp += 1;
    const decisionPayload = {
      invoiceId: invoice.id, requestId, branchId, lineIndex, qty, decision: "approved", reason,
      decidedBy: "historical-direct-admin-recovery", decidedByName: "Historical direct admin recovery",
      decidedByRole: "admin", decidedAt: timestamp, ts: timestamp,
    };
    await insertEvent(client, { id: decisionId, type: "invoiceLineVoidDecision", branchId, payload: decisionPayload }, timestamp);
    timestamp += 1;
    const stockPayload = {
      productId, branchId, qty, unitCostCents: Math.max(0, Number(item?.unitCostCents ?? item?.costCents ?? 0) || 0),
      reason: `Recovered direct admin line void ${invoiceNumber}`, invoiceId: invoice.id,
      voidRequestId: requestId, voidDecisionId: decisionId, source: "invoice_line_void", recovered: true, ts: timestamp,
    };
    await insertEvent(client, { id: stockMovementId, type: "stockMovement", branchId, payload: stockPayload }, timestamp);
    await client.query("COMMIT");
    console.log(JSON.stringify({ mode: "applied", recovery: plan, restoredStockMovement: stockMovementId }, null, 2));
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error("direct admin item-void recovery failed:", error?.message || error);
  process.exit(1);
});
