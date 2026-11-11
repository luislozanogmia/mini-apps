# Galaxy Desktop (Electron shell)

Thin Electron wrapper around the Galaxy web app. It does not contain any
app logic of its own - it just opens a window pointed at the Galaxy
server, and can optionally start that server itself.

## Run it

```
cd electron
npm install
npm start
```

`npm install` downloads Electron (pinned to `43.1.0` in `package.json`);
this can take a few minutes on first run.

## Server modes

On launch, the app probes `http://127.0.0.1:<port>/`:

- **Attach mode** - if something is already listening on that port (for
  example the Galaxy server you started by hand), the window just opens
  against it. Quitting the app never touches that server.
- **Own mode** - if nothing is listening, the app spawns
  `node server.js` from the repo root itself, waits (up to 15s) for it to
  come up, then opens the window. Quitting the app terminates only the
  server process it spawned.

Port defaults to `8420` and can be overridden with the `GALAXY_PORT`
environment variable, e.g. `GALAXY_PORT=8427 npm start`.

The wrapper passes the selected port to the server through `PORT`.

## Window behavior

- Size and position are remembered between runs (stored under Electron's
  per-user `userData` directory as `window-bounds.json`).
- Only one instance runs at a time; launching a second one just focuses
  the existing window.
- Links that would open a new window (target `_blank`, cross-origin
  navigation) open in the system default browser instead of a new
  Electron window.
- `F12` or `Ctrl+Shift+I` toggles DevTools.

## Notes

- On Windows, terminating a spawned child process is immediate (Node/OS
  do not deliver real POSIX signals there), so `server.js`'s own
  `SIGINT` cleanup handler will not run when the app closes an
  own-mode server on Windows. On POSIX platforms the wrapper sends SIGTERM, so the SIGINT handler also does not run.
