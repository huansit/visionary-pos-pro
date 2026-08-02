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

  if (process.env.KOPOKOPO_ENABLED === "1") {
    const kopokopoMode = String(process.env.KOPOKOPO_MODE || "").trim().toLowerCase();
    if (!new Set(["sandbox", "live"]).has(kopokopoMode)) {
      errors.push("KOPOKOPO_MODE must be explicitly set to sandbox or live when Kopo Kopo is enabled");
    }
    const expectedProviderOrigin = kopokopoMode === "live"
      ? "https://api.kopokopo.com"
      : "https://sandbox.kopokopo.com";
    const expectedAuthOrigin = kopokopoMode === "live"
      ? "https://app.kopokopo.com"
      : "https://sandbox.kopokopo.com";
    try {
      const providerUrl = new URL(process.env.KOPOKOPO_BASE_URL || expectedProviderOrigin);
      if (providerUrl.protocol !== "https:" || providerUrl.origin !== expectedProviderOrigin) {
        errors.push(`KOPOKOPO_BASE_URL must use the official ${kopokopoMode || "selected"} Kopo Kopo HTTPS origin`);
      }
    } catch {
      errors.push("KOPOKOPO_BASE_URL must be a valid official Kopo Kopo HTTPS URL");
    }
    try {
      const authUrl = new URL(process.env.KOPOKOPO_AUTH_URL || expectedAuthOrigin);
      if (authUrl.protocol !== "https:" || authUrl.origin !== expectedAuthOrigin) {
        errors.push(`KOPOKOPO_AUTH_URL must use the official ${kopokopoMode || "selected"} Kopo Kopo OAuth HTTPS origin`);
      }
    } catch {
      errors.push("KOPOKOPO_AUTH_URL must be a valid official Kopo Kopo OAuth HTTPS URL");
    }
    for (const name of ["KOPOKOPO_CLIENT_ID", "KOPOKOPO_CLIENT_SECRET", "KOPOKOPO_API_KEY", "KOPOKOPO_WEBHOOK_URL"]) {
      if (!String(process.env[name] || "").trim()) errors.push(`${name} is required when Kopo Kopo is enabled`);
    }
    try {
      const webhookUrl = new URL(process.env.KOPOKOPO_WEBHOOK_URL || "");
      if (webhookUrl.protocol !== "https:") errors.push("KOPOKOPO_WEBHOOK_URL must use HTTPS");
    } catch {
      errors.push("KOPOKOPO_WEBHOOK_URL must be a valid HTTPS URL");
    }
    const scope = String(process.env.KOPOKOPO_SCOPE || "company").trim().toLowerCase();
    if (!new Set(["company", "till"]).has(scope)) errors.push("KOPOKOPO_SCOPE must be company or till");
    if (scope === "till" && !String(process.env.KOPOKOPO_SCOPE_REFERENCE || "").trim()) {
      errors.push("KOPOKOPO_SCOPE_REFERENCE is required for till scope");
    }
    if (kopokopoMode === "sandbox" && !String(process.env.KOPOKOPO_SANDBOX_BRANCH_ID || "").trim()) {
      errors.push("KOPOKOPO_SANDBOX_BRANCH_ID is required in sandbox mode");
    }
    if (kopokopoMode === "live") {
      try {
        const tillMap = JSON.parse(process.env.KOPOKOPO_TILL_BRANCH_MAP || "{}");
        const entries = tillMap && !Array.isArray(tillMap) && typeof tillMap === "object"
          ? Object.entries(tillMap)
          : [];
        if (entries.length === 0) {
          errors.push("KOPOKOPO_TILL_BRANCH_MAP must map at least one live till to a branch");
        } else if (entries.some(([till, branchId]) => !String(till).trim() || !String(branchId).trim())) {
          errors.push("KOPOKOPO_TILL_BRANCH_MAP cannot contain blank till numbers or branch IDs");
        } else {
          const mappedBranches = entries.map(([, branchId]) => String(branchId).trim());
          if (new Set(mappedBranches).size !== mappedBranches.length) {
            errors.push("KOPOKOPO_TILL_BRANCH_MAP must map only one live till to each branch");
          }
          if (scope === "till") {
            const scopeReference = String(process.env.KOPOKOPO_SCOPE_REFERENCE || "").trim();
            if (entries.length !== 1 || String(entries[0][0]).trim() !== scopeReference) {
              errors.push("Till-scoped live Kopo Kopo configuration must map exactly KOPOKOPO_SCOPE_REFERENCE; use company scope for multiple tills");
            }
          }
        }
      } catch {
        errors.push("KOPOKOPO_TILL_BRANCH_MAP must be valid JSON");
      }
    }
  }

  if (errors.length) {
    throw new Error(`Invalid VisionPOS startup configuration:\n- ${errors.join("\n- ")}`);
  }
}

