import assert from "node:assert/strict";
import test from "node:test";

import { emailTransportOptions } from "../src/verification.js";

test("email transport uses a bounded reusable SMTP pool", () => {
  const options = emailTransportOptions({
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "admin@example.test",
    SMTP_PASS: "secret",
    SMTP_MAX_CONNECTIONS: "99",
    SMTP_MAX_MESSAGES: "250",
    SMTP_CONNECTION_TIMEOUT_MS: "12000",
    SMTP_GREETING_TIMEOUT_MS: "13000",
    SMTP_SOCKET_TIMEOUT_MS: "30000"
  });

  assert.equal(options.pool, true);
  assert.equal(options.host, "smtp.example.test");
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.deepEqual(options.auth, { user: "admin@example.test", pass: "secret" });
  assert.equal(options.maxConnections, 5);
  assert.equal(options.maxMessages, 250);
  assert.equal(options.connectionTimeout, 12000);
  assert.equal(options.greetingTimeout, 13000);
  assert.equal(options.socketTimeout, 30000);
});

test("email transport rejects incomplete SMTP configuration", () => {
  assert.throws(
    () => emailTransportOptions({ SMTP_HOST: "smtp.example.test", SMTP_USER: "admin@example.test" }),
    /email_provider_not_configured/
  );
});
