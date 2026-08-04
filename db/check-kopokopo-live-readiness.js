import { pool, q, ready } from "../src/db.js";
import { kopokopoConfig, kopokopoConfigForBranch, kopokopoConfigs, requestKopokopoAccessToken } from "../src/services/kopokopo.js";

function payloadObject(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch (_) { return {}; }
}

async function main() {
  await ready;
  const requestedBranchId = String(process.argv[2] || "").trim();
  const primary = kopokopoConfig();
  const configs = requestedBranchId
    ? [kopokopoConfigForBranch(requestedBranchId)].filter(Boolean)
    : kopokopoConfigs().filter((config) => config.enabled);
  if (!configs.length) throw new Error(requestedBranchId
    ? `No Kopo Kopo account is configured for branch ${requestedBranchId}.`
    : "KOPOKOPO_ENABLED must be 1.");
  const config = configs[0];
  if (!config.enabled) throw new Error("KOPOKOPO_ENABLED must be 1.");
  if (primary.mode !== "live") throw new Error("KOPOKOPO_MODE must be live.");

  const mappings = configs.flatMap((candidate) => Object.entries(candidate.tillBranchMap)
    .map(([till, branchId]) => ({ config: candidate, till, branchId })));
  const branches = await q("SELECT id, payload FROM records WHERE type = 'branch' AND deleted = false");
  const branchById = new Map(branches.rows.map((row) => [String(row.id), payloadObject(row.payload)]));
  const missingBranchIds = [...new Set(mappings.map(({ branchId }) => branchId))]
    .filter((branchId) => !branchById.has(branchId));
  if (missingBranchIds.length) {
    throw new Error(`KOPOKOPO_TILL_BRANCH_MAP contains unknown VISIONPOS branches: ${missingBranchIds.join(", ")}`);
  }

  console.log("VISIONPOS Kopo Kopo live readiness");
  console.log(`PASS OAuth origin: ${primary.authUrl}`);
  console.log(`PASS API origin: ${primary.baseUrl}`);
  console.log(`PASS webhook: ${primary.webhookUrl}`);
  for (const candidate of configs) {
    await requestKopokopoAccessToken(candidate);
    console.log(`PASS OAuth credentials: ${candidate.accountId}`);
    console.log(`PASS subscription scope: ${candidate.scope}${candidate.scopeReference ? ` (${candidate.scopeReference})` : ""}`);
  }
  for (const { config: candidate, till, branchId } of mappings) {
    const branch = branchById.get(branchId);
    console.log(`PASS account ${candidate.accountId}: till ${till} -> ${branch?.name || branchId} (${branchId})`);
  }
  console.log("READY No payment was initiated. Restart the API, then create the live webhook subscriptions.");
}

main()
  .catch((error) => {
    console.error(`FAIL ${error.message || error}`);
    if (error.providerStatus) console.error(`Provider status: ${error.providerStatus}`);
    if (error.providerMessage) console.error(`Provider response: ${error.providerMessage}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
