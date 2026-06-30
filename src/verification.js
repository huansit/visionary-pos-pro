import nodemailer from "nodemailer";

export function normalizeTarget(channel, target) {
  const raw = String(target || "").trim();
  if (channel === "email") return raw.toLowerCase();
  if (channel === "phone") return raw.replace(/[\s-]/g, "");
  return raw;
}

export function validTarget(channel, target) {
  if (channel === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target);
  if (channel === "phone") return /^(?:\+254\d{9}|0\d{9})$/.test(target);
  return false;
}

export function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function sendVerificationCode({ channel, target, code }) {
  if (channel === "email") return sendEmailCode(target, code);
  if (channel === "phone") return sendSmsCode(target, code);
  throw Object.assign(new Error("unsupported_channel"), { statusCode: 400 });
}

export async function sendPasswordResetEmail({ target, resetUrl, expiresInMinutes = 30 }) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw Object.assign(new Error("email_provider_not_configured"), { statusCode: 503 });
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM || SMTP_USER,
    to: target,
    subject: "Reset your VisionPOS admin password",
    text: [
      "We received a request to reset your VisionPOS admin password.",
      "",
      `Open this secure link within ${expiresInMinutes} minutes:`,
      resetUrl,
      "",
      "If you did not request this, ignore this email. Your password will not change."
    ].join("\n"),
    html: `<p>We received a request to reset your VisionPOS admin password.</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700">Reset password</a></p>
      <p>This secure link expires in <b>${expiresInMinutes} minutes</b>.</p>
      <p>If you did not request this, ignore this email. Your password will not change.</p>`
  });
}

async function sendEmailCode(target, code) {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw Object.assign(new Error("email_provider_not_configured"), { statusCode: 503 });
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM || SMTP_USER,
    to: target,
    subject: "Your Visionary POS verification code",
    text: `Your Visionary POS verification code is ${code}. It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.`,
    html: `<p>Your Visionary POS verification code is <b>${code}</b>.</p><p>It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.</p>`
  });
}

async function sendSmsCode(target, code) {
  const { AFRICASTALKING_USERNAME, AFRICASTALKING_API_KEY } = process.env;
  if (!AFRICASTALKING_USERNAME || !AFRICASTALKING_API_KEY) {
    throw Object.assign(new Error("sms_provider_not_configured"), { statusCode: 503 });
  }

  const normalized = target.startsWith("0") ? "+254" + target.slice(1) : target;
  const params = new URLSearchParams({
    username: AFRICASTALKING_USERNAME,
    to: normalized,
    message: `Your Visionary POS verification code is ${code}. It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.`
  });
  if (process.env.SMS_FROM) params.set("from", process.env.SMS_FROM);

  const response = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      apiKey: AFRICASTALKING_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(`sms_send_failed:${body}`), { statusCode: 502 });
  }
}
