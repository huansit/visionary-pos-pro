import crypto from "node:crypto";
import "dotenv/config";

const SECRET =
  process.env.DEVICE_TOKEN_SECRET ||
  process.env.JWT_SECRET ||
  (process.env.PG_MEM === "1" || process.env.NODE_ENV === "test" ? "visionpos-test-device-token-secret-only" : "");

function deviceTokenSecret() {
  if (!SECRET) throw new Error("DEVICE_TOKEN_SECRET is required");
  return SECRET;
}

// A device token is "<deviceId>.<hmac>" — stateless, verifiable, no DB hit needed
// to authenticate, while the device row still gates issuance/revocation.
export function signDeviceToken(deviceId) {
  const mac = crypto.createHmac("sha256", deviceTokenSecret()).update(deviceId).digest("hex");
  return `${deviceId}.${mac}`;
}

export function verifyDeviceToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const deviceId = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", deviceTokenSecret()).update(deviceId).digest("hex");
  // constant-time compare
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return deviceId;
}
