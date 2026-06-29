const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function on(channel, callback) {
  const wrapped = (_event, value) => callback(value);
  ipcRenderer.on(channel, wrapped);
  listeners.set(callback, { channel, wrapped });
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("visionposDesktop", {
  isDesktop: true,
  getSettings: () => invoke("settings:get"),
  setSettings: (patch) => invoke("settings:set", patch),
  getLastUser: () => invoke("user:getLast"),
  rememberLastUser: (user) => invoke("user:setLast", user),
  getTerminal: () => invoke("terminal:get"),
  activateTerminal: (payload) => invoke("terminal:activate", payload),
  setActiveSale: (active) => invoke("sale:setActive", Boolean(active)),
  minimizeWindow: () => invoke("window:minimize"),
  toggleMaximizeWindow: () => invoke("window:toggleMaximize"),
  closeWindow: () => invoke("window:close"),
  isWindowMaximized: () => invoke("window:isMaximized"),
  listPrinters: () => invoke("printers:list"),
  setDefaultPrinter: (printerName) => invoke("printers:setDefault", printerName),
  printReceipt: (options) => invoke("receipt:print", options),
  openCashDrawer: (options) => invoke("cashdrawer:open", options),
  checkForUpdates: () => invoke("updates:check"),
  restartForUpdate: () => invoke("updates:restart"),
  onConnectionState: (callback) => on("connection:state", callback),
  onWindowMaximized: (callback) => on("window:maximized", callback),
  onUpdateAvailable: (callback) => on("updates:available", callback),
  onUpdateReady: (callback) => on("updates:ready", callback),
  onUpdateError: (callback) => on("updates:error", callback),
  off: (callback) => {
    const record = listeners.get(callback);
    if (!record) return;
    ipcRenderer.removeListener(record.channel, record.wrapped);
    listeners.delete(callback);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  installDesktopChrome();
  installConnectionBadge();
  installUpdatePrompt();
  installDesktopPanel();
  installTerminalAuth();
  installPrintBridge();
  keepScannerFocus();
});

function installDesktopChrome() {
  document.documentElement.classList.add("visionpos-desktop-host");
  const style = document.createElement("style");
  style.textContent = `
    html.visionpos-desktop-host body{padding-top:42px!important;background:#0b1117!important;overflow:hidden}
    html.visionpos-desktop-host .vpos.app{min-height:calc(100dvh - 42px)!important}
    html.visionpos-desktop-host .vpos.app .shell{height:calc(100dvh - 42px)!important}
    html.visionpos-desktop-host .cashier-workstation .pos{height:calc(100dvh - 140px)!important}
    html.visionpos-desktop-host .brand.sm .name{display:none!important}
    html.visionpos-desktop-host .brand.sm .mark svg{width:36px!important;height:36px!important}
    html.visionpos-desktop-host .topbar{border-radius:0!important}
    #visionpos-desktop-titlebar{position:fixed;top:0;left:0;right:0;height:42px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(90deg,#071018,#101923 58%,#121c29);color:#e5eef4;font:600 12px system-ui,Segoe UI,sans-serif;user-select:none;-webkit-app-region:drag;border-bottom:1px solid rgba(45,212,222,.16);box-shadow:0 14px 34px rgba(2,6,23,.32)}
    #visionpos-desktop-titlebar .vp-title{display:flex;align-items:center;gap:10px;height:100%;padding:0 14px;letter-spacing:.06em;text-transform:uppercase}
    #visionpos-desktop-titlebar .vp-monogram{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#2dd4de,#7c7dff);color:#061018;font-weight:950;font-size:16px;letter-spacing:-.08em;box-shadow:0 0 18px rgba(45,212,222,.34)}
    #visionpos-desktop-titlebar .vp-name{font-weight:850;color:#f8fafc}
    #visionpos-desktop-titlebar .vp-sub{color:#8aa0ad;font-weight:700;letter-spacing:.02em;text-transform:none}
    #visionpos-desktop-titlebar .vp-controls{display:flex;height:100%;-webkit-app-region:no-drag;app-region:no-drag;pointer-events:auto}
    #visionpos-desktop-titlebar button{width:48px;height:42px;border:0;background:transparent;color:#dbeafe;font:700 15px system-ui,Segoe UI,sans-serif;cursor:pointer;display:grid;place-items:center;-webkit-app-region:no-drag;app-region:no-drag;pointer-events:auto;position:relative;z-index:1}
    #visionpos-desktop-titlebar button:hover{background:rgba(148,163,184,.14)}
    #visionpos-desktop-titlebar button[data-window-close]:hover{background:#dc2626;color:#fff}
    #visionpos-desktop-connection{bottom:18px!important}
    #visionpos-desktop-panel-button{bottom:62px!important}
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "visionpos-desktop-titlebar";
  bar.innerHTML = `
    <div class="vp-title"><span class="vp-monogram">V</span><span class="vp-name">VISIONPOS</span><span class="vp-sub">Retail Workstation</span></div>
    <div class="vp-controls">
      <button type="button" title="Minimize" data-window-minimize>−</button>
      <button type="button" title="Maximize" data-window-maximize>□</button>
      <button type="button" title="Close" data-window-close>×</button>
    </div>
  `;
  document.body.appendChild(bar);
  bar.querySelector("[data-window-minimize]").textContent = "-";
  bar.querySelector("[data-window-maximize]").textContent = "□";
  bar.querySelector("[data-window-close]").textContent = "×";

  const maxButton = bar.querySelector("[data-window-maximize]");
  const setMaximized = (isMaximized) => {
    maxButton.title = isMaximized ? "Restore" : "Maximize";
    maxButton.textContent = isMaximized ? "❐" : "□";
  };
  window.visionposDesktop.isWindowMaximized().then(setMaximized).catch(() => {});
  window.visionposDesktop.onWindowMaximized(setMaximized);
  const wireControl = (selector, action) => {
    const button = bar.querySelector(selector);
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
  };
  wireControl("[data-window-minimize]", () => window.visionposDesktop.minimizeWindow());
  wireControl("[data-window-maximize]", () => window.visionposDesktop.toggleMaximizeWindow().then(setMaximized).catch(() => {}));
  wireControl("[data-window-close]", () => window.visionposDesktop.closeWindow());
}

function installConnectionBadge() {
  const badge = document.createElement("div");
  badge.id = "visionpos-desktop-connection";
  badge.textContent = "Connecting";
  badge.style.cssText = [
    "position:fixed",
    "right:14px",
    "bottom:14px",
    "z-index:2147483647",
    "border-radius:999px",
    "padding:8px 12px",
    "font:600 12px system-ui,Segoe UI,sans-serif",
    "color:#fff",
    "background:#64748b",
    "box-shadow:0 12px 30px rgba(15,23,42,.18)",
    "pointer-events:none"
  ].join(";");
  document.body.appendChild(badge);

  const paint = (state) => {
    const label = state === "connected" ? "Connected" : state === "reconnecting" ? "Reconnecting" : "Offline";
    badge.textContent = label;
    badge.style.background = state === "connected" ? "#16a34a" : state === "reconnecting" ? "#d97706" : "#dc2626";
    badge.style.opacity = state === "connected" ? "0.85" : "1";
  };

  window.visionposDesktop.onConnectionState(paint);
  window.addEventListener("online", () => paint("reconnecting"));
  window.addEventListener("offline", () => paint("offline"));
}

function installUpdatePrompt() {
  window.visionposDesktop.onUpdateReady((info) => {
    const prompt = document.createElement("div");
    prompt.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:24px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "display:flex",
      "gap:12px",
      "align-items:center",
      "border-radius:12px",
      "padding:12px 14px",
      "font:600 13px system-ui,Segoe UI,sans-serif",
      "color:#0f172a",
      "background:#fff",
      "box-shadow:0 18px 45px rgba(15,23,42,.22)"
    ].join(";");
    prompt.innerHTML = `<span>VISIONPOS ${info?.version || "update"} is ready.</span>`;
    const button = document.createElement("button");
    button.textContent = "Restart";
    button.style.cssText = "border:0;border-radius:8px;background:#38b6c5;color:white;padding:8px 12px;font-weight:700;cursor:pointer";
    button.addEventListener("click", () => window.visionposDesktop.restartForUpdate());
    prompt.appendChild(button);
    document.body.appendChild(prompt);
  });
}

function installTerminalAuth() {
  const script = document.createElement("script");
  script.textContent = `window.visionposTerminalAuth = {
    getTerminal: () => window.visionposDesktop.getTerminal(),
    activate: (payload) => window.visionposDesktop.activateTerminal(payload)
  };`;
  document.documentElement.appendChild(script);
  script.remove();

  const panel = document.createElement("div");
  panel.id = "visionpos-terminal-activation";
  panel.hidden = true;
  panel.style.cssText = [
    "position:fixed",
    "inset:42px 0 0 0",
    "z-index:2147483646",
    "display:grid",
    "place-items:center",
    "background:rgba(7,16,24,.92)",
    "backdrop-filter:blur(10px)",
    "font:14px system-ui,Segoe UI,sans-serif",
    "color:#e5eef4"
  ].join(";");
  panel.innerHTML = `
    <div style="width:min(520px,calc(100vw - 32px));border:1px solid rgba(45,212,222,.28);border-radius:18px;background:#101923;padding:24px;box-shadow:0 28px 80px rgba(0,0,0,.45)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><div style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#2dd4de,#7c7dff);color:#061018;font-weight:950;font-size:24px">V</div><div><div style="font-weight:900;font-size:20px">Activate this terminal</div><div style="color:#9fb4c2">Enter the activation code generated by an admin.</div></div></div>
      <label style="display:grid;gap:8px;margin-top:18px;font-weight:800">Activation code<input data-code placeholder="ABCD-1234-EFGH" style="height:46px;border:1px solid #314454;border-radius:10px;background:#071018;color:#e5eef4;padding:0 14px;font-size:18px;text-transform:uppercase;letter-spacing:.08em" /></label>
      <label style="display:grid;gap:8px;margin-top:12px;font-weight:800">Terminal name<input data-name placeholder="Main Till 1" style="height:42px;border:1px solid #314454;border-radius:10px;background:#071018;color:#e5eef4;padding:0 14px" /></label>
      <div data-error style="min-height:20px;margin-top:12px;color:#fda4af"></div>
      <button data-activate style="width:100%;height:48px;border:0;border-radius:12px;background:#2dd4de;color:#061018;font-weight:950;font-size:15px;cursor:pointer;margin-top:10px">Activate terminal</button>
    </div>
  `;
  document.body.appendChild(panel);
  const code = panel.querySelector("[data-code]");
  const name = panel.querySelector("[data-name]");
  const error = panel.querySelector("[data-error]");
  const button = panel.querySelector("[data-activate]");
  const showIfNeeded = async () => {
    const terminal = await window.visionposDesktop.getTerminal();
    panel.hidden = Boolean(terminal?.hasSecret && terminal?.uuid);
    if (!panel.hidden) setTimeout(() => code.focus(), 80);
  };
  button.addEventListener("click", async () => {
    error.textContent = "";
    button.disabled = true;
    button.textContent = "Activating...";
    try {
      const result = await window.visionposDesktop.activateTerminal({ activationCode: code.value, terminalName: name.value });
      if (!result.ok) throw new Error(result.error || "Activation failed");
      panel.hidden = true;
      window.location.reload();
    } catch (err) {
      error.textContent = friendlyTerminalError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Activate terminal";
    }
  });
  showIfNeeded().catch(() => {});
}

function friendlyTerminalError(error) {
  const msg = String(error || "");
  if (msg.includes("expired")) return "That activation code has expired. Generate a new one in Admin.";
  if (msg.includes("invalid")) return "That activation code is invalid or already used.";
  return "Could not activate this terminal. Check internet connection and try again.";
}

function installDesktopPanel() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "visionpos-desktop-panel-button";
  button.textContent = "Desktop";
  button.style.cssText = [
    "position:fixed",
    "right:14px",
    "bottom:58px",
    "z-index:2147483647",
    "border:0",
    "border-radius:999px",
    "padding:8px 12px",
    "font:700 12px system-ui,Segoe UI,sans-serif",
    "color:#0f172a",
    "background:#e6f7fa",
    "box-shadow:0 12px 30px rgba(15,23,42,.14)",
    "cursor:pointer"
  ].join(";");
  document.body.appendChild(button);

  const panel = document.createElement("div");
  panel.hidden = true;
  panel.style.cssText = [
    "position:fixed",
    "right:14px",
    "bottom:100px",
    "z-index:2147483647",
    "width:min(360px,calc(100vw - 28px))",
    "border:1px solid #dbe7ea",
    "border-radius:12px",
    "padding:14px",
    "font:13px system-ui,Segoe UI,sans-serif",
    "color:#0f172a",
    "background:#fff",
    "box-shadow:0 24px 70px rgba(15,23,42,.2)"
  ].join(";");
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
      <strong style="font-size:15px">Desktop settings</strong>
      <button data-close style="border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer">&times;</button>
    </div>
    <label style="display:grid;gap:6px;margin-bottom:10px;font-weight:700">
      Receipt printer
      <select data-printer style="height:38px;border:1px solid #dbe7ea;border-radius:8px;padding:0 10px"></select>
    </label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <button data-print style="height:38px;border:0;border-radius:8px;background:#38b6c5;color:#fff;font-weight:800;cursor:pointer">Test print</button>
      <button data-drawer style="height:38px;border:1px solid #dbe7ea;border-radius:8px;background:#fff;color:#0f172a;font-weight:800;cursor:pointer">Open drawer</button>
    </div>
    <details>
      <summary style="cursor:pointer;font-weight:700">Cash drawer</summary>
      <label style="display:grid;gap:6px;margin-top:10px;font-weight:700">
        Mode
        <select data-drawer-mode style="height:36px;border:1px solid #dbe7ea;border-radius:8px;padding:0 10px">
          <option value="disabled">Disabled</option>
          <option value="network">Network ESC/POS printer</option>
          <option value="print">Use receipt printer driver</option>
        </select>
      </label>
      <label style="display:grid;gap:6px;margin-top:10px;font-weight:700">
        Network host
        <input data-drawer-host placeholder="192.168.1.50" style="height:36px;border:1px solid #dbe7ea;border-radius:8px;padding:0 10px" />
      </label>
      <label style="display:grid;gap:6px;margin-top:10px;font-weight:700">
        Port
        <input data-drawer-port type="number" value="9100" style="height:36px;border:1px solid #dbe7ea;border-radius:8px;padding:0 10px" />
      </label>
    </details>
    <div data-result style="margin-top:10px;color:#64748b;min-height:18px"></div>
  `;
  document.body.appendChild(panel);

  const printerSelect = panel.querySelector("[data-printer]");
  const drawerMode = panel.querySelector("[data-drawer-mode]");
  const drawerHost = panel.querySelector("[data-drawer-host]");
  const drawerPort = panel.querySelector("[data-drawer-port]");
  const result = panel.querySelector("[data-result]");

  const setResult = (text, ok = true) => {
    result.textContent = text;
    result.style.color = ok ? "#0f766e" : "#be123c";
  };

  const load = async () => {
    const [settings, printers] = await Promise.all([
      window.visionposDesktop.getSettings(),
      window.visionposDesktop.listPrinters()
    ]);
    printerSelect.innerHTML = `<option value="">System default</option>` + printers
      .map((printer) => `<option value="${escapeHtml(printer.name)}">${escapeHtml(printer.displayName || printer.name)}</option>`)
      .join("");
    printerSelect.value = settings.printerName || "";
    drawerMode.value = settings.cashDrawer?.mode || "disabled";
    drawerHost.value = settings.cashDrawer?.host || "";
    drawerPort.value = settings.cashDrawer?.port || 9100;
  };

  button.addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await load();
  });
  panel.querySelector("[data-close]").addEventListener("click", () => {
    panel.hidden = true;
  });
  printerSelect.addEventListener("change", async () => {
    await window.visionposDesktop.setDefaultPrinter(printerSelect.value);
    setResult("Printer saved.");
  });
  const saveDrawer = async () => {
    await window.visionposDesktop.setSettings({
      cashDrawer: {
        mode: drawerMode.value,
        host: drawerHost.value.trim(),
        port: Number(drawerPort.value || 9100)
      }
    });
  };
  [drawerMode, drawerHost, drawerPort].forEach((input) => input.addEventListener("change", saveDrawer));
  panel.querySelector("[data-print]").addEventListener("click", async () => {
    const response = await window.visionposDesktop.printReceipt({ silent: false });
    setResult(response.ok ? "Print sent." : response.error || "Print failed.", response.ok);
  });
  panel.querySelector("[data-drawer]").addEventListener("click", async () => {
    await saveDrawer();
    const response = await window.visionposDesktop.openCashDrawer();
    setResult(response.ok ? "Drawer command sent." : response.error || "Drawer failed.", response.ok);
  });
}

