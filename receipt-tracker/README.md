# Receipts — Rental Property Expense Tracker

A minimal, installable web app for tracking home-improvement and repair expenses across rental properties, with a running total per tax year.

## Features

- **Properties** — set up each rental (name, address, notes) and track expenses separately.
- **Scan receipts** — take a photo with the phone camera or choose an existing image. On-device text recognition (Tesseract.js) pre-fills the total, vendor, and date; all fields remain editable.
- **Manual entry** — record expenses that have no receipt.
- **Yearly running totals** — total for each tax year, broken down by property and by expense type.
- **Expense types** — Repair & Maintenance, Capital Improvement, Appliance & Equipment, Supplies, Contractor & Labor, Other.
- **Tax records**
  - **Email a year-end PDF report** — summary by property and type, a detail table for each property, and every receipt image (one per page). On iPhone, iPad, and Mac it opens the share sheet; choose Mail to send it as an attachment, optionally with the CSV spreadsheet. It can also be saved to Files or printed.
  - Export a year to CSV (one row per expense, with property and year totals), which opens in Excel or Numbers.
- **Backup / restore** — a single JSON file that includes all properties, expenses, and receipt photos.
- Works offline after first load; supports light and dark mode.

## Data and privacy

Everything is stored locally in the browser (IndexedDB) on the device in use. There is no server or account. Clearing the browser's website data deletes the records, so use **Back Up All Data** regularly and keep the file somewhere safe (e.g. iCloud Drive). Data does not sync between devices automatically; use backup/restore to move it.

Receipt text recognition (Tesseract.js) and PDF generation (jsPDF) are bundled in `vendor/`, so the app makes no outside network requests and works offline. Images and reports are produced on the device and are not uploaded anywhere; a report leaves the device only when it is shared or emailed.

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
| `vendor/` | Tesseract.js 5.1.1 (Apache-2.0) with English data, jsPDF 2.5.1 and jsPDF-AutoTable 3.8.2 (MIT) |
