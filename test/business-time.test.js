import test from "node:test";
import assert from "node:assert/strict";
import {
  businessDateTimeBoundary,
  businessDateValue,
  formatBusinessDateTime,
  formatBusinessTime,
} from "../frontend/src/admin/businessTime.js";

test("business minute boundaries use Nairobi time and include the complete selected minute", () => {
  const start = businessDateTimeBoundary("2026-08-03T06:50", "Africa/Nairobi", "start");
  const end = businessDateTimeBoundary("2026-08-03T06:50", "Africa/Nairobi", "end");
  assert.equal(start, "2026-08-03T03:50:00.000Z");
  assert.equal(end, "2026-08-03T03:50:59.999Z");
  assert.equal(Date.parse(end) - Date.parse(start), 59_999);
});

test("business date and display do not depend on the workstation timezone", () => {
  const timestamp = "2026-08-02T22:30:00.000Z";
  assert.equal(businessDateValue(timestamp, "Africa/Nairobi"), "2026-08-03");
  assert.match(formatBusinessDateTime(timestamp, "Africa/Nairobi"), /03\/08\/2026/);
  assert.match(formatBusinessDateTime(timestamp, "Africa/Nairobi"), /01:30/);
  assert.match(formatBusinessTime(timestamp, "Africa/Nairobi"), /01:30/);
});
