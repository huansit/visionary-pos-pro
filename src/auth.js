import { verifyDeviceToken } from "./token.js";
import bcrypt from "bcryptjs";
import { isMySql, q } from "./db.js";

// Require a valid device bearer token on protected routes.
// Sets req.deviceId for downstream handlers.
export async function requireDevice(req, res, next) {
  const hdr = req.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  const deviceId = verifyDeviceToken(token);
  if (!deviceId) return res.status(401).json({ error: "invalid_or_missing_device_token" });

  try {
    const result = await q(
      "SELECT device_id, name, branch_id, token_hash, revoked_at, status FROM devices WHERE device_id = $1",
      [deviceId]
    );
    const device = result.rows[0];
    if (!device || device.revoked_at || (device.status && device.status !== "active")) {
      return res.status(401).json({ error: "device_not_authorized" });
    }
    const tokenOk = await bcrypt.compare(token, device.token_hash);
    if (!tokenOk) return res.status(401).json({ error: "device_not_authorized" });

    req.deviceId = device.device_id;
    req.deviceBranchId = device.branch_id;
    req.deviceName = device.name;
    await q(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [deviceId]);
    next();
  } catch (error) {
    next(error);
  }
}
