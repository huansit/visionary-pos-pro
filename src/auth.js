import { verifyDeviceToken } from "./token.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { isMySql, q } from "./db.js";

function hashTerminalSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || ""), "utf8").digest("hex");
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function isActiveStatus(status) {
  return String(status || "ACTIVE").toUpperCase() === "ACTIVE";
}

async function requireTerminalHeaders(req) {
  const uuid = String(req.get("x-terminal-uuid") || "").trim();
  const secret = String(req.get("x-terminal-secret") || "").trim();
  if (!uuid || !secret) return null;

  const result = await q(
    "SELECT device_id, terminal_uuid, name, branch_id, terminal_secret_hash, revoked_at, status FROM devices WHERE terminal_uuid = $1",
    [uuid]
  );
  const terminal = result.rows[0];
  if (!terminal || terminal.revoked_at || !isActiveStatus(terminal.status)) return { error: "terminal_not_authorized" };
  if (!sameHash(hashTerminalSecret(secret), terminal.terminal_secret_hash ?? terminal.terminalSecretHash)) {
    return { error: "terminal_not_authorized" };
  }

  await q(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [terminal.device_id ?? terminal.deviceId]);
  return terminal;
}

// Require a valid device bearer token on protected routes.
// Sets req.deviceId for downstream handlers.
export async function requireDevice(req, res, next) {
  const hdr = req.get("authorization") || "";
  const queryToken = req.path === "/stream" && req.method === "GET" ? String(req.query?.token || "") : "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : queryToken || null;

  try {
    const terminal = await requireTerminalHeaders(req);
    if (terminal?.error) return res.status(401).json({ error: terminal.error });
    if (terminal) {
      req.deviceId = terminal.device_id ?? terminal.deviceId;
      req.terminalUuid = terminal.terminal_uuid ?? terminal.terminalUuid;
      req.deviceBranchId = terminal.branch_id ?? terminal.branchId;
      req.deviceName = terminal.name;
      return next();
    }

    const deviceId = verifyDeviceToken(token);
    if (!deviceId) return res.status(401).json({ error: "invalid_or_missing_device_token" });

    const result = await q(
      "SELECT device_id, name, branch_id, token_hash, revoked_at, status FROM devices WHERE device_id = $1",
      [deviceId]
    );
    const device = result.rows[0];
    if (!device || device.revoked_at || !isActiveStatus(device.status)) {
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
