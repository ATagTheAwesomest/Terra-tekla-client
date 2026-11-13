# terra-tekla-client

The TERRA shop-floor app for iPads: scan steel pieces onto PowerFab loads, group them into stacks,
check trucks, take photos and look up pieces. It installs on the iPad home screen like an app.

Plain HTML, CSS and JavaScript, no build step. It doesn't run on its own: it is served by, and talks
to, [terra-tekla-server](https://github.com/ATagTheAwesomest/terra-tekla-server), which reaches
PowerFab through
[tekla-conversion-layer](https://github.com/ATagTheAwesomest/tekla-conversion-layer).

```
iPad (this app) ──HTTPS──► terra-tekla-server ──► tekla-conversion-layer ──► PowerFab
```

PowerFab stays the source of truth for loads and pieces. What PowerFab doesn't track (stacks, who
scanned what, truck checks, photos) is kept on the server, so every iPad shows the same thing, live.

## Requirements

- A running terra-tekla-server with HTTPS (see its README)
- iPad with Safari, and a Bluetooth or USB barcode scanner that sends Enter after each scan
  (an on-screen keypad works too)

## Install

On the server, terra-tekla-server serves a git clone of this repo:

```powershell
git clone https://github.com/ATagTheAwesomest/terra-tekla-client C:\TerraTeklaClient
```

and its `CLIENT_ROOT` setting points at that folder. Then on each iPad:

1. Open the server's HTTPS address in Safari.
2. Menu > **Server settings / Admin**: enter the access key and **Save & test**, or scan the setup
   QR from the server's admin board (Settings > Set up an iPad).
3. Share > **Add to Home Screen**, and always open it from the home screen.

## Configure

Each iPad keeps its own settings, under **Server settings / Admin**: the access key, sounds on/off
and photos on/off. Its name and colour are set on the server's admin board. The admin buttons
(change the server connection, update the app or server) need the admin code.

## Update

1. Change the code, then bump `self.TERRA_VERSION` in `version.js` and the `terra-version` meta tag
   in `index.html` to match.
2. If you added a file, add it to `PRECACHE` in `sw.js`.
3. Push to `main`. On any iPad: **Server settings / Admin > Update the app on the server**, then
   **Update** in the menu. (Or run `update-client.ps1` on the server.)

The app shows a **New** badge on Update when the server has a newer version. **Force Update**
clears the app's cache and reloads.

## Run it on your own computer

Run terra-tekla-server with its fake PowerFab and `CLIENT_ROOT` pointing at this folder (the
command is in the server's README), then open `http://127.0.0.1:8095/` (key `test-key`, job
`EPM-001`). Two browser windows, one of them private, act as two iPads.

Tests need Node 18+ (the drag test also uses Playwright if it is installed, and skips otherwise):

```sh
node --test tests/*.test.mjs
```

## More

[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) explains each screen (Shipping, stacks, truck check,
pallets, photos, lookup), the PowerFab commands used, live sync, what each file does and what the
iPad stores.
