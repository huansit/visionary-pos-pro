// Register a till and print its bearer token. Run on the VPS:
//   node db/make-device.js till-sipcity-01 "SIPCITY till" b_sip
import bcrypt from "bcryptjs";
import { q, pool } from "../src/db.js";
import { signDeviceToken } from "../src/token.js";

const [, , deviceId, name, branchId = null] = process.argv;
if (!deviceId || !name) {
  console.error('usage: node db/make-device.js <deviceId> "<name>" [branchId]');
  process.exit(1);
}
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

const token = signDeviceToken(deviceId);
const tokenHash = await bcrypt.hash(token, ROUNDS);
await q(
  `INSERT INTO devices (device_id, name, branch_id, token_hash, revoked_at, last_seen_at)
   VALUES ($1,$2,$3,$4,NULL, now())
   ON CONFLICT (device_id) DO UPDATE SET
     name=EXCLUDED.name,
     branch_id=EXCLUDED.branch_id,
     token_hash=EXCLUDED.token_hash,
     revoked_at=NULL,
     last_seen_at=now()`,
  [deviceId, name, branchId, tokenHash]
);
console.log("device:", deviceId);
console.log("token :", token);
console.log("\nPut this token in the till's front-end as the Authorization: Bearer <token> header.");
await pool.end();
