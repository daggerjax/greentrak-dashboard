# GreenTrak Apps Script

`Code.gs` is the backend that powers the dashboard: it serves the Google Sheet
as CSV, fetches news, and consolidates brokerage CSV exports into the Sheet.

This folder is the **version-controlled copy**. The live script runs in the
Google Apps Script editor (Extensions → Apps Script from the bound Sheet).

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

## Routes (all via `doGet`)

- *(default)* — serves the `Holdings` tab as CSV
- `?action=parse` — consolidate CSVs in the import folder into the Sheet
- `?action=history` — recent parse-run log
- `?mode=news&type=market` / `?mode=news&type=portfolio&symbols=...` — news
- All routes support `&callback=` for JSONP (used by GitHub Pages).
