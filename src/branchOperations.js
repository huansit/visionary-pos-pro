export function branchPayloadIsEnabled(payload = {}) {
  if (payload.enabled === false || payload.active === false) return false;
  return !["disabled", "inactive", "closed", "deleted"].includes(String(payload.status || "active").trim().toLowerCase());
}

export async function branchOperationsEnabled(client, branchId) {
  const { rows: [record] } = await client.query(
    "SELECT deleted, payload FROM records WHERE type = 'branch' AND id = $1",
    [branchId]
  );
  // Legacy terminals may have a branch identifier before its catalog record syncs.
  if (!record) return true;
  const payload = typeof record.payload === "string" ? JSON.parse(record.payload) : record.payload;
  return !record.deleted && branchPayloadIsEnabled(payload || {});
}
