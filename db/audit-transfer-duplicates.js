import { pool, q } from "../src/db.js";

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(row) {
  return number(row.server_ts || row.client_ts || row.payload?.ts);
}

function displayTime(row) {
  const value = timestamp(row);
  return value > 0 ? new Date(value).toISOString() : "unknown";
}

function transferNumber(row) {
  return text(row.payload?.number || row.payload?.transferNumber);
}

function requestId(row) {
  return text(row.payload?.cashierRequestId);
}

function itemSignature(payload = {}) {
  return (Array.isArray(payload.items) ? payload.items : [])
    .map((item) => `${text(item.productId || item.sku || item.productName)}:${number(item.qty)}`)
    .sort()
    .join("|");
}

function transferSignature(row) {
  const payload = row.payload || {};
  return [
    text(payload.fromBranchId),
    text(payload.toBranchId),
    itemSignature(payload),
  ].join("::");
}

function grouped(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].filter(([, entries]) => entries.length > 1);
}

function transferRows(groups, reason) {
  return groups.flatMap(([key, entries]) => entries.map((row) => ({
    reason,
    key,
    transfer_id: row.id,
    transfer_number: transferNumber(row) || "-",
    request_id: requestId(row) || "-",
    from: text(row.payload?.fromBranchId) || "-",
    to: text(row.payload?.toBranchId) || "-",
    time: displayTime(row),
  })));
}

function rapidExactGroups(rows, windowMs = 10_000) {
  const candidates = [];
  for (const [signature, entries] of grouped(rows, transferSignature)) {
    const sorted = [...entries].sort((a, b) => timestamp(a) - timestamp(b));
    let cluster = [sorted[0]];
    for (let index = 1; index < sorted.length; index += 1) {
      if (timestamp(sorted[index]) - timestamp(sorted[index - 1]) <= windowMs) {
        cluster.push(sorted[index]);
      } else {
        if (cluster.length > 1) candidates.push([signature, cluster]);
        cluster = [sorted[index]];
      }
    }
    if (cluster.length > 1) candidates.push([signature, cluster]);
  }
  return candidates;
}

function movementKey(row) {
  const payload = row.payload || {};
  return [
    text(payload.transferId),
    text(payload.branchId || row.branch_id),
    text(payload.productId),
    number(payload.qty),
  ].join("::");
}

function printTable(title, rows) {
  console.log(`\n${title}: ${rows.length}`);
  if (rows.length) console.table(rows);
}

try {
  const [transfersResult, movementsResult] = await Promise.all([
    q("SELECT id, branch_id, device_id, client_ts, server_ts, payload FROM events WHERE type = 'borrowing' ORDER BY server_ts, id"),
    q("SELECT id, branch_id, device_id, client_ts, server_ts, payload FROM events WHERE type = 'stockMovement' ORDER BY server_ts, id"),
  ]);
  const transfers = transfersResult.rows;
  const movements = movementsResult.rows;

  const duplicateRequests = grouped(transfers, requestId);
  const duplicateNumbers = grouped(transfers, transferNumber);
  const rapidMatches = rapidExactGroups(transfers);
  const duplicateMovements = grouped(movements.filter((row) => text(row.payload?.transferId)), movementKey);

  console.log("VISIONPOS transfer duplicate audit (read only)");
  console.log(`Transfers checked: ${transfers.length}`);
  console.log(`Stock movements checked: ${movements.length}`);
  printTable("CONFIRMED: multiple transfers for one cashier request", transferRows(duplicateRequests, "same cashier request"));
  printTable("REVIEW: reused transfer numbers", transferRows(duplicateNumbers, "same transfer number"));
  printTable("REVIEW: exact transfers saved within 10 seconds", transferRows(rapidMatches, "rapid exact match"));
  printTable("CONFIRMED: repeated transfer stock movements", duplicateMovements.flatMap(([key, entries]) => entries.map((row) => ({
    key,
    movement_id: row.id,
    transfer_id: text(row.payload?.transferId),
    branch: text(row.payload?.branchId || row.branch_id),
    product: text(row.payload?.productId),
    qty: number(row.payload?.qty),
    time: displayTime(row),
  }))));

  const confirmedGroupCount = duplicateRequests.length + duplicateMovements.length;
  const reviewGroupCount = duplicateNumbers.length + rapidMatches.length;
  console.log(`\nRESULT: ${confirmedGroupCount} confirmed duplicate group(s); ${reviewGroupCount} group(s) require review.`);
  console.log("No records were changed.");
} finally {
  await pool.end();
}
