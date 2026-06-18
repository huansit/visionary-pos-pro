// Load this before VisionaryPOS.jsx in a browser build, or set the same keys in localStorage.
window.VISIONARY_SYNC_CONFIG = {
  apiBaseUrl: "http://127.0.0.1:3000",
  deviceToken: "paste-device-token-here"
};

// Equivalent localStorage keys:
// localStorage.setItem("visionary:sync:apiBaseUrl", "http://127.0.0.1:3000");
// localStorage.setItem("visionary:sync:deviceToken", "paste-device-token-here");
