import { createKopokopoSubscriptions, kopokopoConfig } from "../src/services/kopokopo.js";

async function main() {
  const config = kopokopoConfig();
  if (!config.enabled) throw new Error("Set KOPOKOPO_ENABLED=1 before creating subscriptions.");
  console.log(`Creating ${config.mode} Kopo Kopo subscriptions for ${config.webhookUrl}`);
  const subscriptions = await createKopokopoSubscriptions(config);
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
