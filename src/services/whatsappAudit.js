import { q } from "../db.js";

export function requestIp(req) {
  return String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

export async function auditWhatsApp(event, { userId = null, phone = null, command = "", status = "ok", detail = {}, req = null } = {}) {
  await q(
    `INSERT INTO auth_audit_log (user_id, event, device_name, ip_address, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      event,
      "whatsapp",
      requestIp(req),
      { phone, command, status, ...detail },
    ]
  );
}
