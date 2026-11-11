'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { loadPlanets } = require('./planets');

const SSH_BIN = process.env.GALAXY_SSH_BIN || 'ssh';
const PROBE_TIMEOUT_MS = 8000;

const state = new Map(); // planetId -> { status, bases, checkedAt }
const events = new EventEmitter();

function sshTargetFor(planet) {
  return planet.sshTarget || planet.sshAlias;
}

function runSsh(target, remoteCmd) {
  return new Promise((resolve) => {
    execFile(
      SSH_BIN,
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target, remoteCmd],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          err,
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut: !!(err && err.killed),
        });
      }
    );
  });
}

async function probeStatus(planet) {
  if (planet.kind === 'local') {
    return 'online';
  }
  const target = sshTargetFor(planet);
  if (!target) {
    // Placeholder remote planet with no ssh target yet — offline, not a probe attempt.
    return 'offline';
  }
  const result = await runSsh(target, 'echo ok');

  if (!result.err && result.stdout.includes('ok')) {
    return 'online';
  }
  if (result.stderr.includes('Permission denied')) {
    return planet.sleepWarning ? 'asleep' : 'offline';
  }
  return 'offline';
}

function parseTmuxLs(stdout) {
  const bases = [];
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const re = /^([^:]+):\s+(\d+)\s+windows?\s+\(created\s+(.+?)\)/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      bases.push({
        session: m[1],
        windows: parseInt(m[2], 10),
        created: m[3],
      });
    }
  }
  return bases;
}

async function listBases(planet, status) {
  if (planet.kind === 'local') {
    return [];
  }
  if (status !== 'online') {
    return [];
  }
  const target = sshTargetFor(planet);
  const result = await runSsh(target, 'tmux ls');
  if (result.err) {
    return [];
  }
  return parseTmuxLs(result.stdout);
}

// Piggybacks one extra ssh call onto the existing 30s poll cycle to grab a
// process-name snapshot, used to answer "is this craft app running" for
// remote planets. Never invoked per-request — only from refreshPlanet below.
// Returns null (cannot determine) when offline, no craftProcs configured, or
// the probe fails; otherwise an array of lowercase-agnostic process names.
async function listProcs(planet, status) {
  if (planet.kind === 'local') {
    return null; // local planets are answered by lib/local-procs.js instead
  }
  if (status !== 'online') {
    return null;
  }
  const craftProcs = planet.craftProcs || {};
  if (Object.keys(craftProcs).length === 0) {
    return null; // nothing configured to match against — skip the extra round trip
  }
  const target = sshTargetFor(planet);
  const result = await runSsh(target, 'ps -eo comm= | sort -u');
  if (result.err) {
    return null;
  }
  return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function refreshPlanet(planet) {
  const status = await probeStatus(planet);
  const bases = await listBases(planet, status);
  const procs = await listProcs(planet, status);
  const prev = state.get(planet.id);
  const changed = !prev || prev.status !== status;
  state.set(planet.id, { status, bases, procs, checkedAt: Date.now() });
  return { changed, status, bases, procs };
}

async function refreshAll() {
  const planets = loadPlanets();
  let anyChanged = false;
  for (const planet of planets) {
    const { changed } = await refreshPlanet(planet);
    if (changed) anyChanged = true;
  }
  events.emit('poll', { changed: anyChanged, snapshot: snapshotAll() });
  return anyChanged;
}

function snapshotAll() {
  const planets = loadPlanets();
  return planets.map((p) => {
    const s = state.get(p.id) || { status: 'unknown', bases: [] };
    return { id: p.id, status: s.status, bases: s.bases };
  });
}

function getState(planetId) {
  return state.get(planetId) || { status: 'unknown', bases: [], procs: null };
}

let pollTimer = null;

function startPolling(intervalMs) {
  if (pollTimer) return;
  refreshAll();
  pollTimer = setInterval(() => {
    refreshAll();
  }, intervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  sshTargetFor,
  probeStatus,
  listBases,
  refreshAll,
  refreshPlanet,
  snapshotAll,
  getState,
  startPolling,
  stopPolling,
  events,
  SSH_BIN,
};
