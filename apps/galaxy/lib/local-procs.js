'use strict';

// Cached list of running process image names on this (local/rtx) machine,
// refreshed on a timer — never spawned per-request.

const { execFile } = require('child_process');

const TASKLIST_BIN = process.env.GALAXY_TASKLIST_BIN || 'tasklist.exe';
const REFRESH_TIMEOUT_MS = 8000;

let cache = { names: [], ok: false, checkedAt: 0 };
let timer = null;

function parseTasklistCsv(stdout) {
  const names = [];
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^"([^"]+)"/);
    if (m) {
      names.push(m[1]);
    }
  }
  return names;
}

function refresh() {
  return new Promise((resolve) => {
    execFile(
      TASKLIST_BIN,
      ['/FO', 'CSV', '/NH'],
      { timeout: REFRESH_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          cache = { names: [], ok: false, checkedAt: Date.now() };
          resolve(cache);
          return;
        }
        cache = { names: parseTasklistCsv(stdout || ''), ok: true, checkedAt: Date.now() };
        resolve(cache);
      }
    );
  });
}

// Returns the cached process name array, or null if the last refresh failed
// (or none has completed yet) — null means "cannot determine".
function getNames() {
  return cache.ok ? cache.names : null;
}

function startPolling(intervalMs) {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, intervalMs);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { refresh, getNames, startPolling, stopPolling };
