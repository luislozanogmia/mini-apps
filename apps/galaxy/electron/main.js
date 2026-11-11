'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.GALAXY_PORT) || 8420;
const SERVER_ROOT = path.join(__dirname, '..');
const START_TIMEOUT_MS = 15000;
const PROBE_INTERVAL_MS = 300;
const BOUNDS_FILE_NAME = 'window-bounds.json';
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;

let mainWindow = null;
let serverProcess = null;
let serverOwnedByUs = false;

// --- single instance lock ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startup);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('window-all-closed', () => {
    stopOwnedServer();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    stopOwnedServer();
  });
}

// --- window bounds persistence ---

function boundsFilePath() {
  return path.join(app.getPath('userData'), BOUNDS_FILE_NAME);
}

function loadBounds() {
  try {
    const raw = fs.readFileSync(boundsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return parsed;
    }
  } catch (err) {
    // no saved bounds yet, or file unreadable - fall back to defaults
  }
  return null;
}

function saveBounds(bounds) {
  try {
    fs.writeFileSync(boundsFilePath(), JSON.stringify(bounds), 'utf8');
  } catch (err) {
    console.error('Failed to save window bounds:', err.message);
  }
}

// --- server probing / lifecycle ---

function probeServer() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServer()) return true;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return false;
}

function spawnOwnServer() {
  const child = spawn('node', ['server.js'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.error('Failed to spawn galaxy server:', err.message);
  });
  return child;
}

async function ensureServerRunning() {
  const alreadyUp = await probeServer();
  if (alreadyUp) {
    console.log(`Galaxy server already listening on ${HOST}:${PORT} - attaching.`);
    serverOwnedByUs = false;
    return true;
  }

  console.log(`No server on ${HOST}:${PORT} - spawning our own (node server.js).`);
  serverProcess = spawnOwnServer();
  serverOwnedByUs = true;
  return waitForServer(START_TIMEOUT_MS);
}

function stopOwnedServer() {
  if (serverOwnedByUs && serverProcess && !serverProcess.killed) {
    // Best-effort graceful shutdown. Windows has no real POSIX signal
    // delivery, so this terminates the child immediately there; on
    // other platforms it lets server.js run its SIGTERM/SIGINT handler.
    serverProcess.kill();
  }
  serverProcess = null;
  serverOwnedByUs = false;
}

// --- window ---

function createWindow() {
  const saved = loadBounds();

  const win = new BrowserWindow({
    width: (saved && saved.width) || DEFAULT_WIDTH,
    height: (saved && saved.height) || DEFAULT_HEIGHT,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    title: 'Galaxy',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    saveBounds(win.getBounds());
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  // Links that try to open a new window (target=_blank, window.open) go to
  // the system browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // In-page navigation to a different origin also goes to the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return;
    }
    if (target.host !== `${HOST}:${PORT}`) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.loadURL(`http://${HOST}:${PORT}`);
  mainWindow = win;
}

async function startup() {
  const up = await ensureServerRunning();
  if (!up) {
    dialog.showErrorBox(
      'Galaxy failed to start',
      `Could not reach the Galaxy server at http://${HOST}:${PORT} within ${START_TIMEOUT_MS / 1000}s.`
    );
    app.quit();
    return;
  }
  createWindow();
}
