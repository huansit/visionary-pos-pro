const { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");
const netSocket = require("node:net");

const DEFAULT_POS_URL = "https://visionarypos.cloud/";
const APP_VERSION = require("../package.json").version;
const DEFAULT_SETTINGS = {
  posUrl: process.env.VISIONPOS_URL || DEFAULT_POS_URL,
  kiosk: process.env.VISIONPOS_KIOSK === "1",
  fullscreen: process.env.VISIONPOS_FULLSCREEN === "1",
  startMaximized: process.env.VISIONPOS_START_MAXIMIZED !== "0",
  printerName: "",
  cashDrawer: {
    mode: "disabled",
    host: "",
    port: 9100,
    command: "1b700019fa"
  }
};

let mainWindow;
let activeSale = false;
let reconnectTimer;
let lastConnectionState = "offline";

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readSettings() {
  const settings = readJson(settingsPath(), DEFAULT_SETTINGS);
  settings.cashDrawer = { ...DEFAULT_SETTINGS.cashDrawer, ...(settings.cashDrawer || {}) };
  return settings;
}

function saveSettings(patch) {
  const current = readSettings();
  const next = {
    ...current,
    ...patch,
    cashDrawer: { ...current.cashDrawer, ...(patch.cashDrawer || {}) }
  };
  writeJson(settingsPath(), next);
  return next;
}

function encryptedUserPath() {
  return path.join(app.getPath("userData"), "last-user.bin");
}

function encryptedTerminalPath() {
  return path.join(app.getPath("userData"), "terminal.bin");
}

function encryptJson(value) {
  const text = JSON.stringify(value || {});
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(text, "utf8");
}

function decryptJson(file) {
  try {
    const bytes = fs.readFileSync(file);
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(bytes)
      : bytes.toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function setLastUser(user) {
  const value = JSON.stringify({
    email: user?.email || "",
    name: user?.name || "",
    branchId: user?.branchId || "",
    savedAt: Date.now()
  });
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, "utf8");
  fs.writeFileSync(encryptedUserPath(), bytes);
  return true;
}

function getLastUser() {
  try {
    const bytes = fs.readFileSync(encryptedUserPath());
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(bytes)
      : bytes.toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getTerminalCredentials() {
  return decryptJson(encryptedTerminalPath());
}

function setTerminalCredentials(terminal) {
  fs.mkdirSync(path.dirname(encryptedTerminalPath()), { recursive: true });
  fs.writeFileSync(encryptedTerminalPath(), encryptJson({
    id: terminal?.id || "",
    uuid: terminal?.uuid || "",
    branchId: terminal?.branchId || "",
    terminalName: terminal?.terminalName || "",
    terminalSecret: terminal?.terminalSecret || "",
    status: terminal?.status || "ACTIVE",
    appVersion: APP_VERSION,
    savedAt: Date.now()
  }));
  return getTerminalCredentials();
}

async function activateTerminal({ activationCode, terminalName } = {}) {
  const settings = readSettings();
  const endpoint = new URL("/api/auth/terminals/activate", settings.posUrl || DEFAULT_POS_URL).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activationCode, terminalName, appVersion: APP_VERSION })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, error: data.error || "terminal_activation_failed" };
  const saved = setTerminalCredentials({ ...data.terminal, terminalSecret: data.terminalSecret });
  return { ok: true, terminal: { ...saved, terminalSecret: undefined } };
}

function connectionUrl() {
  try {
    return new URL("/health", readSettings().posUrl).toString();
  } catch {
    return new URL("/health", DEFAULT_POS_URL).toString();
  }
}

function installTerminalHeaderInjection() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const target = new URL(details.url);
      const appOrigin = new URL(readSettings().posUrl || DEFAULT_POS_URL).origin;
      if (target.origin === appOrigin && target.pathname.startsWith("/api/")) {
        const terminal = getTerminalCredentials();
        if (terminal?.uuid && terminal?.terminalSecret) {
          details.requestHeaders["X-Terminal-UUID"] = terminal.uuid;
          details.requestHeaders["X-Terminal-Secret"] = terminal.terminalSecret;
        }
      }
    } catch (_) {}
    callback({ requestHeaders: details.requestHeaders });
  });
}

function sendConnectionState(state) {
  lastConnectionState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("connection:state", state);
  }
}

function checkConnection() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const request = net.request({ method: "GET", url: connectionUrl() });
  let done = false;
  const finish = (state) => {
    if (done) return;
    done = true;
    sendConnectionState(state);
  };
  request.on("response", (response) => {
    finish(response.statusCode >= 200 && response.statusCode < 500 ? "connected" : "reconnecting");
    response.on("data", () => {});
  });
  request.on("error", () => finish("offline"));
  request.setHeader("Cache-Control", "no-cache");
  request.end();
  setTimeout(() => finish("offline"), 6000);
}

