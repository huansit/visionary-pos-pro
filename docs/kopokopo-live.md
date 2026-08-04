# Kopo Kopo live activation

Do not reuse sandbox credentials in live mode. Create a production application in the Kopo Kopo merchant account and collect the real till number assigned to each VISIONPOS branch.

## Required production values

- Production client ID
- Production client secret
- Production API key
- SIPCITY till number
- Cape Town till number

VISIONPOS keeps OAuth credentials on the API server. The browser and cashier application never receive them.

## Server configuration

Back up `.env.live`, then replace only the Kopo Kopo block with real production values:

```dotenv
KOPOKOPO_ENABLED=1
KOPOKOPO_MODE=live
KOPOKOPO_BASE_URL=https://api.kopokopo.com
KOPOKOPO_AUTH_URL=https://app.kopokopo.com
KOPOKOPO_CLIENT_ID=<Cape Town production client id>
KOPOKOPO_CLIENT_SECRET=<Cape Town production client secret>
KOPOKOPO_API_KEY=<Cape Town production api key>
KOPOKOPO_WEBHOOK_URL=https://visionarypos.cloud/api/integrations/kopokopo/webhook
KOPOKOPO_SCOPE=till
KOPOKOPO_SCOPE_REFERENCE=<Cape Town till>
KOPOKOPO_TILL_BRANCH_MAP={"<Cape Town till>":"b_cpt"}
KOPOKOPO_ADDITIONAL_ACCOUNTS=SIPCITY
KOPOKOPO_SIPCITY_CLIENT_ID=<SIPCITY production client id>
KOPOKOPO_SIPCITY_CLIENT_SECRET=<SIPCITY production client secret>
KOPOKOPO_SIPCITY_API_KEY=<SIPCITY production api key>
KOPOKOPO_SIPCITY_BRANCH_ID=b_sip
KOPOKOPO_SIPCITY_TILL_NUMBER=<SIPCITY till>
KOPOKOPO_SANDBOX_BRANCH_ID=
KOPOKOPO_POLLING_ENABLED=0
```

Cape Town remains the primary account. SIPCITY is a separate approved application with its own OAuth and webhook signing credentials. Do not add the SIPCITY till to `KOPOKOPO_TILL_BRANCH_MAP`; its named account maps that till to `b_sip`.

## Read-only readiness check

This validates the environment, database branch IDs, official hosts, and production OAuth credentials. It does not initiate a payment.

```bash
cd /root/visionary-pos-pro
node --env-file=.env.live db/check-kopokopo-live-readiness.js b_sip
```

Do not continue unless every line reports `PASS` and the command ends with `READY`.

## Activate

Load the live API key before creating subscriptions so webhook signatures can be verified immediately:

```bash
pm2 restart visionary-live --update-env
node --env-file=.env.live db/subscribe-kopokopo.js b_sip
pm2 save
```

Confirm that one active `buygoods_transaction_received` subscription and one active `buygoods_transaction_reversed` subscription point to the VISIONPOS HTTPS webhook.

## First live transaction

Use a KES 10 invoice at one branch. Send the M-Pesa prompt from invoice settlement, approve it on the payer phone, verify the returned payer/reference/amount, and allocate only KES 10. Repeat at the other branch before normal use.

If either branch maps to the wrong till, disable Kopo Kopo immediately by setting `KOPOKOPO_ENABLED=0` and restarting `visionary-live` with `--update-env`.
