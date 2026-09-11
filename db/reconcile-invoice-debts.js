import { isMySql, pool, serverNow } from "../src/db.js";

// An operator-only repair for settlements completed in an older Windows build
// before payment events were sent to the shared ledger.  It never guesses: each
// receipt and exact cleared amount must be supplied, and the amount must equal
// the invoice's current outstanding balance.  The repair writes normal,
// append-only payment and invoiceSettlement events so every device and audit
// report sees the same history afterwards.

function usage(message = "") {
  if (message) console.error(`ERROR: ${message}`);
  console.log(`\nUsage (dry run by default):\n  node --env-file=.env db/reconcile-invoice-debts.js --branch b_sip --list\n  node --env-file=.env db/reconcile-invoice-debts.js --branch b_sip --method payroll --invoice RCP-SIP-000545=350 [--invoice RECEIPT=AMOUNT ...] --apply\n  node --env-file=.env db/reconcile-invoice-debts.js --branch b_sip --method m-pesa --mpesa-code ABCD1234 --receipt-total 1830 --invoice RCP-SIP-000545=350 [--invoice RECEIPT=AMOUNT ...] --apply\n\nAmounts are Kenya shillings. --apply is required to write. A historical M-Pesa receipt is stored once and allocated across the listed invoices; its total cannot be less than the allocations.`);
  process.exitCode = message ? 1 : 0;
}