function startConnectionMonitor() {
  clearInterval(reconnectTimer);
  checkConnection();
  reconnectTimer = setInterval(checkConnection, 10000);
}

function createWindow() {
  const settings = readSettings();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    fullscreen: Boolean(settings.fullscreen || settings.kiosk),
    kiosk: Boolean(settings.kiosk),
    frame: false,
    title: "VISIONPOS",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: process.env.NODE_ENV !== "production"
    }
  });

  Menu.setApplicationMenu(null);
  if (!settings.fullscreen && !settings.kiosk && settings.startMaximized) mainWindow.maximize();
  mainWindow.loadURL(settings.posUrl || DEFAULT_POS_URL);
  startConnectionMonitor();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", () => {
    sendConnectionState("offline");
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 5000);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    sendConnectionState(lastConnectionState);
    mainWindow.webContents.send("window:maximized", mainWindow.isMaximized());
  });
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized", false));

  mainWindow.on("close", async (event) => {
    if (!activeSale) return;
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Stay open", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Active sale in progress",
      message: "There may be an active sale in progress. Close VISIONPOS anyway?"
    });
    if (result.response === 1) {
      activeSale = false;
      mainWindow.close();
    }
  });

  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

app.whenReady().then(() => {
  installTerminalHeaderInjection();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("settings:get", () => readSettings());
ipcMain.handle("settings:set", (_event, patch) => saveSettings(patch || {}));
ipcMain.handle("user:getLast", () => getLastUser());
ipcMain.handle("user:setLast", (_event, user) => setLastUser(user || {}));
ipcMain.handle("terminal:get", () => {
  const terminal = getTerminalCredentials();
  return terminal ? { ...terminal, terminalSecret: undefined, hasSecret: Boolean(terminal.terminalSecret) } : null;
});
ipcMain.handle("terminal:activate", (_event, payload) => activateTerminal(payload || {}));
ipcMain.handle("sale:setActive", (_event, value) => {
  activeSale = Boolean(value);
  return activeSale;
});
ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return true;
});
ipcMain.handle("window:toggleMaximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return true;
});
ipcMain.handle("window:isMaximized", () => {
  return !!mainWindow?.isMaximized();
});

ipcMain.handle("printers:list", async () => {
  if (!mainWindow) return [];
  return await mainWindow.webContents.getPrintersAsync();
});

ipcMain.handle("printers:setDefault", (_event, printerName) => {
  return saveSettings({ printerName: String(printerName || "") }).printerName;
});

ipcMain.handle("receipt:print", async (_event, options = {}) => {
  if (!mainWindow) return { ok: false, error: "window_unavailable" };
  const settings = readSettings();
  const printerName = String(options.printerName || settings.printerName || "");
  const silent = options.silent !== false;
  return await new Promise((resolve) => {
    mainWindow.webContents.print(
      {
        silent,
        printBackground: true,
        deviceName: printerName,
        margins: { marginType: "none" },
        pageSize: options.pageSize || { width: 80000, height: 297000 }
      },
      (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason || "print_failed" })
    );
  });
});

function drawerBytes(hex) {
  const clean = String(hex || DEFAULT_SETTINGS.cashDrawer.command).replace(/[^0-9a-f]/gi, "");
  return Buffer.from(clean, "hex");
}

ipcMain.handle("cashdrawer:open", async (_event, override = {}) => {
  const settings = readSettings();
  const drawer = { ...settings.cashDrawer, ...override };
  if (drawer.mode === "network") {
    return await new Promise((resolve) => {
      const socket = netSocket.createConnection(
        { host: drawer.host, port: Number(drawer.port || 9100), timeout: 4000 },
        () => {
          socket.write(drawerBytes(drawer.command));
          socket.end();
          resolve({ ok: true });
        }
      );
      socket.on("error", (error) => resolve({ ok: false, error: error.message }));
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ ok: false, error: "cash_drawer_timeout" });
      });
    });
  }
  if (drawer.mode === "print") {
    return await new Promise((resolve) => {
      mainWindow.webContents.print({ silent: true, deviceName: settings.printerName }, (success, failureReason) => {
        resolve(success ? { ok: true } : { ok: false, error: failureReason || "drawer_print_failed" });
      });
    });
  }
  return { ok: false, error: "cash_drawer_disabled" };
});

ipcMain.handle("updates:check", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("updates:restart", () => {
  autoUpdater.quitAndInstall(false, true);
});

autoUpdater.on("update-available", (info) => mainWindow?.webContents.send("updates:available", info));
autoUpdater.on("update-downloaded", (info) => mainWindow?.webContents.send("updates:ready", info));
autoUpdater.on("error", (error) => mainWindow?.webContents.send("updates:error", error.message));
