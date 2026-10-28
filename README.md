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
button in the top bar opens a Loads window listing them, with open or shipped,
pieces and weight, so the main screen keeps its room. Tap a load to
work on it (the window closes); **+ New** creates one in PowerFab and **&#8635;**
reads the loads again.

Scanning works the way terra-loads-web does. A scan (or a mark typed on the
keypad) puts the piece on the open load: it is assigned to the load in
PowerFab and loaded in the same step, then added to the bottom of the active
stack. There is no separate assign step. A piece that is already on the load
but not loaded (put there in PowerFab itself) is simply loaded.

A piece is picked from PowerFab's remaining list
(`ProductionControlLoadRemaining_Get`): one row per piece and sequence with
how many are still not on any load, so a scan can never add more of a piece
than the job has. With several sequences the lowest one with pieces left is
used. A mark with none left shows a red "Not added" card saying why (not on
the job, already shipped, or on which loads it is) and nothing changes.

### Stacks

The load's pieces are shown in stacks, exactly as in terra-loads-web:

- every scan is its own row, in scan order, never collapsed;
- each stack shows its piece count and weight; the active stack is
  highlighted ("Scanning here"), and **Scan here** makes another one active;
- **+ New Stack** (scan bar) adds a stack directly below the active one,
  named `Stack <load> - <n>`; the pencil renames a stack inline;
- rows move with ▲/▼ (crossing into the next stack at the edges) or by
  dragging the ⠿ handle; tap a row for its details;
- the bin on a row (hold 1.5 s) takes that piece off the truck and off the
  load in PowerFab; the bin on a stack (hold 4 s) deletes the stack and takes
  all its pieces off the load. A load always keeps one stack.
- pieces typed on the keypad are orange;
- each row shows "n of m" (which of this mark's pieces on the load it is) and,
  in blue, how many of the mark the job has; each stack's header lists its own
  sequences.

Stacks are only kept on this iPad; moving pieces between stacks or renaming
one never touches PowerFab. There are no separate assign, load or unload
buttons. If PowerFab refuses to load a scanned piece, the assign is undone and
a warning says why; a mark whose pieces are all on other loads gets a warning
naming those loads. Pieces put on the load in PowerFab itself but not loaded
are counted in a note above the stacks; scanning one loads it.

### Truck check

**Truck check** (load header) works as in terra-loads-web: the stacks become a
checklist and each scan ticks off one piece of that mark, in stack order. A
scan not on the load, or one more than the load has, is listed red as an
extra. **Show missing only**, hold to undo a check (1.5 s) or **Start over**
(4 s), and **Done checking** goes back to loading. When every piece is
checked with no extras, the iPad plays a loud beep (sound needs the iPad's
volume up and silent mode off). The check is kept with the
stacks on this iPad and never changes PowerFab; the Loads window shows how far
each load's check got.

The load has **Hold to ship** (3 s), which PowerFab only allows once every
piece is loaded, and once shipped **Hold to unship**. Shipped loads going
somewhere other than the jobsite also list their pieces for **Return** /
**Undo return**; PowerFab refuses returns from the jobsite. An empty load can
be deleted (hold 10 s). New loads go to the jobsite: on EPM-001 a load to the
galvanizer group refused every piece.

A scanner types like a keyboard, so keys typed with no text field focused (an
installed iPad app starts and resumes that way) are collected and sent on Enter
as a scan.

Scans are sent one at a time in order, and after every change the loads are
read again, so the screen always shows what PowerFab has. If PowerFab refuses
a change, its reason is shown and nothing changes on screen.

### One truck, split by sequence in PowerFab

The app shows and truck checks a load as one load, but PowerFab keeps one
load per sequence the way the project managers want it
(`js/load-groups.js`):

- a new load is created in PowerFab with the number typed, e.g. `8`;
- while it only has pieces from one sequence it stays `8`;
- when a piece from a second sequence goes on, a load `8.<sequence>` is made
  for it and `8` is renamed `8.<its sequence>` (`8.1010`, `8.1011`, ...);
- when it is back to one sequence, the emptied `8.<sequence>` loads are
  deleted and the one left is renamed `8` again.

In the app it is always **Load 8**: one entry in the Loads window (with the
PowerFab names underneath while it is split), one set of stacks, one truck
check, and **Hold to ship** ships every PowerFab part. A PowerFab load numbered
`<n>.<anything>` counts as part of load `<n>`, so load numbers typed in the
app can't contain a `.`. Shipped PowerFab loads are never renamed or deleted.
An older `8` that already mixes sequences keeps them; only new sequences
split off.

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
| `ProductionControlLoad_Update` | Rename a load when it is split or merged by sequence (only `LoadNumber` is sent) |
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
ignore, then the pieces stack by stack under `{STACK: name}` lines, one mark per
line per piece, never collapsed, as terra-loads-web writes them. Pieces on the
load but not loaded follow under `{NOT LOADED}`. **Print shipping ticket**
prints the load stack by stack with each stack's pieces and weight.

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
| `css/shipping.css` | Loads window, stacks and rows, "Not added" card |
| `js/app.js` | Boot, home screen, menus, status bar, update UI |
| `js/api.js` | API client: settings, setup codes, jobs and assemblies, value units |
| `js/server-ui.js` | Server settings dialog, setup QR show/scan, job list |
| `js/current-job.js` | Current job state, the top bar and job picker every module follows |
| `js/pf-loads.js` | PowerFab loads: reads, parsers and every shipping write command |
| `js/load-groups.js` | One app load from PowerFab loads split by sequence (`8.1010`), and the split/merge/rename plan |
| `js/shipping.js` | Pure helpers: which remaining row a scan takes, totals, sequences |
| `js/shipping-ui.js` | Shipping screen: loads window, scan handling, write queue, new load |
| `js/stacks-ui.js` | Stack rows: active stack, rename, move, drag and drop, hold to delete |
| `js/stack-store.js` | Local-only stack tracking (and truck check scans) keyed by the app's load ID |
| `js/check.js` / `js/check-ui.js` | Truck check: matching scans to stacked pieces, and its screen (`css/check.css`) |
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

The server address and key (`terra.api`), the current job (`terra.currentJob`),
the phone layout (`terra.layout`), recent lookups (`terra.lookup.recent`) and
the stacks (`terra.local-stacks.v1`) are kept on this iPad. The stacks only
keep how loaded pieces are grouped (names, order, scan times, which were typed
on the keypad); the pieces themselves are always PowerFab's. Every time the loads are read, the stacks are brought in line with
what PowerFab has loaded on the load: a piece loaded elsewhere is added to the
active stack ("Loaded in PowerFab"), and one unloaded or returned elsewhere
comes off the most recently scanned stack. No stack or manual-entry metadata is
sent to Tekla/PowerFab. The caches older
versions kept
(`terra.jobs`, `terra.parts.*`, `terra.pfloads.*`) and the old scan step and
piece view settings (`terra.step`, `terra.load-view`) are removed on launch. The
`terra-loads` IndexedDB database is left alone, since GitHub Pages shares it
with terra-loads-web on the same iPad. Once a server is configured, Server
settings remain available from the home hamburger menu and the setup tile is
hidden.

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
