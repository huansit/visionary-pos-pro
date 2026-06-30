import crypto from "node:crypto";
import { isMySql, q, serverNow } from "../db.js";
import { auditWhatsApp } from "./whatsappAudit.js";
import {
  generateReport,
  reportBranchSummary,
  reportCashierPerformance,
  reportExpenses,
  reportLowStock,
  reportOutstandingInvoices,
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

function confirmationCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function eventId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function authorizedAdmin(phone) {
  const allowed = String(process.env.WHATSAPP_ALLOWED_PHONES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.some((allowedPhone) => phoneMatches(phone, allowedPhone))) return { id: "env_allowlist", name: "WhatsApp Admin" };

  const result = await q(
    "SELECT id, name, phone, status FROM credentials WHERE kind = 'admin' AND status = 'active' AND phone IS NOT NULL"
  );
  return result.rows.find((row) => phoneMatches(phone, row.phone)) || null;
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

async function approveInvoice(invoiceNumber) {
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
      { invoiceId: invoice.id, invoiceNumber: invoice.payload?.number || number, approvedVia: "whatsapp", approvedAt: new Date().toISOString() },
    ]
  );
  return `Approval recorded for invoice ${invoice.payload?.number || number}.`;
}

async function requestTerminalRestart(terminalName) {
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
      { action: "restart", terminalName: terminal.name, requestedVia: "whatsapp", requestedAt: new Date().toISOString() },
    ]
  );
  return `Restart requested for terminal ${terminal.name}.`;
}

const commands = [
  { name: "today_sales", pattern: /^(today'?s sales|today sales|sales today)$/i, run: () => reportSales({ days: 1 }) },
  { name: "weekly_sales", pattern: /^(sales this week|weekly sales)$/i, run: () => reportSales({ days: 7 }) },
  { name: "monthly_sales", pattern: /^monthly sales$/i, run: () => reportSales({ days: 30 }) },
  { name: "outstanding_invoices", pattern: /^outstanding invoices$/i, run: () => reportOutstandingInvoices() },
  { name: "expense_summary", pattern: /^expense summary$/i, run: () => reportExpenses({ days: 7 }) },
  { name: "low_stock", pattern: /^low stock$/i, run: () => reportLowStock() },
  { name: "branch_summary", pattern: /^branch summary$/i, run: () => reportBranchSummary() },
  { name: "cashier_performance", pattern: /^cashier performance$/i, run: () => reportCashierPerformance() },
  { name: "search_product", pattern: /^search product\s+(.+)$/i, run: ([, term]) => searchProducts(term) },
  { name: "search_customer", pattern: /^search customer\s+(.+)$/i, run: ([, term]) => searchCustomers(term) },
  { name: "generate_report", pattern: /^generate report(?:\s+(.+))?$/i, run: ([, name]) => generateReport(name || "daily sales") },
  { name: "approve_invoice", pattern: /^approve invoice\s+(.+)$/i, sensitive: true, run: ([, number]) => approveInvoice(number) },
  { name: "disable_employee", pattern: /^disable employee\s+(.+)$/i, sensitive: true, run: ([, id]) => disableEmployee(id) },
  { name: "enable_employee", pattern: /^enable employee\s+(.+)$/i, sensitive: true, run: ([, id]) => enableEmployee(id) },
  { name: "restart_terminal", pattern: /^restart terminal\s+(.+)$/i, sensitive: true, run: ([, name]) => requestTerminalRestart(name) },
];

function helpText() {
  return [
    "VisionPOS WhatsApp commands:",
    "- Today's sales",
    "- Sales this week",
    "- Outstanding invoices",
    "- Low stock",
    "- Branch summary",
    "- Search product <name>",
    "- Search customer <name>",
    "- Generate report <daily sales|weekly sales|monthly sales|expense summary|low stock>",
    "- Approve invoice <number>",
    "- Disable employee <employee number>",
    "- Enable employee <employee number>",
    "- Restart terminal <terminal name>",
  ].join("\n");
}

async function runPendingConfirmation(phone, text, req) {
  const match = String(text || "").trim().match(/^yes\s+([A-Z0-9]{6})$/i);
  if (!match) return null;
  const pending = pendingConfirmations.get(normalizePhone(phone));
  if (!pending || pending.expiresAt < Date.now() || pending.code !== match[1].toUpperCase()) {
    pendingConfirmations.delete(normalizePhone(phone));
    return "Confirmation expired or invalid. Please send the command again.";
  }
  pendingConfirmations.delete(normalizePhone(phone));
  await auditWhatsApp("whatsapp_command_confirmed", { phone, command: pending.commandText, status: "confirmed", req });
  const result = await pending.command.run(pending.match);
  await auditWhatsApp("whatsapp_command_completed", { phone, command: pending.commandText, status: "ok", detail: { commandName: pending.command.name }, req });
  return result;
}

export async function processWhatsAppCommand({ from, text, req }) {
  const phone = normalizePhone(from);
  const commandText = String(text || "").trim();
  await auditWhatsApp("whatsapp_command_received", { phone, command: commandText, req });

  const admin = await authorizedAdmin(phone);
  if (!admin) {
    await auditWhatsApp("whatsapp_command_denied", { phone, command: commandText, status: "unauthorized", req });
    return "This phone number is not authorized for VisionPOS WhatsApp commands.";
  }

  const confirmed = await runPendingConfirmation(phone, commandText, req);
  if (confirmed) return confirmed;

  if (!commandText || /^help$/i.test(commandText)) return helpText();

  for (const command of commands) {
    const match = commandText.match(command.pattern);
    if (!match) continue;
    if (command.sensitive) {
      const code = confirmationCode();
      pendingConfirmations.set(phone, {
        code,
        command,
        match,
        commandText,
        expiresAt: Date.now() + CONFIRM_TTL_MS,
      });
      await auditWhatsApp("whatsapp_command_confirmation_required", { phone, command: commandText, status: "pending", detail: { commandName: command.name }, req });
      return `Confirm this action by replying: YES ${code}\nThis code expires in 5 minutes.`;
    }
    const result = await command.run(match);
    await auditWhatsApp("whatsapp_command_completed", { phone, command: commandText, status: "ok", detail: { commandName: command.name }, req });
    return result;
  }

  await auditWhatsApp("whatsapp_command_unknown", { phone, command: commandText, status: "unknown", req });
  return `I did not recognize that command.\n\n${helpText()}`;
}
