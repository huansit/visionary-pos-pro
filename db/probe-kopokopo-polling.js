import {
  kopokopoConfig,
  pollKopokopoTransactions,
} from "../src/services/kopokopo.js";

const config = kopokopoConfig();
const to = new Date();
const from = new Date(to.getTime() - 30 * 60 * 1000);

process.once("SIGINT", () => {
  console.error("Kopo Kopo polling probe cancelled.");
  process.exit(130);
});

console.log("VISIONPOS Kopo Kopo polling probe");
console.log(`Scope: ${config.scope}${config.scopeReference ? ` (${config.scopeReference})` : ""}`);
console.log(`Range: ${from.toISOString()} to ${to.toISOString()}`);

pollKopokopoTransactions({
  fromTime: from.toISOString(),
  toTime: to.toISOString(),
  timeoutMs: 60_000,
  onProgress: ({ phase, status, providerResourceId, elapsedMs }) => {
    console.log(`${phase.toUpperCase()} ${providerResourceId} - ${status} (${Math.round(elapsedMs / 1000)}s)`);
  },
}, config)
  .then(({ status, transactions }) => {
    console.log(`PASS provider polling completed with status ${status}`);
    console.log(`Transactions returned: ${transactions.length}`);
  })
  .catch((error) => {
    console.error(`FAIL ${error.message}`);
    if (error.providerStatus) console.error(`Provider status: ${error.providerStatus}`);
    if (error.providerResourceId) console.error(`Provider polling resource: ${error.providerResourceId}`);
    if (error.providerMessage) console.error(`Provider message: ${error.providerMessage}`);
    process.exitCode = 1;
  });
