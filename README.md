# terra-tekla-client

Offline-first shop-floor web app (iPad PWA) for TERRA, built to talk to the
TERRA PowerFab API ([tekla-conversion-layer](https://github.com/ATagTheAwesomest/tekla-conversion-layer)),
in the spirit of PowerFab Go. It opens on a home screen with one tile per
module; **Shipping** is the first one: loads, stacks, truck check, export and
shipping tickets, carried over from
[terra-loads-web](https://github.com/ATagTheAwesomest/terra-loads-web) with the
bundled CSV swapped for live job data. Plain HTML, CSS and JavaScript with no
build step.

## Server setup (address and key)

Nothing about the server is in this repo or the built app. Each device stores
the API address and key in its own localStorage, entered under **Server
settings** (home screen or menu) in one of three ways:

- type the address and key, then **Save & test**;
- scan a setup QR code with the camera (**Scan QR with camera**);
- scan the same code with the Bluetooth barcode scanner into the setup field.

To make a setup code, copy `.env.example` to `.env` (git-ignored), fill in
`TERRA_API_URL` and `TERRA_API_KEY`, and run `node tools/setup-qr.mjs`. It
writes `setup-qr.svg` (also git-ignored) and prints the code text. A device
that's already set up can show the same code with **Show setup QR**. The code
holds the API key, so treat a printout like a key.

The API must allow the app's origin in its `CORS_ORIGINS` (for GitHub Pages,
`https://atagtheawesomest.github.io`).

## Job data

- Jobs come from `POST /api/powerfab/GetProductionControlJobs` and are listed
  as `26123 - Job description` when creating a load (**Refresh jobs** re-pulls).
- When a load is created or opened, its job's parts come from
  `POST /api/powerfab/GetAssemblies` with `{ "JobNumber": "26123" }`: main mark,
  weight per assembly, total quantity, and a description built from the main
  piece of the bill of materials.
- Both are cached in localStorage (`terra.jobs`, `terra.parts.<job>`), so a
  job opened once while online works offline afterwards. `js/api.js` holds the
  client and the parsing; the PowerFab reply layout for these two commands is
  not confirmed against a real server yet, so the parser looks for the
  `ProductionControlJob` and `Assembly` elements wherever they sit.

## Run locally

Any static file server works, served over `http://localhost` or HTTPS
(service workers need a secure origin):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Install on iPad

1. Host the repo on HTTPS. GitHub Pages works: Settings → Pages → Deploy from
   branch `main`, folder `/ (root)`. All paths are relative, so it runs from
   `https://<user>.github.io/terra-tekla-client/`.
2. Open the URL in Safari, wait for the footer to say **Offline ready**.
3. Share → **Add to Home Screen**. Launch from the home screen icon.

Installed PWAs keep their storage; iOS can clear site data for un-installed
Safari tabs after a week of no use, so always run it from the home screen.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | App shell: header stats, workspace, loads drawer, dialogs |
| `css/app.css` | Dark industrial theme, 48px+ tap targets, print base |
| `js/app.js` | Boot, home screen, rendering, loads drawer, new-load flow, update UI |
| `js/api.js` | API client: settings, setup codes, jobs and assemblies, offline cache |
| `js/server-ui.js` | Server settings dialog, setup QR show/scan, job and part sync |
| `js/vendor/` | `qrcode.js` (QR generator, MIT) and `jsQR.js` (QR reader, Apache-2.0) |
| `tools/setup-qr.mjs` | Makes a setup QR from `.env` |
| `js/check.js` | Truck check logic: matches check scans to the load's pieces |
| `js/check-ui.js` | Truck check screen: checklist, extras, undo and start over |
| `js/mobile.js` | Phone layout toggle and its own stack/row markup (`css/mobile.css`) |
| `js/manage.js` | Manage Loads screen: job numbers, open, export, hold-to-delete |
| `js/hold.js` | Press-and-hold buttons for deletes (item 1.5 s, stack 4 s, load 7.5 s) |
| `js/model.js` | Pure helpers: create loads/stacks/items, totals, sequences, job numbers |
| `js/parts.js` | Job + mark lookup, filled per job from the API (CSV parser kept for tests) |
| `js/store.js` | Persistence: localStorage journal + IndexedDB |
| `js/updater.js` | Service worker registration, version check, Force Update |
| `sw.js` | Precaches the app shell, serves cache-first offline |
| `version.js` | The app version (single source of truth) |

## Data model

```
Load  { id, name, job, createdAt, updatedAt, rev, stacks: Stack[] }
Stack { id, name, items: Item[] }
Item  { id, mark, description, weight, matched, manual, scannedAt }
```

Every scan is its own item, in scan order; identical marks are never merged.
Unmatched or manually entered marks get a trailing `-` and are flagged orange.
`job` is a production control job from the API, picked when the load is
created. Jobs in `NO_SEQUENCE_JOBS` (26111) show no sequences. A mark is only
unique within a job, so every lookup is job plus mark.

## Truck check

Menu → **Truck check** turns the open load into a checklist. Each scan checks
off one piece with the same job and mark; a scan with nothing left to check
off shows red and is listed under Extras. The check is saved on the load as
`truckCheck { startedAt, updatedAt, scans: [{ id, mark, manual, scannedAt }] }`;
which piece each scan ticks is worked out on every read, so editing the load
afterwards never leaves a stale check. Hold a row's undo button 1.5 s to
uncheck it, or **Start over** 4 s to clear the check. Printed tickets fill the
✓ column from the check.

## Phone layout

Menu → **Phone layout** switches this device to a separate phone layout
(`js/mobile.js` + `css/mobile.css`, all scoped under `body.layout-mobile`).
It turns on by itself the first time on a phone-sized screen.

## Storage

`store.saveLoad(load)` writes the whole load to a localStorage journal
synchronously, then commits it to IndexedDB and clears the journal entry. On
launch, `store.recover()` replays any journal entry newer than its IndexedDB
copy, so a tab killed mid-save loses nothing. Without IndexedDB (some private
modes) the journal is the store.

Storage is per origin, and GitHub Pages serves every repo of an account from
the same origin, so loads saved by terra-loads-web on the same iPad show up
here too (same database). Their old job names stay on them until re-filed on
Manage Loads.

## Releasing an update

1. Bump `self.TERRA_VERSION` in `version.js`.
2. If you added a file, add it to `PRECACHE` in `sw.js`.
3. Push to `main`.

On launch the app checks `version.js` on the server and shows a **New** badge
on **Update** when a newer version exists. **Force Update** unregisters the
service worker, clears the app caches and reloads from the network. Saved loads
are untouched, and it refuses to run while offline so the app never loses its
offline copy.

## Tests

```sh
node --test tests/*.test.mjs
```

`tests/fixtures/sample_parts.csv` and the CSV strings in the tests exercise the
original CSV parser, which still backs the lookup logic.
