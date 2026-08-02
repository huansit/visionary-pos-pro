# Kopo Kopo sandbox integration

VISIONPOS receives Kopo Kopo Buygoods webhooks and makes verified M-Pesa balances available to supervisor invoice settlement. Credentials stay on the API server and are never sent to the browser or cashier app.

## Server configuration

Set these values in `.env.live`:

```dotenv
KOPOKOPO_ENABLED=1
KOPOKOPO_MODE=sandbox
KOPOKOPO_BASE_URL=https://sandbox.kopokopo.com
KOPOKOPO_CLIENT_ID=<sandbox application client id>
KOPOKOPO_CLIENT_SECRET=<sandbox application client secret>
KOPOKOPO_API_KEY=<sandbox application api key>
KOPOKOPO_WEBHOOK_URL=https://visionarypos.cloud/api/integrations/kopokopo/webhook
KOPOKOPO_SCOPE=company
KOPOKOPO_SCOPE_REFERENCE=
KOPOKOPO_TILL_BRANCH_MAP={}
KOPOKOPO_SANDBOX_BRANCH_ID=b_sip
```

Use `KOPOKOPO_SANDBOX_BRANCH_ID` for the branch currently being tested. Production must use `KOPOKOPO_TILL_BRANCH_MAP` to map each real till number to its VISIONPOS branch ID.

## Activate

```bash
npm run migrate:live
chmod 600 .env.live
pm2 restart visionary-live --update-env
node --env-file=.env.live db/subscribe-kopokopo.js
pm2 save
```

The subscription command creates both `buygoods_transaction_received` and `buygoods_transaction_reversed` subscriptions using the K2Connect payload format.

## Test

1. Open **Incoming Payment Simulations** in the Kopo Kopo sandbox.
2. Simulate a Buygoods payment.
3. In VISIONPOS invoice settlement, enter the final four characters of the simulated M-Pesa reference.
4. Confirm the form displays **Verified Kopo Kopo transaction** and the provider amount.
5. Apply part of the balance, then reuse the same code on another invoice and confirm only the remaining balance is available.

Webhook signatures are checked against the exact raw request body before an event is stored. Duplicate webhook IDs and settlement retries are idempotent, and allocation uses a row lock so concurrent supervisors cannot spend the same balance twice.

