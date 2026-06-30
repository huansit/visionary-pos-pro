import { q } from "../db.js";
import { sendWhatsAppText, whatsappConfigured } from "./whatsappClient.js";
import {
  reportBranchSummary,
  reportCashierPerformance,
  reportExpenses,
  reportLowStock,
  reportOutstandingInvoices,
  reportSales,
} from "./whatsappData.js";
import { auditWhatsApp } from "./whatsappAudit.js";

let timer = null;
const sentKeys = new Set();

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function recipients() {
  const explicit = String(process.env.WHATSAPP_REPORT_RECIPIENTS || process.env.WHATSAPP_ALLOWED_PHONES || "")
    .split(",")
    .map((phone) => normalizePhone(phone.trim()))
    .filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  const result = await q("SELECT phone FROM credentials WHERE kind = 'admin' AND status = 'active' AND phone IS NOT NULL");
  return [...new Set(result.rows.map((row) => normalizePhone(row.phone)).filter(Boolean))];
}

async function sendReport(name, body) {
  const phones = await recipients();
  for (const phone of phones) {
    try {
      await sendWhatsAppText(phone, body);
      await auditWhatsApp("whatsapp_scheduled_report_sent", { phone, command: name, detail: { name } });
    } catch (error) {
      console.error("WhatsApp scheduled report failed:", error);
      await auditWhatsApp("whatsapp_scheduled_report_failed", { phone, command: name, status: "failed", detail: { error: error.message } });
    }
  }
}

async function maybeRunSchedule() {
  if (!whatsappConfigured()) return;
  const now = new Date();
  const time = now.toTimeString().slice(0, 5);
  const dailyTime = process.env.WHATSAPP_DAILY_REPORT_TIME || "18:00";
  if (time !== dailyTime) return;

  const dayKey = now.toISOString().slice(0, 10);
  const dailyKey = `daily:${dayKey}`;
  if (!sentKeys.has(dailyKey)) {
    sentKeys.add(dailyKey);
    await sendReport("daily_sales", await reportSales({ days: 1 }));
    await sendReport("outstanding_invoices", await reportOutstandingInvoices());
    await sendReport("expense_summary", await reportExpenses({ days: 1 }));
    await sendReport("low_stock", await reportLowStock());
    await sendReport("cashier_performance", await reportCashierPerformance());
    await sendReport("branch_performance", await reportBranchSummary());
  }

  if (now.getDay() === 1) {
    const weeklyKey = `weekly:${dayKey}`;
    if (!sentKeys.has(weeklyKey)) {
      sentKeys.add(weeklyKey);
      await sendReport("weekly_sales", await reportSales({ days: 7 }));
    }
  }

  if (now.getDate() === 1) {
    const monthlyKey = `monthly:${dayKey}`;
    if (!sentKeys.has(monthlyKey)) {
      sentKeys.add(monthlyKey);
      await sendReport("monthly_sales", await reportSales({ days: 30 }));
    }
  }
}

export function startWhatsAppScheduler() {
  if (timer || process.env.WHATSAPP_SCHEDULES_ENABLED !== "1" || process.env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    maybeRunSchedule().catch((error) => console.error("WhatsApp scheduler failed:", error));
  }, 60 * 1000);
}

export function stopWhatsAppScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
