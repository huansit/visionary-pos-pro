const clients = new Set();
let latestVersion = Date.now();
let heartbeatTimer = null;

function safeJson(value) {
  return JSON.stringify(value).replace(/\u2028|\u2029/g, "");
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${safeJson(payload)}\n\n`);
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
    branchId: req.deviceBranchId || null,
    res,
  };
  clients.add(client);
  writeEvent(res, "connected", { ts: Date.now(), version: latestVersion });

  req.on("close", () => {
    clients.delete(client);
  });
}

export function publishSyncChange(change) {
  latestVersion = Math.max(Date.now(), latestVersion + 1);
  const payload = {
    version: latestVersion,
    ts: Date.now(),
    ...change,
  };
  for (const client of clients) {
    try {
      writeEvent(client.res, "sync", payload);
    } catch (_) {
      clients.delete(client);
    }
  }
}
