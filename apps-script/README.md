# GreenTrak Apps Script

`Code.gs` is the **single authoritative** backend that powers the dashboard: it
serves the Google Sheet as CSV, fetches news, and consolidates brokerage CSV
exports into the Sheet (account-aware: offshore column handling, ×2 doubling for
account 6925, and ticker exclusions).

This folder is the **version-controlled copy**. The live script runs in the
Google Apps Script editor (Extensions → Apps Script from the bound Sheet).

## History — consolidated from 4 files (2026-06-22)

The project had accumulated 4 `.gs` files with colliding top-level names
(`doGet`, `CONFIG`, `consolidate`, …). Only one could ever win at runtime.
They were merged into this one file and the others deleted:

- **Combined (5/4)** — data + news + parse routing; placeholder config; simplified
  parser → kept as the skeleton.
- **Consolidator v2 (4/1)** — real config + account-aware parser → its parser
  brains merged in.
- **Data proxy (3/1)** — data + news only → superseded, deleted.
- **(3/22)** — unrelated stopwatch + joke helpers → deleted.

## Deploying changes

`clasp` is not set up, so deploys are manual:

1. Edit `Code.gs` here (or have Claude edit it) and commit/push.
2. Open the Sheet → **Extensions → Apps Script**.
3. Select all in the editor, paste the new `Code.gs` contents.
4. **Deploy → Manage deployments** → edit the existing Web app deployment →
   **New version** → Deploy. (Editing the existing deployment keeps the same
   URL the dashboard already uses.)

## Config to set in the live editor

These live only in the deployed copy (not committed with real values):

- `CONFIG.SHEET_ID` — the Google Sheet ID
- `CONFIG.DRIVE_FOLDER_NAME` / `DRIVE_FOLDER_ID` — CSV import folder
- `ACCESS_TOKEN` — shared secret. Left as `YOUR_ACCESS_TOKEN_HERE` in the repo;
  when set to a real value the web app requires `?key=<token>` on every request
  (the check is disabled while it equals the placeholder). The dashboard sends it
  via Settings → Access Token (stored in localStorage, never committed).

## Routes (all via `doGet`)

- *(default)* — serves the `Holdings` tab as CSV
- `?action=parse` — consolidate CSVs in the import folder into the Sheet
- `?action=history` — recent parse-run log
- `?mode=news&type=market` / `?mode=news&type=portfolio&symbols=...` — news
- All routes support `&callback=` for JSONP (used by GitHub Pages).
