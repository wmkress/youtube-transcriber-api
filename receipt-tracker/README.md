# Receipts — Rental Property Expense Tracker

A minimal, installable web app for tracking home-improvement and repair expenses across rental properties, with a running total per tax year.

## Features

- **Properties** — set up each rental (name, address, notes) and track expenses separately.
- **Scan receipts** — take a photo with the phone camera or choose an existing image. On-device text recognition (Tesseract.js) pre-fills the total, vendor, and date; all fields remain editable.
- **Manual entry** — record expenses that have no receipt.
- **Yearly running totals** — total for each tax year, broken down by property and by expense type.
- **Expense types** — Repair & Maintenance, Capital Improvement, Appliance & Equipment, Supplies, Contractor & Labor, Other.
- **Tax records**
  - Export a year to CSV (one row per expense, with property and year totals).
  - Print or save as PDF a year-end report with summary tables and all receipt images.
- **Backup / restore** — a single JSON file that includes all properties, expenses, and receipt photos.
- Works offline after first load; supports light and dark mode.

## Data and privacy

Everything is stored locally in the browser (IndexedDB) on the device in use. There is no server or account. Clearing the browser's website data deletes the records, so use **Back Up All Data** regularly and keep the file somewhere safe (e.g. iCloud Drive). Data does not sync between devices automatically; use backup/restore to move it.

Receipt text recognition downloads the recognition engine from `cdn.jsdelivr.net` on first use (about 5 MB, then cached). Images are processed on the device and are not uploaded.

## Running it

The app is static files, with no build step. It must be served over HTTPS (or `localhost`) for the camera, offline mode, and home-screen install to work.

**Locally:**

```bash
cd receipt-tracker
python3 -m http.server 8000
# open http://localhost:8000
```

**On a phone:** host the `receipt-tracker/` folder on any static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel static). Then in Safari, tap **Share → Add to Home Screen** to install it as an app.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell |
| `styles.css` | iOS-style interface |
| `app.js` | Storage, views, receipt parsing, exports |
| `sw.js` | Offline caching |
| `manifest.webmanifest`, `icons/` | Home-screen install |
