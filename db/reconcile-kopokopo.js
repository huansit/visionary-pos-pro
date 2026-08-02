import { pool } from "../src/db.js";
import { reconcileKopokopoTransactions } from "../src/services/kopokopoReconciler.js";

reconcileKopokopoTransactions({ lookbackMs: 24 * 60 * 60 * 1000 })
  .then((summary) => {
    console.log("Kopo Kopo polling reconciliation complete");
    console.table([summary]);
  })
  .catch((error) => {
    console.error(`Kopo Kopo polling reconciliation failed: ${error.message}`);
    if (error.providerStatus) console.error(`Provider HTTP status: ${error.providerStatus}`);
    if (error.providerMessage) console.error(`Provider message: ${error.providerMessage}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
