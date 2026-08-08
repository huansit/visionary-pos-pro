import { createKopokopoSubscriptions, kopokopoConfig, kopokopoConfigForBranch } from "../src/services/kopokopo.js";

async function main() {
  const args = process.argv.slice(2);
  const fundingOnly = args.includes("--funding-only");
  const branchId = String(args.find((value) => !value.startsWith("--")) || "").trim();
  const config = branchId ? kopokopoConfigForBranch(branchId) : kopokopoConfig();
  if (!config?.enabled) throw new Error(branchId
    ? `No enabled Kopo Kopo account is configured for branch ${branchId}.`
    : "Set KOPOKOPO_ENABLED=1 before creating subscriptions.");
  console.log(`Creating ${config.mode} Kopo Kopo subscriptions for account ${config.accountId} at ${config.webhookUrl}`);
  const subscriptions = await createKopokopoSubscriptions(
    config,
    fundingOnly ? { eventTypes: ["b2b_transaction_received"] } : undefined
  );
  for (const subscription of subscriptions) {
    console.log(`${subscription.eventType}: ${subscription.location || "created"}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  if (error.providerStatus) console.error(`Provider status: ${error.providerStatus}`);
  if (error.providerMessage) console.error(`Provider response: ${error.providerMessage}`);
  process.exit(1);
});
