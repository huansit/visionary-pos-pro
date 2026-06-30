import crypto from "node:crypto";
import { isMySql, q, serverNow } from "../db.js";
import { auditWhatsApp } from "./whatsappAudit.js";
import {
  generateReport,
  reportBranchSummary,
  reportCashierPerformance,
  reportExpenses,
  reportInventoryStatus,
  reportLowStock,
  reportOutstandingInvoices,
  reportPendingInvoices,
  reportSales,
  searchCustomers,
  searchProducts,
} from "./whatsappData.js";

const pendingConfirmations = new Map();
const CONFIRM_TTL_MS = 5 * 60 * 1000;

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function phoneMatches(a, b) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return Boolean(left && right && (left === right || left.endsWith(right) || right.endsWith(left)));
}

function eventId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function readRights(row) {
  const rights = row?.rights && typeof row.rights === "object" ? row.rights : {};
  if (Array.isArray(rights)) return rights;
  if (Array.isArray(rights.rights)) return rights.rights;
  return rights.admin ? ["admin"] : [];
}

function roleFromCredential(row, source = "credentials") {
  if (!row) return null;
  const rights = readRights(row);
  const explicit = String(row.role || row.rights?.role || "").toUpperCase();
  if (source === "owner_env" || row.kind === "admin" || rights.includes("admin")) return "OWNER";
  if (explicit === "OWNER" || explicit === "ADMIN" || explicit === "SUPERVISOR") return explicit;
  if (rights.includes("financials") || rights.includes("branches") || rights.includes("products") || rights.includes("approve_expenses")) return "ADMIN";
  return "SUPERVISOR";
}

