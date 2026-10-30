# terra-tekla-client

Shop-floor web app (installable iPad PWA) for TERRA, in the spirit of
PowerFab Go. It opens on a home screen with one tile per module. Plain HTML,
CSS and JavaScript with no build step.

It is served by, and talks to,
[terra-tekla-server](https://github.com/ATagTheAwesomest/terra-tekla-server):

- PowerFab data is read live and every change is written straight back,
  through the server to
  [tekla-conversion-layer](https://github.com/ATagTheAwesomest/tekla-conversion-layer);
  no loads, pieces or job data are kept on the device.
- What PowerFab doesn't track (stacks, who scanned what, the shared truck
  check, device names and colours, history, photos) is kept on the server, so
  every iPad shows the same stacks, live.

It still installs as a PWA, with only the app shell cached, so it opens fast.

## Server setup (address, key, name)

Open the app from the server's own address (for example
`https://terra.example.com/`): the app is served by terra-tekla-server, so
there is nothing else to host. Nothing about the server is in this repo. Each
device stores the access key (and, only if the app is loaded from somewhere
else, the server address) in its own localStorage, entered under **Server
settings** (home screen or menu) in one of three ways:

- type the key (leave **Server address** blank for "the server this page
  came from"), then **Save & test**;
- scan a setup QR code with the camera (**Scan QR with camera**);
- scan the same code with the Bluetooth barcode scanner into the setup field.

To make a setup code, copy `.env.example` to `.env` (git-ignored), fill in
`TERRA_API_URL` and `TERRA_API_KEY`, and run `node tools/setup-qr.mjs`. It
writes `setup-qr.svg` (also git-ignored) and prints the code text. A device
that's already set up can show the same code with **Show setup QR**. The code
holds the API key, so treat a printout like a key.

The same dialog sets this iPad's **name** and **colour**. They tag every
piece it scans, every truck-check tick and every photo it takes, and show in
the server's history and admin page. A new iPad starts as "iPad N". It also
has the **Sounds** switch and **Test sounds**.

The conversion layer must have `POWERFAB_ALLOW_WRITES` on for Shipping's
changes to go through. Its key lives only on terra-tekla-server
(`CONVERSION_KEY`), never on an iPad. The app can still be loaded from another
origin (a local dev server) if terra-tekla-server lists it in `CORS_ORIGINS`.

## Live sync between iPads

Every change to the stacks (scan, move, rename, new or deleted stack, truck
check tick) shows on screen at once and is sent to the server
(`POST /api/loads/<loadId>/ops`), which sends it to every other iPad over a
WebSocket (`/ws`). A scan shows on the other iPads straight away as "waiting
on PowerFab", then as a normal row once PowerFab loads it (or disappears if
PowerFab refuses). Rows have a stripe in the colour of the iPad that scanned
them, and their details say who. The status bar shows this iPad's name and
"Live with N other iPads".

