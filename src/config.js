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
  if (!runtimeConfig.databaseUrl) {
    throw new Error("DATABASE_URL is required. Start VisionPOS with .env.live or .env.test.");
  }
}
