import { appMode, environmentLabel, normalizeEnvironmentMode, publicEnvironment, runtimeConfig } from "./config.js";

export { environmentLabel, normalizeEnvironmentMode };

function redactDatabaseUrl(url) {
  if (!url) return "not configured";
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username.slice(0, 2)}***` : "***";
    parsed.username = user;
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return "configured";
  }
}

export function configuredEnvironmentMode() {
  return appMode;
}

export function environmentConfig() {
  return {
    mode: appMode,
    label: environmentLabel(appMode),
    database: redactDatabaseUrl(runtimeConfig.databaseUrl),
    api: runtimeConfig.publicAppUrl,
    version: process.env.npm_package_version || "0.1.0",
  };
}

export async function ensureEnvironmentSchema() {
  // Runtime environment switching has been removed. Each deployment starts with one DATABASE_URL.
}

export async function getActiveEnvironmentMode() {
  return appMode;
}

export async function getSwitchBlockers() {
  return [];
}

export function sameEnvironment(left, right) {
  return normalizeEnvironmentMode(left) === normalizeEnvironmentMode(right);
}

export async function getEnvironmentState() {
  return {
    ...publicEnvironment(),
    config: environmentConfig(),
    blockers: [],
  };
}
