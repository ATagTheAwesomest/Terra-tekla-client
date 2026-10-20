# terra-tekla-client

Shop-floor web app (installable iPad PWA) for TERRA, built on the TERRA
PowerFab API ([tekla-conversion-layer](https://github.com/ATagTheAwesomest/tekla-conversion-layer)),
in the spirit of PowerFab Go. It opens on a home screen with one tile per
module. Everything it shows is read live from Tekla PowerFab and every change
is written straight back through the API: no loads, pieces or job data are
kept on the device. It still installs as a PWA, with only the app shell
cached, so it opens fast. Plain HTML, CSS and JavaScript with no build step.

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
`https://atagtheawesomest.github.io`) and must have `POWERFAB_ALLOW_WRITES`
on for Shipping's changes to go through.

## Current job

The app is job-first. A bar along the top of every screen shows the current
job; tap it to pick another. The picker lists every job the API user can
reach, open or closed (`ProductionControlJob_Get`; **Refresh jobs** re-reads
them). A job can also be typed into **Or type a job number**; it is checked
with `MaxTruck` before it is used.
Which job is picked is the one thing kept on the tablet (`terra.currentJob`).
`js/current-job.js` owns this; other modules use `getCurrentJob()`,
`isCurrentJob(job)`, `onCurrentJobChange(fn)` and `requireCurrentJob()`.

## Shipping

Opening Shipping reads every load (truck) on the current job. The **Loads**
button in the top bar opens a Loads window listing them, with open or shipped
and pieces loaded of assigned, so the main screen keeps its room. Tap a load to
work on it (the window closes); **+ New** creates one in PowerFab and **&#8635;**
reads the loads again.

The scan bar has two steps, matching PowerFab's assigned and loaded
quantities:

- **Add material** assigns the scanned piece to the load (blue rows, "To
  load"), e.g. as it is laid out on the floor.
- **Load** puts it on the truck: a piece already assigned to the load is
  loaded; otherwise it is assigned and loaded in one go.

A piece is picked from PowerFab's remaining list
(`ProductionControlLoadRemaining_Get`): one row per piece and sequence with
how many are still not on any load, so a scan can never add more of a piece
than the job has. With several sequences the lowest one with pieces left is
used, and the row shows which. A mark with none left shows a red "Not added"
card saying why (not on the job, already shipped, or on which loads it is).
Each row has **Load** (tap), **Unload** or **Remove** (hold 1.5 s). The load
has **Hold to ship** (3 s), which PowerFab only allows once every piece is
loaded, and once shipped **Hold to unship**. Loads going somewhere other than
the jobsite also get **Return** / **Undo return** per piece; PowerFab refuses
returns from the jobsite. An empty load can be deleted (hold 7.5 s). New loads
go to the jobsite: on EPM-001 a load to the galvanizer group refused every
piece.

Every one of these was run from the app against the test job TESTTEST on
2026-10-20 (create, assign, load, unload, ship, unship, remove, delete).

Scans are sent one at a time in order, and after every change the loads are
read again, so the screen always shows what PowerFab has. If PowerFab refuses
a change, its reason is shown and nothing changes on screen.

### PowerFab commands used

All through `POST /api/powerfab/<Command>` (`js/pf-loads.js`). The newer
commands take `ProductionControlID`, not `JobNumber`; `MaxTruck` turns the job
number into it. Their numbers have no unit and are metric, so weights are
converted from kg to lbs.

| Command | Use |
| --- | --- |
| `MaxTruck` | Job number to `ProductionControlID` |
| `ProductionControlLoad_Get` (`IncludeMaterial`) | Every load and its pieces: truck item ID, mark, sequence, quantity, loaded |
| `ProductionControlLoadRemaining_Get` | Pieces not on any load yet, per item and sequence |
| `ProductionControlJob_Get` | Every job the API user can reach |
| `ProductionControlLoad_InputOptions_Get` | Next load number, default capacity |
| `ProductionControlLoad_IsDuplicateLoadNumber` | Load number check before creating |
| `ProductionControlLoad_Insert` / `_Delete` | Create (needs `Capacity`; empty `ShippingDestinationGroupID` = jobsite) / delete a load |
| `ProductionControlLoadMaterial_Add` / `_Remove` | Assign pieces (item ID + sequence ID) / take them off |
| `ProductionControlLoadMaterial_Load` / `_Unload` | Put pieces on the truck (by truck item ID) / take them off (by the `Loaded` entry's ID) |
| `ProductionControlLoad_Ship` / `_Unship` | Ship the load / undo |
| `ProductionControlLoadMaterial_Return` / `_Unreturn` | Return shipped pieces (needs `DateReturned`) / undo (by the return entry's ID) |

The older `Load`, `Ship` and `Return` commands (by job and truck number, with
`CommitType`) are not used: on EPM-001 `Ship` rejected every `CommitType` and
`Return` refuses loads shipped to the jobsite.

### Export and shipping ticket

Menu → **Share load file** sends the open load as text through the iPad share
sheet: a `{}` header block (load, job, totals, shipped date) that Tekla scripts
ignore, then one mark per line per piece, never collapsed. **Print shipping
ticket** prints the load's pieces with sequence, quantity, weight and what is
loaded.

## Piece lookup

**Piece lookup** (home tile, or the menu inside Shipping) answers "what is
this piece?" for any mark on the current job: description, weight per piece,
quantity, size, length, grade, sequence and drawing from the job's part list
(`GetAssemblies`), and every PowerFab load that holds it with how many are
assigned, on the truck and shipped. Tap a load to open it in Shipping. The
**Job** view lists every mark with those counts. Both are read live when the
screen opens; **Refresh** reads again. It never changes anything.

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
2. Open the URL in Safari, then Share → **Add to Home Screen**. Launch from the
   home screen icon.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | App shell: header stats, scan bar, loads panel, workspace, dialogs |
| `css/app.css` | Dark industrial theme, 48px+ tap targets, print base |
| `css/shipping.css` | Loads panel, piece rows, step buttons, "Not added" card |
| `js/app.js` | Boot, home screen, menus, status bar, update UI |
| `js/api.js` | API client: settings, setup codes, jobs and assemblies, value units |
| `js/server-ui.js` | Server settings dialog, setup QR show/scan, job list |
| `js/current-job.js` | Current job state, the top bar and job picker every module follows |
| `js/pf-loads.js` | PowerFab loads: reads, parsers and every shipping write command |
| `js/shipping.js` | Pure helpers: which remaining row a scan takes, totals, sequences |
| `js/shipping-ui.js` | Shipping screen: loads panel, scan handling, write queue, new load |
| `js/lookup.js` / `js/lookup-ui.js` | Piece lookup data and screen (`css/lookup.css`) |
| `js/export.js` | Text export, share sheet and print ticket |
| `js/scanner.js` | Always-focused scan field and on-screen keypad |
| `js/hold.js` | Press-and-hold buttons for changes that are hard to undo |
| `js/mobile.js` | Phone layout toggle (`css/mobile.css`) |
| `js/parts.js` | Job and mark spelling |
| `js/updater.js` | Service worker registration, version check, Force Update |
| `js/vendor/` | `qrcode.js` (QR generator, MIT) and `jsQR.js` (QR reader, Apache-2.0) |
| `tools/setup-qr.mjs` | Makes a setup QR from `.env` |
| `sw.js` | Precaches the app shell; API calls always go to the network |
| `version.js` | The app version (single source of truth) |

## What the device keeps

Only settings: the server address and key (`terra.api`), the current job
(`terra.currentJob`), the scan step (`terra.step`), the phone layout
(`terra.layout`) and recent lookups (`terra.lookup.recent`). The caches older
versions kept (`terra.jobs`, `terra.parts.*`, `terra.pfloads.*`) are removed on
launch. Tablet-only loads, stacks, truck checks and overrides are gone. The
`terra-loads` IndexedDB database is left alone, since GitHub Pages shares it
with terra-loads-web on the same iPad.

## Releasing an update

1. Bump `self.TERRA_VERSION` in `version.js`.
2. If you added a file, add it to `PRECACHE` in `sw.js`.
3. Push to `main`.

On launch the app checks `version.js` on the server and shows a **New** badge
on **Update** when a newer version exists. **Force Update** unregisters the
service worker, clears the app caches and reloads from the network. It refuses
to run while the server can't be reached.

## Tests

```sh
node --test tests/*.test.mjs
```

`tests/fixtures/epm001_live.json` holds trimmed live replies from EPM-001
(`ProductionControlLoad_Get` and `ProductionControlLoadRemaining_Get`).
