import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const configUrl = pathToFileURL(join(process.cwd(), "src", "config.js")).href;

function validateConfig(overrides) {
  const cwd = mkdtempSync(join(tmpdir(), "visionpos-config-"));
  try {
    return spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `import('${configUrl}').then((m) => m.assertStartupConfig())`],
      {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          Path: process.env.Path,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          ...overrides,
        },
      }
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("production startup rejects missing mode and secrets", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VISIONPOS_MODE must be explicitly set/);
  assert.match(result.stderr, /DEVICE_TOKEN_SECRET/);
  assert.match(result.stderr, /DEVICE_SETUP_KEY/);
});

test("live startup accepts explicit secure configuration", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "mail@example.com",
    SMTP_PASS: "mail-password",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("sandbox startup does not require live-only setup and SMTP secrets", () => {
  const result = validateConfig({
    NODE_ENV: "sandbox",
    VISIONPOS_MODE: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_test",
    PUBLIC_APP_URL: "https://sandbox.visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "test-device-token-secret-that-is-long-and-random",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("enabled Kopo Kopo integration fails closed when credentials or branch mapping are missing", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    ADMIN_EMAIL_CODE_REQUIRED: "0",
    KOPOKOPO_ENABLED: "1",
    KOPOKOPO_MODE: "live",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KOPOKOPO_CLIENT_ID/);
  assert.match(result.stderr, /KOPOKOPO_TILL_BRANCH_MAP/);
});

test("enabled Kopo Kopo sandbox accepts complete HTTPS configuration", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    ADMIN_EMAIL_CODE_REQUIRED: "0",
    KOPOKOPO_ENABLED: "1",
    KOPOKOPO_MODE: "sandbox",
    KOPOKOPO_CLIENT_ID: "sandbox-client-id",
    KOPOKOPO_CLIENT_SECRET: "sandbox-client-secret",
    KOPOKOPO_API_KEY: "sandbox-api-key",
    KOPOKOPO_WEBHOOK_URL: "https://visionarypos.cloud/api/integrations/kopokopo/webhook",
    KOPOKOPO_SCOPE: "company",
    KOPOKOPO_SANDBOX_BRANCH_ID: "b_sip",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("enabled Kopo Kopo live mode accepts separate official OAuth and API origins", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    ADMIN_EMAIL_CODE_REQUIRED: "0",
    KOPOKOPO_ENABLED: "1",
    KOPOKOPO_MODE: "live",
    KOPOKOPO_BASE_URL: "https://api.kopokopo.com",
    KOPOKOPO_AUTH_URL: "https://app.kopokopo.com",
    KOPOKOPO_CLIENT_ID: "live-client-id",
    KOPOKOPO_CLIENT_SECRET: "live-client-secret",
    KOPOKOPO_API_KEY: "live-api-key",
    KOPOKOPO_WEBHOOK_URL: "https://visionarypos.cloud/api/integrations/kopokopo/webhook",
    KOPOKOPO_SCOPE: "company",
    KOPOKOPO_TILL_BRANCH_MAP: '{"1234567":"b_sip","7654321":"b_cpt"}',
  });

  assert.equal(result.status, 0, result.stderr);
});

test("enabled Kopo Kopo live mode rejects unofficial OAuth origins and ambiguous branch mappings", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    ADMIN_EMAIL_CODE_REQUIRED: "0",
    KOPOKOPO_ENABLED: "1",
    KOPOKOPO_MODE: "live",
    KOPOKOPO_BASE_URL: "https://api.kopokopo.com",
    KOPOKOPO_AUTH_URL: "https://credentials.example.test",
    KOPOKOPO_CLIENT_ID: "live-client-id",
    KOPOKOPO_CLIENT_SECRET: "live-client-secret",
    KOPOKOPO_API_KEY: "live-api-key",
    KOPOKOPO_WEBHOOK_URL: "https://visionarypos.cloud/api/integrations/kopokopo/webhook",
    KOPOKOPO_SCOPE: "company",
    KOPOKOPO_TILL_BRANCH_MAP: '{"1234567":"b_sip","7654321":"b_sip"}',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /official live Kopo Kopo OAuth HTTPS origin/i);
  assert.match(result.stderr, /only one live till to each branch/i);
});

test("enabled Kopo Kopo refuses to send OAuth credentials to an unofficial origin", () => {
  const result = validateConfig({
    NODE_ENV: "production",
    VISIONPOS_MODE: "live",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/visionary_live",
    PUBLIC_APP_URL: "https://visionarypos.cloud",
    DEVICE_TOKEN_SECRET: "live-device-token-secret-that-is-long-and-random",
    DEVICE_SETUP_KEY: "live-device-setup-key-that-is-long-and-random",
    ADMIN_EMAIL_CODE_REQUIRED: "0",
    KOPOKOPO_ENABLED: "1",
    KOPOKOPO_MODE: "sandbox",
    KOPOKOPO_BASE_URL: "https://payments.example.test",
    KOPOKOPO_CLIENT_ID: "sandbox-client-id",
    KOPOKOPO_CLIENT_SECRET: "sandbox-client-secret",
    KOPOKOPO_API_KEY: "sandbox-api-key",
    KOPOKOPO_WEBHOOK_URL: "https://visionarypos.cloud/api/integrations/kopokopo/webhook",
    KOPOKOPO_SANDBOX_BRANCH_ID: "b_sip",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /official sandbox Kopo Kopo HTTPS origin/i);
});