function installPrintBridge() {
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "visionpos-desktop") return;
    if (event.data.type === "print") {
      await window.visionposDesktop.printReceipt(event.data.options || {});
    }
    if (event.data.type === "active-sale") {
      await window.visionposDesktop.setActiveSale(Boolean(event.data.active));
    }
  });

  const script = document.createElement("script");
  script.textContent = `
    (() => {
      const nativePrint = window.print ? window.print.bind(window) : null;
      window.visionposDesktopAvailable = true;
      window.print = function visionposDesktopPrint(options) {
        window.postMessage({ source: "visionpos-desktop", type: "print", options: options || {} }, "*");
      };
      window.visionposSetActiveSale = function visionposSetActiveSale(active) {
        window.postMessage({ source: "visionpos-desktop", type: "active-sale", active: Boolean(active) }, "*");
      };
      window.visionposBrowserPrint = nativePrint;
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function keepScannerFocus() {
  const focusCandidate = () => {
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
    const input =
      document.querySelector("[data-scanner-input='true']") ||
      document.querySelector("input[placeholder*='barcode' i]") ||
      document.querySelector("input[placeholder*='search' i]");
    if (input && typeof input.focus === "function") input.focus({ preventScroll: true });
  };

  window.addEventListener("focus", () => setTimeout(focusCandidate, 80));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) setTimeout(focusCandidate, 80);
  });
  setInterval(focusCandidate, 5000);
}