async function verifyWhatsAppUser(phone) {
  const allowed = String(process.env.WHATSAPP_ALLOWED_PHONES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const owners = String(process.env.WHATSAPP_OWNER_PHONES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const admins = String(process.env.WHATSAPP_ADMIN_PHONES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const supervisors = String(process.env.WHATSAPP_SUPERVISOR_PHONES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (owners.some((allowedPhone) => phoneMatches(phone, allowedPhone))) return { id: "env_owner", name: "WhatsApp Owner", role: "OWNER", source: "owner_env" };
  if (admins.some((allowedPhone) => phoneMatches(phone, allowedPhone))) return { id: "env_admin", name: "WhatsApp Admin", role: "ADMIN", source: "admin_env" };
  if (supervisors.some((allowedPhone) => phoneMatches(phone, allowedPhone))) return { id: "env_supervisor", name: "WhatsApp Supervisor", role: "SUPERVISOR", source: "supervisor_env" };
  if (allowed.some((allowedPhone) => phoneMatches(phone, allowedPhone))) return { id: "env_owner", name: "WhatsApp Owner", role: "OWNER", source: "legacy_allowlist" };

  const result = await q(
    "SELECT id, kind, name, phone, rights, status FROM credentials WHERE status = 'active' AND phone IS NOT NULL"
  );
  const row = result.rows.find((credential) => phoneMatches(phone, credential.phone));
  if (!row) return null;
  return { ...row, role: roleFromCredential(row), source: "credentials" };
}

async function disableEmployee(employeeNumber) {
  const id = String(employeeNumber || "").trim();
  const existing = await q("SELECT id, name FROM credentials WHERE id = $1 AND kind IN ('user', 'cashier') AND status <> 'deleted'", [id]);
  if (!existing.rows.length) return `No active employee found for ${id}.`;
  await q(`UPDATE credentials SET status = 'inactive', updated_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [id]);
  return `Disabled employee ${existing.rows[0].name || id}.`;
}

async function enableEmployee(employeeNumber) {
  const id = String(employeeNumber || "").trim();
  const existing = await q("SELECT id, name FROM credentials WHERE id = $1 AND kind IN ('user', 'cashier') AND status <> 'deleted'", [id]);
  if (!existing.rows.length) return `No employee found for ${id}.`;
  await q(`UPDATE credentials SET status = 'active', updated_at = ${isMySql ? "NOW()" : "now()"} WHERE id = $1`, [id]);
  return `Enabled employee ${existing.rows[0].name || id}.`;
}

async function approveInvoice(invoiceNumber, actor = null) {
  const number = String(invoiceNumber || "").trim();
  const result = await q("SELECT id, payload FROM events WHERE type = 'invoice'");
  const invoice = result.rows.find((row) => {
    const payload = row.payload || {};
    return [row.id, payload.id, payload.number, payload.receiptNo].some((value) => String(value || "").toLowerCase() === number.toLowerCase());
  });
  if (!invoice) return `Invoice ${number} was not found.`;
  await q(
    isMySql
      ? `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`
      : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
    [
      eventId("wa_invoice_approval"),
      "invoiceApproval",
      invoice.payload?.branchId || null,
      serverNow(),
      serverNow(),
      { invoiceId: invoice.id, invoiceNumber: invoice.payload?.number || number, approvedBy: actor?.id || null, approvedByName: actor?.name || null, approvedByRole: actor?.role || null, approvedVia: "whatsapp", approvedAt: new Date().toISOString() },
    ]
  );
  return `Approval recorded for invoice ${invoice.payload?.number || number}.`;
}

async function rejectInvoice(invoiceNumber, actor = null) {
  const number = String(invoiceNumber || "").trim();
  const result = await q("SELECT id, payload FROM events WHERE type = 'invoice'");
  const invoice = result.rows.find((row) => {
    const payload = row.payload || {};
    return [row.id, payload.id, payload.number, payload.receiptNo].some((value) => String(value || "").toLowerCase() === number.toLowerCase());
  });
  if (!invoice) return `Invoice ${number} was not found.`;
  await q(
    isMySql
      ? `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`
      : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
    [
      eventId("wa_invoice_rejection"),
      "invoiceRejection",
      invoice.payload?.branchId || null,
      serverNow(),
      serverNow(),
      { invoiceId: invoice.id, invoiceNumber: invoice.payload?.number || number, rejectedBy: actor?.id || null, rejectedByName: actor?.name || null, rejectedByRole: actor?.role || null, rejectedVia: "whatsapp", rejectedAt: new Date().toISOString() },
    ]
  );
  return `Rejection recorded for invoice ${invoice.payload?.number || number}.`;
}

async function requestTerminalRestart(terminalName, actor = null) {
  const name = String(terminalName || "").trim();
  const result = await q("SELECT device_id, name, branch_id FROM devices WHERE lower(name) = lower($1) AND status = 'ACTIVE'", [name]);
  const terminal = result.rows[0];
  if (!terminal) return `No active terminal found named ${name}.`;
  await q(
    isMySql
      ? `INSERT IGNORE INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`
      : `INSERT INTO events (id, type, branch_id, device_id, client_ts, server_ts, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
    [
      eventId("wa_terminal_command"),
      "terminalCommand",
      terminal.branch_id ?? terminal.branchId ?? null,
      terminal.device_id ?? terminal.deviceId,
      serverNow(),
      serverNow(),
      { action: "restart", terminalName: terminal.name, requestedBy: actor?.id || null, requestedByName: actor?.name || null, requestedVia: "whatsapp", requestedAt: new Date().toISOString() },
    ]
  );
  return `Restart requested for terminal ${terminal.name}.`;
}

const ROLE_LEVEL = { SUPERVISOR: 1, ADMIN: 2, OWNER: 3 };

function canRunCommand(actor, command) {
  if (!actor?.role) return false;
  if (ROLE_LEVEL[actor.role] >= ROLE_LEVEL[command.minRole || "OWNER"]) return true;
  return (command.roles || []).includes(actor.role);
}

const commands = [
  { name: "today_sales", pattern: /^(today'?s sales|today sales|sales today|branch sales|view branch sales)$/i, minRole: "SUPERVISOR", run: () => reportSales({ days: 1 }) },
  { name: "weekly_sales", pattern: /^(sales this week|weekly sales)$/i, minRole: "ADMIN", run: () => reportSales({ days: 7 }) },
  { name: "monthly_sales", pattern: /^monthly sales$/i, minRole: "ADMIN", run: () => reportSales({ days: 30 }) },
  { name: "outstanding_invoices", pattern: /^(outstanding invoices|pending invoices|view pending invoices)$/i, minRole: "SUPERVISOR", run: () => reportPendingInvoices() },
  { name: "expense_summary", pattern: /^(expense summary|daily expenses|view daily expenses)$/i, minRole: "SUPERVISOR", run: () => reportExpenses({ days: 1 }) },
  { name: "low_stock", pattern: /^(low stock|low stock products|view low stock products)$/i, minRole: "SUPERVISOR", run: () => reportLowStock() },
  { name: "inventory_status", pattern: /^(inventory status|view inventory status)$/i, minRole: "SUPERVISOR", run: () => reportInventoryStatus() },
  { name: "branch_summary", pattern: /^branch summary$/i, minRole: "ADMIN", run: () => reportBranchSummary() },
  { name: "cashier_performance", pattern: /^(cashier performance|cashier activity|view cashier activity)$/i, minRole: "SUPERVISOR", run: () => reportCashierPerformance() },
  { name: "search_product", pattern: /^search product\s+(.+)$/i, minRole: "ADMIN", run: ([, term]) => searchProducts(term) },
  { name: "search_customer", pattern: /^search customer\s+(.+)$/i, minRole: "ADMIN", run: ([, term]) => searchCustomers(term) },
  { name: "generate_report", pattern: /^generate report(?:\s+(.+))?$/i, minRole: "ADMIN", run: ([, name]) => generateReport(name || "daily sales") },
  { name: "approve_invoice", pattern: /^approve invoice\s+(.+)$/i, minRole: "SUPERVISOR", sensitive: true, run: ([, number], actor) => approveInvoice(number, actor) },
  { name: "reject_invoice", pattern: /^reject invoice\s+(.+)$/i, minRole: "SUPERVISOR", sensitive: true, run: ([, number], actor) => rejectInvoice(number, actor) },
  { name: "disable_employee", pattern: /^disable employee\s+(.+)$/i, minRole: "ADMIN", sensitive: true, run: ([, id]) => disableEmployee(id) },
  { name: "enable_employee", pattern: /^enable employee\s+(.+)$/i, minRole: "ADMIN", sensitive: true, run: ([, id]) => enableEmployee(id) },
  { name: "restart_terminal", pattern: /^restart terminal\s+(.+)$/i, minRole: "ADMIN", sensitive: true, run: ([, name], actor) => requestTerminalRestart(name, actor) },
];

function helpText() {
  return [
    "VisionPOS WhatsApp commands:",
    "- Today's sales",
    "- Sales this week",
    "- Outstanding invoices",
    "- Low stock",
    "- Inventory status",
    "- Branch summary",
    "- Search product <name>",
    "- Search customer <name>",
    "- Generate report <daily sales|weekly sales|monthly sales|expense summary|low stock>",
    "- Approve invoice <number>",
    "- Reject invoice <number>",
    "- Disable employee <employee number>",
    "- Enable employee <employee number>",
    "- Restart terminal <terminal name>",
  ].join("\n");
}

async function runPendingConfirmation(actor, phone, text, req) {
  const match = String(text || "").trim().match(/^(confirm|yes)$/i);
  if (!match) return null;
  const pending = pendingConfirmations.get(normalizePhone(phone));
  if (!pending || pending.expiresAt < Date.now()) {
    pendingConfirmations.delete(normalizePhone(phone));
    return "Confirmation expired or invalid. Please send the command again.";
  }
  if (!canRunCommand(actor, pending.command)) {
    await auditWhatsApp("whatsapp_command_denied", { userId: actor?.id, phone, command: pending.commandText, status: "forbidden_after_confirmation", detail: { commandName: pending.command.name, role: actor?.role }, req });
    pendingConfirmations.delete(normalizePhone(phone));
    return "You are not allowed to complete that WhatsApp action.";
  }
  pendingConfirmations.delete(normalizePhone(phone));
  await auditWhatsApp("whatsapp_command_confirmed", { userId: actor?.id, phone, command: pending.commandText, status: "confirmed", detail: { role: actor?.role }, req });
  const result = await pending.command.run(pending.match, actor);
  await auditWhatsApp("whatsapp_command_completed", { userId: actor?.id, phone, command: pending.commandText, status: "ok", detail: { commandName: pending.command.name, role: actor?.role }, req });
  return result;
}

export async function processWhatsAppCommand({ from, text, req }) {
  const phone = normalizePhone(from);
  const commandText = String(text || "").trim();
  await auditWhatsApp("whatsapp_command_received", { phone, command: commandText, req });

  const actor = await verifyWhatsAppUser(phone);
  if (!actor) {
    await auditWhatsApp("whatsapp_command_denied", { phone, command: commandText, status: "unauthorized", req });
    return "This phone number is not authorized for VisionPOS WhatsApp commands.";
  }
  await auditWhatsApp("whatsapp_user_verified", { userId: actor.id, phone, command: commandText, status: "ok", detail: { role: actor.role, source: actor.source }, req });

  const confirmed = await runPendingConfirmation(actor, phone, commandText, req);
  if (confirmed) return confirmed;

  if (!commandText || /^help$/i.test(commandText)) return helpText();

  for (const command of commands) {
    const match = commandText.match(command.pattern);
    if (!match) continue;
    if (!canRunCommand(actor, command)) {
      await auditWhatsApp("whatsapp_command_denied", { userId: actor.id, phone, command: commandText, status: "forbidden", detail: { commandName: command.name, role: actor.role, minRole: command.minRole }, req });
      return `You are signed in as ${actor.role}. This WhatsApp command is not allowed for your role.`;
    }
    if (command.sensitive) {
      pendingConfirmations.set(phone, {
        command,
        match,
        commandText,
        expiresAt: Date.now() + CONFIRM_TTL_MS,
      });
      await auditWhatsApp("whatsapp_command_confirmation_required", { userId: actor.id, phone, command: commandText, status: "pending", detail: { commandName: command.name, role: actor.role }, req });
      return `Please confirm ${commandText}. Reply CONFIRM.\nThis confirmation expires in 5 minutes.`;
    }
    const result = await command.run(match, actor);
    await auditWhatsApp("whatsapp_command_completed", { userId: actor.id, phone, command: commandText, status: "ok", detail: { commandName: command.name, role: actor.role }, req });
    return result;
  }

  await auditWhatsApp("whatsapp_command_unknown", { userId: actor.id, phone, command: commandText, status: "unknown", detail: { role: actor.role }, req });
  return `I did not recognize that command.\n\n${helpText()}`;
}
