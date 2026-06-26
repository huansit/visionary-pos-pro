# VISIONPOS Desktop Runtime

This Electron client loads the production cloud POS URL and keeps business logic on the server.

Security defaults:

- `nodeIntegration` is disabled.
- `contextIsolation` and `sandbox` are enabled.
- The POS page receives only the `window.visionposDesktop` bridge from `preload.js`.
- Session cookies and localStorage are persisted in Electron's app profile.
- Last logged-in user metadata is stored with Electron `safeStorage` when encryption is available.

Useful environment variables:

- `VISIONPOS_URL=https://visionarypos.cloud/`
- `VISIONPOS_KIOSK=1`
- `VISIONPOS_FULLSCREEN=0`
