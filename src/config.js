const LIVE_ALIASES = new Set(["live", "prod", "production"]);
const TEST_ALIASES = new Set(["test", "sandbox", "staging", "development", "dev"]);

export function normalizeEnvironmentMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (LIVE_ALIASES.has(raw)) return "live";
  if (TEST_ALIASES.has(raw)) return "test";
  return process.env.NODE_ENV === "production" ? "live" : "test";
}

export function environmentLabel(mode = appMode) {
  return normalizeEnvironmentMode(mode) === "live" ? "LIVE MODE" : "TEST MODE";
}

export const appMode = normalizeEnvironmentMode(
  process.env.VISIONPOS_MODE ||
    process.env.VISIONPOS_ENVIRONMENT ||
    process.env.APP_ENVIRONMENT ||
    process.env.NODE_ENV
);

export const runtimeConfig = Object.freeze({
  mode: appMode,
  label: environmentLabel(appMode),
  databaseUrl: process.env.DATABASE_URL || "",
  publicAppUrl:
    process.env.PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (appMode === "live" ? "https://visionarypos.cloud" : "https://sandbox.visionarypos.cloud"),
});

export function publicEnvironment() {
  return { mode: runtimeConfig.mode, label: runtimeConfig.label };
}

export function assertStartupConfig() {
  if (process.env.PG_MEM === "1") return;

  const errors = [];
  const configuredMode = String(process.env.VISIONPOS_MODE || "").trim().toLowerCase();
  const weakSecret = (value) =>
    !value || value.length < 32 || /change-this|replace-with|dev-only|example/i.test(value);

  if (!LIVE_ALIASES.has(configuredMode) && !TEST_ALIASES.has(configuredMode)) {
    errors.push("VISIONPOS_MODE must be explicitly set to live or test");
  }
  if (!runtimeConfig.databaseUrl) {
    errors.push("DATABASE_URL is required");
  }
  try {
    const publicUrl = new URL(runtimeConfig.publicAppUrl);
    const local = ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
    if (publicUrl.protocol !== "https:" && !local) {
      errors.push("PUBLIC_APP_URL must use HTTPS");
    }
  } catch {
    errors.push("PUBLIC_APP_URL must be a valid URL");
  }

  const tokenSecret = process.env.DEVICE_TOKEN_SECRET || process.env.JWT_SECRET || "";
  if (weakSecret(tokenSecret)) {
    errors.push("DEVICE_TOKEN_SECRET (or JWT_SECRET) must be a non-placeholder secret of at least 32 characters");
  }

  if (runtimeConfig.mode === "live") {
    if (weakSecret(process.env.DEVICE_SETUP_KEY || "")) {
      errors.push("DEVICE_SETUP_KEY must be a non-placeholder secret of at least 32 characters in Live");
    }
    if (process.env.ADMIN_EMAIL_CODE_REQUIRED !== "0") {
      for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) {
        if (!String(process.env[name] || "").trim()) errors.push(`${name} is required in Live`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Invalid VisionPOS startup configuration:\n- ${errors.join("\n- ")}`);
  }
}
