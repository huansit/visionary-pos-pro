import React, { useEffect, useState } from "react";

const DISMISS_KEY = "visionpos:pwa-install-dismissed-at";
const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

function isInstalled() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || window.navigator.standalone === true;
}

function recentlyDismissed() {
  try {
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
    return dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_FOR_MS;
  } catch {
    return false;
  }
}

export default function PwaInstallPrompt() {
  const [installEvent, setInstallEvent] = useState(null);
  const [show, setShow] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (isInstalled() || recentlyDismissed()) return undefined;

    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent || "");
    const onInstallReady = (event) => {
      event.preventDefault();
      setInstallEvent(event);
      setShow(true);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setShow(false);
    };

    window.addEventListener("beforeinstallprompt", onInstallReady);
    window.addEventListener("appinstalled", onInstalled);
    const iosTimer = isIos
      ? window.setTimeout(() => {
          setShowIosHelp(true);
          setShow(true);
        }, 1200)
      : null;

    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallReady);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) window.clearTimeout(iosTimer);
    };
  }, []);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // The prompt can still be dismissed when private storage is unavailable.
    }
    setShow(false);
  };

  const install = async () => {
    if (!installEvent) {
      setShowIosHelp(true);
      return;
    }
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice?.outcome === "accepted") setShow(false);
    } catch {
      setShow(false);
    } finally {
      setInstallEvent(null);
    }
  };

  if (!show) return null;

  return (
    <aside style={styles.prompt} role="dialog" aria-label="Install VisionPOS app">
      <button type="button" onClick={dismiss} aria-label="Dismiss install prompt" title="Dismiss" style={styles.close}>×</button>
      <img src="/icons/visionpos-192.png" alt="" width="46" height="46" style={styles.icon} />
      <div style={styles.copy}>
        <strong style={styles.title}>Install VisionPOS</strong>
        <span style={styles.text}>
          {showIosHelp
            ? "In Safari, tap Share, then Add to Home Screen."
            : "Open VISIONPOS faster from your home screen or desktop."}
        </span>
      </div>
      {!showIosHelp && (
        <button type="button" onClick={install} style={styles.install}>Install app</button>
      )}
    </aside>
  );
}

const styles = {
  prompt: {
    position: "fixed",
    zIndex: 100000,
    right: "max(12px, env(safe-area-inset-right))",
    bottom: "max(12px, env(safe-area-inset-bottom))",
    width: "min(360px, calc(100vw - 24px))",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "46px minmax(0, 1fr)",
    gap: "10px 12px",
    alignItems: "center",
    padding: "14px",
    border: "1px solid rgba(94, 188, 202, .42)",
    borderRadius: "8px",
    color: "#f8fafc",
    background: "#111b24",
    boxShadow: "0 18px 48px rgba(2, 8, 23, .36)",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  close: {
    position: "absolute",
    top: "6px",
    right: "8px",
    width: "30px",
    height: "30px",
    padding: 0,
    border: 0,
    color: "#94a3b8",
    background: "transparent",
    fontSize: "24px",
    lineHeight: 1,
    cursor: "pointer",
  },
  icon: { borderRadius: "8px" },
  copy: { display: "grid", gap: "3px", minWidth: 0, paddingRight: "24px" },
  title: { fontSize: "15px", lineHeight: 1.25 },
  text: { color: "#bac5d1", fontSize: "12px", lineHeight: 1.4 },
  install: {
    gridColumn: "1 / -1",
    minHeight: "42px",
    border: 0,
    borderRadius: "6px",
    color: "#071116",
    background: "#67d4dc",
    fontSize: "13px",
    fontWeight: 800,
    cursor: "pointer",
  },
};