If the server can't be reached, stack changes wait in order on the iPad
(`terra.stack-queue.v2`, "n changes waiting to send") and go when it's back.
Scanning itself needs the server, because PowerFab is reached through it.
Code: `js/stack-ops.js` (the operations, the same as the server's),
`js/stack-store.js` (send, queue, cache), `js/live.js` (the live connection).

## Sounds

A scan that goes on the load plays a short high double beep; one that is
refused (too many of that piece, not on the job, shipped load, PowerFab said
no) plays a low buzz, with the red "Not added" card as always. A finished
truck check plays a fanfare. Sounds need the iPad's volume up and silent mode
off; **Server settings → Sounds** turns them off. Code: `js/sounds.js`.

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
work on it (the window closes); **+ New** creates one in PowerFab (the number defaults to the next load number PowerFab suggests) and **&#8635;**
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

Stacks are kept on terra-tekla-server and shared live by every iPad;
moving pieces between stacks or renaming one never touches PowerFab. Which
stack is "Scanning here" is per iPad, so two people can load into different
stacks of the same truck. There are no separate assign, load or unload
buttons. If PowerFab refuses to load a scanned piece, the assign is undone and
a warning says why; a mark whose pieces are all on other loads gets a warning
naming those loads. Pieces put on the load in PowerFab itself are
loaded when the load is opened and put in a new stack at the bottom, so every
piece on the load is always in a stack.

### Truck check

**Truck check** (load header) works as in terra-loads-web: the stacks become a
checklist and each scan ticks off one piece of that mark, in stack order. A
scan not on the load, or one more than the load has, is listed red as an
extra. **Show missing only**, hold to undo a check (1.5 s) or **Start over**
(4 s), and **Done checking** goes back to loading. When every piece is
checked with no extras, the iPad plays a loud beep (sound needs the iPad's
volume up and silent mode off); every check plays the good or bad scan sound.
The check never changes PowerFab; the Loads window shows how far each load's
check got.

**Shared / Solo** (Truck check screen) picks where the check is kept. Shared,
the default, keeps it on the server: every iPad on the load works the same
check and each tick shows who made it. Solo keeps a private check on this iPad
only (`terra.solo-check`), which also works offline. Switching doesn't erase
either.

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
ignore, then the pieces stack by stack under `{STACK: name}` lines, one mark per
line per piece, never collapsed, as terra-loads-web writes them. Pieces on the
load but not loaded follow under `{NOT LOADED}`. **Print shipping ticket**
prints the load stack by stack with each stack's pieces and weight.

### Photos

Off until **Server settings → Send photos to the server** is turned on (per
device, `terra.photos`). Then each load gets a **📷 Photos** button, each stack
header a 📷 button, and each piece's details a **Photo of this piece** button.
The Photos window takes a photo with the camera or picks some from the
library, for the whole load, a stack or a piece ("Photo of"), and shows the
photos the server already has for the load as a library: tap one to view it
full size (◀ ▶ step through them), and **hold Delete for 1.5 s** (on the tile
or in the viewer) to delete it. The server moves a deleted photo to the load's
`.deleted` folder rather than erasing it.

Photos go to terra-tekla-server (`POST /api/photos/<job>/<load>`, with the
stack name or piece mark as `mark`), which saves them in a folder for the job,
then one per load, named with the date, the piece and this iPad's name: see
its `docs/PHOTOS.md` (also on its admin page) for the `PHOTOS_*` settings and
the regex rules that pick a job's folder. The server has to have
`PHOTOS_ENABLED` on too; the switch's note says whether it does. Each photo in
the library shows who took it.

Each photo is shrunk to a JPEG of at most 2048 px and kept on the iPad
(IndexedDB `terra-photos`) until the server has it, so going offline loses
nothing: the button shows "n to send", and they are sent when the iPad is back
online (and every two minutes while any wait). One the server refuses (too
big, bad name) stays with the reason, to send again or hold to discard.
Code: `js/photos.js` (queue, sending), `js/photos-ui.js` (window, switch).

## Piece lookup

**Piece lookup** (home tile, or the menu inside Shipping) answers "what is
this piece?" for any mark on the current job: description, weight per piece,
quantity, size, length, grade, sequence and drawing from the job's part list
(`GetAssemblies`), and every PowerFab load that holds it with how many are
assigned, on the truck and shipped. Tap a load to open it in Shipping. The
**Job** view lists every mark with those counts. Both are read live when the
screen opens; **Refresh** reads again. It never changes anything.

## Run locally

Run terra-tekla-server with `CLIENT_ROOT` pointing at this folder and its fake
PowerFab (`tools/fake-powerfab.mjs` there; see its README), then open
`http://127.0.0.1:8095/`. Two browser windows, one of them private, act as two
iPads.

## Install on iPad

1. terra-tekla-server serves this repo from a git clone (`CLIENT_ROOT`) over
   HTTPS (see its `docs/SETUP.md`). GitHub Pages is no longer needed.
2. Open the server's address in Safari, enter the access key, name the iPad,
   then Share → **Add to Home Screen**. Launch from the home screen icon.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | App shell: header stats, scan bar, loads panel, workspace, dialogs |
| `css/app.css` | Dark industrial theme, 48px+ tap targets, print base |
| `css/shipping.css` | Loads window, stacks and rows, "Not added" card |
| `js/app.js` | Boot, home screen, menus, status bar, update UI |
| `js/api.js` | API client: settings, device id, setup codes, jobs and assemblies, value units |
| `js/server-ui.js` | Server settings dialog (key, device name and colour, sounds), setup QR, job list |
| `js/current-job.js` | Current job state, the top bar and job picker every module follows |
| `js/pf-loads.js` | PowerFab loads: reads, parsers and every shipping write command |
| `js/shipping.js` | Pure helpers: which remaining row a scan takes, totals, sequences |
| `js/shipping-ui.js` | Shipping screen: loads window, scan handling, write queue, new load |
| `js/stacks-ui.js` | Stack rows: active stack, rename, move, drag and drop, hold to delete |
| `js/stack-ops.js` | Stack operations (same as the server's): scan, move, rename, sync with PowerFab, truck check |
| `js/stack-store.js` | Server-backed stacks: applies ops at once, sends them in order, queues offline, takes live updates |
| `js/live.js` | Live connection to the server: other iPads' changes, devices, photos |
| `js/sounds.js` | Good / bad / complete sounds |
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

The server address and key (`terra.api`), this iPad's id (`terra.device-id`;
its name and colour are on the server), the current job (`terra.currentJob`),
the phone layout (`terra.layout`), recent lookups (`terra.lookup.recent`), the
photos switch (`terra.photos`), the sounds switch (`terra.sounds`), which stack
is active per load (`terra.active-stack`), the truck check mode and solo check
(`terra.check-mode`, `terra.solo-check`), a copy of the server's stacks for a
quick start (`terra.stack-cache.v2`), stack changes not sent yet
(`terra.stack-queue.v2`) and photos not sent yet (IndexedDB `terra-photos`)
are kept on this iPad. The stacks themselves are the server's. They only
keep how loaded pieces are grouped (names, order, who scanned them and when,
which were typed on the keypad); the pieces themselves are always PowerFab's.
Every time the loads are read, the stacks are brought in line with
what PowerFab has loaded on the load: pieces loaded elsewhere go into a stack
of their own at the bottom (the last stack if it is empty, else a new
`Stack <load> - <n>`), and one unloaded or returned elsewhere comes off the
most recently scanned stack. Pieces assigned to an open load in PowerFab but
not loaded are loaded automatically when the load is opened, so they land in
that stack too; one PowerFab refuses gets a warning and a note, and scanning
it tries again. No stack or manual-entry metadata is
sent to Tekla/PowerFab. The caches older
versions kept
(`terra.jobs`, `terra.parts.*`, `terra.pfloads.*`), the old scan step and
piece view settings (`terra.step`, `terra.load-view`) and the old iPad-only
stacks (`terra.local-stacks.v1`) are removed on launch. The
`terra-loads` IndexedDB database is left alone (terra-loads-web's). Once a server is configured, Server
settings remain available from the home hamburger menu and the setup tile is
hidden.

## Releasing an update

1. Bump `self.TERRA_VERSION` in `version.js`.
2. If you added a file, add it to `PRECACHE` in `sw.js`.
3. Push to `main`, then `git pull` the clone on the server (or run
   terra-tekla-server's `windows\deploy.ps1`, which pulls it too).

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
