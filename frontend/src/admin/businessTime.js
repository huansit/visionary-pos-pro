export const DEFAULT_BUSINESS_TIME_ZONE = "Africa/Nairobi";

export function normalizeBusinessTimeZone(value) {
  const timeZone = String(value || DEFAULT_BUSINESS_TIME_ZONE).trim() || DEFAULT_BUSINESS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-KE", { timeZone }).format(new Date(0));
    return timeZone;
  } catch (_) {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}

function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeBusinessTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function businessDateValue(value = Date.now(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const parts = zonedParts(value, timeZone);
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function formatBusinessDateTime(value, timeZone = DEFAULT_BUSINESS_TIME_ZONE, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not supplied";
  return new Intl.DateTimeFormat("en-KE", {
    timeZone: normalizeBusinessTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    ...options,
  }).format(date);
}

export function formatBusinessTime(value, timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-KE", {
    timeZone: normalizeBusinessTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function businessDateTimeBoundary(value, timeZone = DEFAULT_BUSINESS_TIME_ZONE, edge = "start") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match.map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    if (!parts) return "";
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, edge === "end" ? 999 : 0);
    const correction = target - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  const result = new Date(candidate);
  return Number.isNaN(result.getTime()) ? "" : result.toISOString();
}
