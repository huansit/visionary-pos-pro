# VisionPOS Sync Realtime Report

## Root Cause

The Admin Web Portal and Tauri Cashier App were both using polling as the only freshness signal. The admin app polled every few seconds, while the cashier app refreshed the full catalog on a slower interval. This meant one device could successfully push an invoice, payment, expense, product price, stock movement, or user update, but other devices only noticed on the next polling cycle or after a manual sync/focus event.

The Tauri cashier also rebuilt its catalog from `/api/sync/pull?since=0` on each refresh. That preserved correctness, but it made each refresh heavier than necessary and made freshness dependent on the polling timer.

## Fix Implemented

- Added a Server-Sent Events endpoint at `/api/sync/stream`.
- `/api/sync/push` now publishes a realtime change notification after the database transaction commits.
- Admin Web Portal connects to the realtime stream and immediately runs the existing sync pull when a change arrives.
- Tauri Cashier App connects to the realtime stream with terminal headers and immediately refreshes affected cloud data when a change arrives.
- Polling remains as a fallback safety net.
- Added `no-store` cache headers to sync endpoints and client sync requests.
- Added sync/API response-time logging so slow requests can be identified from production logs.

## Data Covered

The realtime notification fires for the existing sync event and record model, including:

- Invoices
- Payments and invoice approvals
- Stock movements and inventory counts
- Expenses
- Users and employee status
- Branches and branch settings
- Products and pricing

## Expected Behavior

After deployment, one device pushing a change should cause other open admin/cashier clients to refresh within about one second, assuming the network connection is healthy. If the realtime connection drops, both clients reconnect automatically and polling still runs as a fallback.
