import { verifyDeviceToken } from "./token.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { isMySql, q } from "./db.js";
import { ensureEnvironmentSchema, getActiveEnvironmentMode, sameEnvironment } from "./environment.js";

const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager", "supervisor"]);

function hashTerminalSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || ""), "utf8").digest("hex");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function sameHash(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function isActiveStatus(status) {
  return String(status || "ACTIVE").toUpperCase() === "ACTIVE";
}

function sessionTokenFromRequest(req) {
  const explicit = String(req.get("x-session-token") || "").trim();
  if (explicit) return explicit;
  const hdr = req.get("authorization") || "";
  if (/^Bearer\s+/i.test(hdr)) return hdr.replace(/^Bearer\s+/i, "").trim();
  return String(req.body?.sessionToken || req.query?.sessionToken || "").trim();
}

function normalizeRights(rights) {
  if (Array.isArray(rights)) return { rights };
  if (rights && typeof rights === "object") return rights;
  return {};
}

function roleFromAccount(row) {
  const rights = normalizeRights(row?.rights);
  const storedRole = rights.role || rights.name || rights.accountRole;
  if (storedRole) return String(storedRole);
  if (row?.kind === "admin") return "Admin";
  if (row?.kind === "cashier") return "Cashier";
  return "Supervisor";
}

function publicAccount(row) {
  const rights = normalizeRights(row?.rights);
  const role = roleFromAccount(row);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    role,
    branchId: row.branch_id ?? row.branchId ?? null,
    rights: rights.rights || rights,
    status: row.status || "active",
    emailVerified: Boolean(row.email_verified ?? row.emailVerified),
  };
}

function roleKey(account) {
  return String(account?.role || account?.kind || "").trim().toLowerCase();
}

async function requireTerminalHeaders(req) {
  const uuid = String(req.get("x-terminal-uuid") || "").trim();
  const secret = String(req.get("x-terminal-secret") || "").trim();
  if (!uuid || !secret) return null;
  await ensureEnvironmentSchema();
  const activeEnvironment = await getActiveEnvironmentMode();

  const result = await q(
    "SELECT device_id, terminal_uuid, name, branch_id, terminal_secret_hash, revoked_at, status, environment FROM devices WHERE terminal_uuid = $1",
    [uuid]
  );
  const terminal = result.rows[0];
  if (!terminal || terminal.revoked_at || !isActiveStatus(terminal.status)) return { error: "terminal_not_authorized" };
  if (!sameEnvironment(terminal.environment, activeEnvironment)) return { error: "terminal_environment_mismatch" };
  if (!sameHash(hashTerminalSecret(secret), terminal.terminal_secret_hash ?? terminal.terminalSecretHash)) {
    return { error: "terminal_not_authorized" };
  }

  await q(`UPDATE devices SET last_seen_at = ${isMySql ? "NOW()" : "now()"} WHERE device_id = $1`, [terminal.device_id ?? terminal.deviceId]);
  return terminal;
}

export async function loadUserSession(token) {
  if (!token) return null;
  await ensureEnvironmentSchema();
  const activeEnvironment = await getActiveEnvironmentMode();
  const result = await q(
    `SELECT s.id AS session_id, s.expires_at, s.is_active, s.device_id, s.terminal_uuid, s.environment,
            c.id, c.kind, c.name, c.email, c.phone, c.branch_id, c.rights, c.status, c.email_verified
       FROM user_sessions s
       JOIN credentials c ON c.id = s.user_id
      WHERE s.token_hash = $1
        AND s.is_active = true
        AND s.expires_at > ${isMySql ? "NOW()" : "now()"}
        AND c.status = 'active'
      LIMIT 1`,
    [tokenHash(token)]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!sameEnvironment(row.environment, activeEnvironment)) {
    await q("UPDATE user_sessions SET is_active = false WHERE id = $1", [row.session_id ?? row.sessionId]);
    return null;
  }
  const sessionTerminalUuid = row.terminal_uuid ?? row.terminalUuid ?? null;
  const sessionDeviceId = row.device_id ?? row.deviceId ?? null;
  if (sessionTerminalUuid || sessionDeviceId) {
    const terminalResult = await q(
      `SELECT device_id, terminal_uuid, status, revoked_at, environment
         FROM devices
        WHERE ${sessionTerminalUuid ? "terminal_uuid = $1" : "device_id = $1"}
        LIMIT 1`,
      [sessionTerminalUuid || sessionDeviceId]
    );
    const terminal = terminalResult.rows[0];
    if (!terminal || terminal.revoked_at || !isActiveStatus(terminal.status) || !sameEnvironment(terminal.environment, activeEnvironment)) {
      await q("UPDATE user_sessions SET is_active = false WHERE id = $1", [row.session_id ?? row.sessionId]);
      return null;
    }
  }
  await q(`UPDATE user_sessions SET last_seen = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [row.session_id ?? row.sessionId]);
  return { sessionId: row.session_id ?? row.sessionId, account: publicAccount(row) };
}

export async function requireUserSession(req, res, next) {
  try {
    const token = sessionTokenFromRequest(req);
    const session = await loadUserSession(token);
    if (!session) return res.status(401).json({ error: "invalid_or_missing_user_session" });
    req.sessionId = session.sessionId;
    req.account = session.account;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireRoles(roles = MANAGEMENT_ROLES) {
  const allowed = new Set([...roles].map((role) => String(role).toLowerCase()));
  return [
    requireUserSession,
    (req, res, next) => {
      if (!allowed.has(roleKey(req.account))) {
        return res.status(403).json({ error: "insufficient_role" });
      }
      return next();
    },
  ];
}

export const requireAdminOrSupervisor = requireRoles(MANAGEMENT_ROLES);
export const requireOwnerOrAdmin = requireRoles(new Set(["owner", "admin"]));

// Require a valid device bearer token on protected routes.
// Sets req.deviceId for downstream handlers.
export async function requireDevice(req, res, next) {
  const hdr = req.get("authorization") || "";
  const queryToken = req.path === "/stream" && req.method === "GET" ? String(req.query?.token || "") : "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : queryToken || null;

  try {
    await ensureEnvironmentSchema();
    const activeEnvironment = await getActiveEnvironmentMode();
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
      "SELECT device_id, name, branch_id, token_hash, revoked_at, status, environment FROM devices WHERE device_id = $1",
      [deviceId]
    );
    const device = result.rows[0];
    if (!device || device.revoked_at || !isActiveStatus(device.status) || !sameEnvironment(device.environment, activeEnvironment)) {
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
