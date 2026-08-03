const clients = new Set();
let latestVersion = Date.now();
let latestChange = null;
const latestEvents = new Map();
let heartbeatTimer = null;

function safeJson(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, "");
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${safeJson(payload)}\n\n`);
}

function broadcast(event, payload, include = () => true) {
  for (const client of clients) {
    if (!include(client)) continue;
    try {
      writeEvent(client.res, event, payload);
    } catch (_) {
      clients.delete(client);
    }
  }
}

function heartbeat() {
  for (const client of clients) {
    try {
      writeEvent(client.res, "heartbeat", { ts: Date.now(), version: latestVersion });
    } catch (_) {
      clients.delete(client);
    }
  }
}

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(heartbeat, 25000);
  heartbeatTimer.unref?.();
}

export function addRealtimeClient(req, res) {
  ensureHeartbeat();
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const client = {
    id: `${req.deviceId || "device"}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    deviceId: req.deviceId || null,
    branchId: req.deviceBranchId || req.account?.branchId || null,
    res,
  };
  clients.add(client);
  writeEvent(res, "connected", { ts: Date.now(), version: latestVersion });

  req.on("close", () => {
    clients.delete(client);
  });
}

export function getRealtimeVersion() {
  return latestVersion;
}

export function getLatestRealtimeChange() {
  return latestChange;
}

export function getLatestRealtimeEvent(event) {
  return latestEvents.get(String(event || "")) || null;
}

export function publishRealtimeEvent(event, change) {
  const eventName = String(event || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(eventName)) throw new Error("invalid_realtime_event");
  const payload = { ts: Date.now(), ...change };
  latestEvents.set(eventName, payload);
  const branchId = String(change?.branchId || "").trim();
  broadcast(eventName, payload, (client) => !branchId || !client.branchId || client.branchId === branchId);
  return payload;
}

export function publishSyncChange(change) {
  latestVersion = Math.max(Date.now(), latestVersion + 1);
  const payload = {
    version: latestVersion,
    ts: Date.now(),
    ...change,
  };
  latestChange = payload;
  const branchId = String(change?.branchId || "").trim();
  broadcast("sync", payload, (client) => !branchId || !client.branchId || client.branchId === branchId);
}