function parseArgs(argv) {
  const result = { invoices: [], method: "payroll", apply: false, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--list") result.list = true;
    else if (arg === "--branch") result.branchId = argv[++index];
    else if (arg === "--method") result.method = argv[++index];
    else if (arg === "--mpesa-code") result.mpesaCode = argv[++index];
    else if (arg === "--receipt-total") result.receiptTotal = argv[++index];
    else if (arg === "--invoice") result.invoices.push(argv[++index]);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown option ${arg}`);
  }
  return result;
}

function text(value) { return String(value ?? "").trim(); }
function centsFromShillings(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return 0;
  return Math.round(amount * 100);
}
function mpesaCodeLast4(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-4);
}
function rowPayload(row) { return row?.payload && typeof row.payload === "object" ? row.payload : {}; }

function receiptAndCents(input) {
  const equals = text(input).lastIndexOf("=");
  if (equals < 1) throw new Error(`invalid invoice '${input}', expected RECEIPT=AMOUNT`);
  const receipt = text(input.slice(0, equals));
  const cents = centsFromShillings(input.slice(equals + 1));
  if (!receipt || !cents) throw new Error(`invalid invoice '${input}', expected a positive amount`);
  return { receipt, cents };
}

async function invoicesForBranch(client, branchId) {
  const result = await client.query(
    "SELECT id, branch_id, payload FROM events WHERE type = 'invoice' AND branch_id = $1 ORDER BY server_ts, id",
    [branchId],
  );
  return result.rows;
}

async function invoiceByReceipt(client, branchId, receipt) {
  const query = isMySql
    ? `SELECT id, branch_id, payload FROM events
         WHERE type = 'invoice' AND branch_id = $1
           AND (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.number')) = $2 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.receiptNo')) = $2)
         LIMIT 2`
    : `SELECT id, branch_id, payload FROM events
         WHERE type = 'invoice' AND branch_id = $1
           AND (payload->>'number' = $2 OR payload->>'receiptNo' = $2)
         LIMIT 2`;
  const result = await client.query(query, [branchId, receipt]);
  if (result.rows.length !== 1) throw new Error(result.rows.length ? `receipt ${receipt} is not unique in ${branchId}` : `receipt ${receipt} was not found in ${branchId}`);
  return result.rows[0];
}

async function ledgerRowsForInvoice(client, invoiceId) {
  const query = isMySql
    ? `SELECT id, type, payload FROM events
         WHERE type IN ('payment', 'invoiceSettlement')
           AND (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.invoiceId')) = $1 OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.orderId')) = $1)`
    : `SELECT id, type, payload FROM events
         WHERE type IN ('payment', 'invoiceSettlement')
           AND (payload->>'invoiceId' = $1 OR payload->>'orderId' = $1)`;
  return (await client.query(query, [invoiceId])).rows;
}

function effectivePaidCents(invoice, ledgerRows) {
  const invoicePaid = Math.max(0, Number(rowPayload(invoice).paidCents) || 0);
  const payments = ledgerRows
    .filter((row) => row.type === "payment")
    .filter((row) => !text(rowPayload(row).status) || text(rowPayload(row).status) === "captured")
    .reduce((sum, row) => sum + Math.max(0, Number(rowPayload(row).amountCents) || 0), 0);
  const settled = ledgerRows
    .filter((row) => row.type === "invoiceSettlement")
    .reduce((maximum, row) => Math.max(maximum, Math.max(0, Number(rowPayload(row).paidCents) || 0)), 0);
  return Math.max(invoicePaid, payments, settled);
}

async function insertEvent(client, event, timestamp) {
  if (isMySql) {
    await client.query(
      `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [event.id, event.type, event.branchId, "historical-reconciliation", event.clientTs, timestamp, event.payload],
    );
    return;
  }
  await client.query(
    `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, event.branchId, "historical-reconciliation", event.clientTs, timestamp, event.payload],
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const branchId = text(options.branchId);
  const method = text(options.method).toLowerCase();
  if (!branchId) throw new Error("--branch is required");
  if (!new Set(["payroll", "m-pesa", "cash"]).has(method)) throw new Error("--method must be payroll, m-pesa, or cash");
  if (!options.list && !options.invoices.length) throw new Error("at least one --invoice is required, or use --list");
  const mpesaCodeLastFour = method === "m-pesa" ? mpesaCodeLast4(options.mpesaCode) : "";
  if (method === "m-pesa" && mpesaCodeLastFour.length !== 4) throw new Error("--mpesa-code is required for a historical M-Pesa receipt");
  const requested = options.invoices.map(receiptAndCents);
  const receipts = new Set();
  for (const entry of requested) {
    if (receipts.has(entry.receipt)) throw new Error(`receipt ${entry.receipt} was supplied more than once`);
    receipts.add(entry.receipt);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (options.list) {
      const rows = await invoicesForBranch(client, branchId);
      const outstanding = [];
      for (const invoice of rows) {
        const payload = rowPayload(invoice);
        const totalCents = Math.max(0, Number(payload.totalCents) || 0);
        const paidCents = Math.min(totalCents, effectivePaidCents(invoice, await ledgerRowsForInvoice(client, invoice.id)));
        if (totalCents <= paidCents) continue;
        outstanding.push({
          receipt: text(payload.number || payload.receiptNo || invoice.id),
          invoiceId: invoice.id,
          cashier: text(payload.cashier || payload.cashierName || payload.soldBy),
          outstanding: (totalCents - paidCents) / 100,
          status: text(payload.status || "open"),
        });
      }
      console.table(outstanding);
      console.log(`${outstanding.length} outstanding invoice debt(s) in ${branchId}. No records were changed.`);
      await client.query("ROLLBACK");
      return;
    }
    const repairs = [];
    for (const request of requested) {
      const invoice = await invoiceByReceipt(client, branchId, request.receipt);
      const payload = rowPayload(invoice);
      const totalCents = Math.max(0, Number(payload.totalCents) || 0);
      const ledgerRows = await ledgerRowsForInvoice(client, invoice.id);
      const paidCents = Math.min(totalCents, effectivePaidCents(invoice, ledgerRows));
      const outstandingCents = Math.max(0, totalCents - paidCents);
      if (outstandingCents !== request.cents) {
        throw new Error(`${request.receipt} has ${outstandingCents / 100} outstanding, not ${request.cents / 100}; no change was made`);
      }
      if (!payload.carriedOver && !["debt", "open", "pending", "partial", "partially_paid", "overdue", ""].includes(text(payload.status).toLowerCase())) {
        throw new Error(`${request.receipt} is not an open debt invoice; no change was made`);
      }
      repairs.push({ invoice, payload, ...request, totalCents });
    }

    console.table(repairs.map((repair) => ({ receipt: repair.receipt, invoiceId: repair.invoice.id, amount: repair.cents / 100, method })));
    const allocatedCents = repairs.reduce((sum, repair) => sum + repair.cents, 0);
    const receiptTotalCents = method === "m-pesa" ? centsFromShillings(options.receiptTotal) : 0;
    if (method === "m-pesa" && receiptTotalCents < allocatedCents) {
      throw new Error(`the M-Pesa receipt total must be at least ${allocatedCents / 100}`);
    }
    const settlementBatchId = method === "m-pesa"
      ? `historical-mpesa:${branchId}:${mpesaCodeLastFour}:${repairs.map((repair) => repair.invoice.id).sort().join(":")}`
      : "";
    const mpesaReceiptId = method === "m-pesa" ? `receipt:${settlementBatchId}` : "";
    if (!options.apply) {
      console.log("Dry run passed. Re-run with --apply to record these historical settlements.");
      await client.query("ROLLBACK");
      return;
    }

    let timestamp = serverNow();
    for (const repair of repairs) {
      const paymentId = `recovery-payment:${repair.invoice.id}`;
      const settlementId = `recovery-settlement:${repair.invoice.id}`;
      const recoveryNote = `Recovered historical ${method} clearance for ${repair.receipt}`;
      const payment = {
        id: paymentId,
        type: "payment",
        branchId,
        clientTs: timestamp,
        payload: {
          id: paymentId,
          orderId: repair.invoice.id,
          invoiceId: repair.invoice.id,
          branchId,
          method,
          amountCents: repair.cents,
          status: "captured",
          recordedBy: "historical-reconciliation",
          recordedByName: "Historical settlement recovery",
          ts: timestamp,
          recoveryReason: recoveryNote,
          receiptNo: repair.receipt,
          ...(method === "m-pesa" ? {
            bulkSettlementId: settlementBatchId,
            mpesaReceiptId,
            mpesaCodeLast4: mpesaCodeLastFour,
            mpesaReceiptTotalCents: receiptTotalCents,
            mpesaReceiptRegisteredAt: timestamp,
            mpesaReceiptRegisteredByName: "Historical settlement recovery",
          } : {}),
        },
      };
      timestamp += 1;
      const settlement = {
        id: settlementId,
        type: "invoiceSettlement",
        branchId,
        clientTs: timestamp,
        payload: {
          invoiceId: repair.invoice.id,
          branchId,
          paidCents: repair.totalCents,
          status: "paid",
          carriedOver: false,
          lastSettledBy: "historical-reconciliation",
          lastSettledByName: "Historical settlement recovery",
          lastSettledAt: timestamp,
          settledBy: "historical-reconciliation",
          settledByName: "Historical settlement recovery",
          settledAt: timestamp,
          recoveryReason: recoveryNote,
          receiptNo: repair.receipt,
        },
      };
      await insertEvent(client, payment, timestamp);
      timestamp += 1;
      await insertEvent(client, settlement, timestamp);
    }
    await client.query("COMMIT");
    console.log(`Recorded ${repairs.length} auditable historical settlement(s). Refresh the dashboard on any device.`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => { usage(error?.message || "invoice reconciliation failed"); })
  .finally(async () => { await pool.end?.(); });
