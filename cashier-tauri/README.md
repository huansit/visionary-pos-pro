# VISIONPOS Tauri Cashier

This is a cashier-only desktop client for the existing VISIONPOS backend.

It does not include admin screens and does not modify backend code.

## Features

- React + TypeScript frontend.
- Tauri desktop wrapper for Windows.
- Fullscreen kiosk window with no browser controls.
- Terminal activation using the existing `/api/auth/terminals/activate` endpoint.
- Terminal UUID and secret stored through the OS credential store via Rust `keyring`.
- Every protected API call sends `X-Terminal-UUID` and `X-Terminal-Secret`.
- Employee login using employee number and PIN.
- Product catalog pull through `/api/sync/pull`.
- Barcode/product search.
- Shopping cart and checkout.
- Receipt print view.
- Open and close cash session events.
- Logout without storing employee passwords locally.

## Commands

```bash
npm install
npm run build
npm run tauri:dev
npm run tauri:build
```

From the repo root:

```bash
npm run cashier-tauri:build
npm run cashier-tauri:dist:win
```

## Build Prerequisites

Tauri native builds require Rust/Cargo and the Windows build tools.

Install Rust from:

```text
https://rustup.rs/
```

After Rust is installed, run:

```bash
npm --prefix cashier-tauri run tauri:build
```

## Security Notes

- The app only connects to `https://visionarypos.cloud`.
- Terminal secrets are not stored in localStorage.
- Employee PINs are never stored locally.
- The app uses the backend's existing terminal authorization and session rules.
- If the backend rejects the terminal, local terminal credentials are cleared and activation is required again.
