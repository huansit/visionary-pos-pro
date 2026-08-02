# Kopo Kopo sandbox integration

VISIONPOS receives Kopo Kopo Buygoods webhooks and makes verified M-Pesa balances available to supervisor invoice settlement. Credentials stay on the API server and are never sent to the browser or cashier app.

VISIONPOS also tracks M-Pesa STK prompts started from invoice settlement. If Kopo Kopo does not deliver the webhook, the API reads that request's authenticated status resource and stores the completed transaction through the same idempotent ledger. This recovery is intentionally limited to STK requests created by VISIONPOS; arbitrary till payments still require a valid provider webhook or a successful provider polling job.

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

Run the end-to-end diagnostic first:

```bash
npm run kopokopo:diagnose
```

The sandbox may omit its Buygoods webhook. In that case the diagnostic reports a warning, verifies the authenticated status fallback, and must still finish with successful persistence and cleanup messages.

For the operator flow:

1. Open an unpaid invoice in VISIONPOS.
2. Expand **Send M-Pesa prompt**, enter the customer's phone and amount, then send it.
3. Complete the sandbox prompt and wait for **Payment received and verified**.
4. Confirm the final four reference characters, amount, and payer are populated from Kopo Kopo.
5. Record the payment. The same verified reference can cover later invoices only until its remaining balance reaches zero.

Webhook signatures are checked against the exact raw request body before an event is stored. Duplicate webhook IDs and settlement retries are idempotent, and allocation uses a row lock so concurrent supervisors cannot spend the same balance twice.

