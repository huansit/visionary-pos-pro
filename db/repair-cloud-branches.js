import { isMySql, pool, q, serverNow } from "../src/db.js";

const DEFAULT_BRANCHES = new Map([
  ["b_sip", { id: "b_sip", name: "SIPCITY", code: "SIP", location: "SIPCITY", managerId: null, active: true, mpesaTill: "5204512" }],
  ["b_cpt", { id: "b_cpt", name: "Cape Town", code: "CPT", location: "Cape Town", managerId: null, active: true, mpesaTill: "5208830" }],
]);

function fallbackBranch(id) {
  return {
    id,
    name: id.replace(/^b_/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    code: id.replace(/^b_/, "").slice(0, 3).toUpperCase() || "BR",
    location: "",
    managerId: null,
    active: true,
    mpesaTill: "",
  };
}

async function existingBranchIds() {
  const result = await q("SELECT id FROM records WHERE type = 'branch'");
  return new Set(result.rows.map((row) => row.id));
}

async function referencedBranchIds() {
  const ids = new Set(DEFAULT_BRANCHES.keys());
  const result = await q(
    isMySql
      ? `SELECT DISTINCT branch_id AS branchId FROM records WHERE branch_id IS NOT NULL
         UNION
         SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.branchId')) AS branchId
           FROM records
          WHERE JSON_EXTRACT(payload, '$.branchId') IS NOT NULL`
      : `SELECT DISTINCT branch_id AS "branchId" FROM records WHERE branch_id IS NOT NULL
         UNION
         SELECT DISTINCT payload->>'branchId' AS "branchId"
           FROM records
          WHERE payload ? 'branchId'`
  );
  for (const row of result.rows) {
    const id = String(row.branchId || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function upsertBranch(branch, ts) {
  const payload = { ...branch, synced: true, updatedAt: ts };
  if (isMySql) {
    await q(
      `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
       VALUES ($1,'branch',$2,NULL,$3,$4,false,$5)
       ON DUPLICATE KEY UPDATE
         branch_id = VALUES(branch_id),
         updated_at = GREATEST(updated_at, VALUES(updated_at)),
         server_ts = GREATEST(server_ts, VALUES(server_ts)),
         deleted = false,
         payload = VALUES(payload)`,
      [branch.id, branch.id, ts, ts, payload]
    );
    return;
  }
  await q(
    `INSERT INTO records (id, type, branch_id, device_id, updated_at, server_ts, deleted, payload)
     VALUES ($1,'branch',$2,NULL,$3,$4,false,$5)
     ON CONFLICT (type, id) DO UPDATE SET
       branch_id = EXCLUDED.branch_id,
       updated_at = GREATEST(records.updated_at, EXCLUDED.updated_at),
       server_ts = GREATEST(records.server_ts, EXCLUDED.server_ts),
       deleted = false,
       payload = EXCLUDED.payload`,
    [branch.id, branch.id, ts, ts, payload]
  );
}

try {
  const existing = await existingBranchIds();
  const referenced = await referencedBranchIds();
  let created = 0;
  let ts = serverNow();
  for (const id of referenced) {
    if (existing.has(id)) continue;
    const branch = DEFAULT_BRANCHES.get(id) || fallbackBranch(id);
    ts += 1;
    await upsertBranch(branch, ts);
    created += 1;
    console.log(`Created branch record: ${branch.id} (${branch.name})`);
  }
  const final = await q(isMySql ? "SELECT count(*) AS n FROM records WHERE type = 'branch'" : "SELECT count(*)::int AS n FROM records WHERE type = 'branch'");
  console.log(`Branch repair complete. Added ${created}; total branch records: ${final.rows[0].n}`);
} finally {
  await pool.end?.();
}
