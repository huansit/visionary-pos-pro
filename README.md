# Visionary POS Sync API

Node + Express + PostgreSQL sync backend for the Visionary POS front end.

## What It Implements

- Append-only event sync for `invoice`, `payment`, `stockMovement`, `expense`, `borrowing`, `endOfDay`, `cashMovement`, `order`, `purchase`, and `countLog`.
- Mutable record sync for `product`, `customer`, `user`, `branch`, `setting`, `supplier`, and `supplierPrice`.
- Plural aliases are accepted for core mutable records: `products`, `customers`, `users`, `branches`, `settings`.
- Event tables merge by union-on-id with `INSERT ... ON CONFLICT DO NOTHING`.
- Mutable records use last-write-wins by server timestamp. Re-pushing an identical record returns the existing server timestamp.
- Device bearer tokens are stored only as bcrypt hashes.
- User passwords and PINs live only in the `credentials` table as bcrypt hashes. Plain user `password`, `pin`, `plainPassword`, and `plainPin` fields are rejected from sync payloads.
- PostgreSQL connection pooling, `/health`, PM2 config, and Ubuntu 24 friendly scripts.

## Setup

```bash
cp .env.example .env
npm install
npm run migrate
npm start
```

For PM2:

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

## Ubuntu 24 Notes

```bash
sudo apt update
sudo apt install -y nodejs npm postgresql
sudo npm install -g pm2
createdb visionary_pos
npm install
npm run migrate
pm2 start ecosystem.config.cjs --env production
```

Put this behind HTTPS, normally with Nginx and Certbot. Keep Postgres off the public internet.

## Device Auth

Register or rotate a device token:

```http
POST /api/auth/device
Content-Type: application/json

{
  "deviceId": "till-sipcity-01",
  "name": "SIPCITY till",
  "branchId": "b_sip",
  "setupKey": "value-from-DEVICE_SETUP_KEY"
}
```

Response:

```json
{ "deviceId": "till-sipcity-01", "token": "..." }
```

Use the token on protected routes:

```http
Authorization: Bearer <token>
```

You can also seed a device on the server:

```bash
node db/make-device.js till-sipcity-01 "SIPCITY till" b_sip
```

## User Login

Password login:

```http
POST /api/auth/login
Content-Type: application/json

{ "identifier": "owner@example.com", "password": "secret" }
```

PIN login:

```json
{ "pin": "1234", "branchId": "b_sip" }
```

Response:

```json
{
  "ok": true,
  "account": {
    "id": "u_123",
    "kind": "user",
    "name": "Maya",
    "branchId": "b_sip",
    "rights": {}
  }
}
```

Generate bcrypt hashes for `credentials.password_hash` or `credentials.pin_hash`:

```bash
npm run hash -- "Admin@123"
```

## Push

```http
POST /api/sync/push
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "events": [
    {
      "id": "prod_001",
      "type": "product",
      "branchId": "b_sip",
      "updatedAt": 1781800000000,
      "payload": { "name": "Coffee", "price": 2.5 }
    },
    {
      "id": "inv_001",
      "type": "invoice",
      "branchId": "b_sip",
      "clientTs": 1781800000123,
      "payload": { "total": 12.75 }
    }
  ]
}
```

Response:

```json
{
  "accepted": ["prod_001", "inv_001"],
  "serverTs": {
    "prod_001": 1781800001000,
    "inv_001": 1781800001001
  },
  "rejected": [],
  "cursor": 1781800001001
}
```

## Pull

```http
GET /api/sync/pull?since=1781800001001&limit=500
Authorization: Bearer <token>
```

Response:

```json
{
  "events": [],
  "cursor": 1781800001001,
  "hasMore": false
}
```

## Health And Reconciliation

- `GET /health` checks the API and database.
- `GET /api/reconcile/oversell` returns stockMovement aggregates with negative on-hand quantities.

## Front-End Sync

The confirmed latest front end is included as `VisionaryPOS.jsx`. It is still local-first, but persistence now writes to:

- local cache: `visionary:pos:full:v11`
- outbox: `visionary:pos:sync:outbox:v1`
- pull cursor: `visionary:pos:sync:cursor:v1`

Configure the API before loading the component:

```html
<script src="./frontend-sync-config.example.js"></script>
```

Or set the same values directly:

```js
localStorage.setItem("visionary:sync:apiBaseUrl", "http://127.0.0.1:3000");
localStorage.setItem("visionary:sync:deviceToken", "<device-token-from-/api/auth/device>");
```

For local testing, start the backend, register a device token, then run your React/Vite front-end with `VisionaryPOS.jsx` mounted as the app component.

No local Postgres installed? Start the real API against embedded memory storage:

```bash
npm run dev:mem
```

Then register a device:

```bash
curl -X POST http://127.0.0.1:3000/api/auth/device \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"local-till-1\",\"name\":\"Local Till\",\"branchId\":\"b_sip\",\"setupKey\":\"dev-setup\"}"
```

Paste the returned token into `frontend-sync-config.example.js` or `localStorage`.
