'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { allowsLocalRequest } = require('./lib/local-access');

const { loadPlanets, getPlanet, savePlanets, normalizeMoon, normalizeMoons } = require('./lib/planets');
const { loadConfig, saveConfig } = require('./lib/config');
const status = require('./lib/status');
const localProcs = require('./lib/local-procs');
const apps = require('./lib/apps');
const ptyBridge = require('./lib/pty-bridge');
const vncBridge = require('./lib/vnc-bridge');
const { deploy } = require('./lib/deploy');
const { killBase } = require('./lib/bases');
const { FAVICON_ICO } = require('./lib/favicon');

const HOST = '127.0.0.1';
// PORT env override lets a second instance run side by side for testing
// (e.g. the worktree's own dev server) without ever touching the live
// instance on the default 8420.
const PORT = Number(process.env.PORT) || 8420;
const POLL_INTERVAL_MS = 30000;
const SUN_DOC_PATH = process.env.GALAXY_DOCUMENT_PATH || null;
const COLOR_PALETTE = [
  '#4fd1ff', '#ff9d4f', '#b04fff', '#4fff9d',
  '#ff4f6e', '#ffd24f', '#4f6eff', '#ff4fd1',
];

// Trims and length-checks a string field; returns null if invalid.
function validateShortString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nextUniqueId(planets, baseSlug) {
  const existingIds = new Set(planets.map((p) => p.id));
  if (!existingIds.has(baseSlug)) return baseSlug;
  let n = 2;
  let candidate = `${baseSlug}-${n}`;
  while (existingIds.has(candidate)) {
    n += 1;
    candidate = `${baseSlug}-${n}`;
  }
  return candidate;
}

function nextUnusedColor(planets) {
  const used = new Set(planets.map((p) => p.color));
  return COLOR_PALETTE.find((c) => !used.has(c)) || COLOR_PALETTE[0];
}

// Shared response shape for GET/PATCH/POST planet endpoints.
function toPlanetView(p) {
  const s = status.getState(p.id);
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: s.status || 'unknown',
    bases: s.bases || [],
    deployAgents: Object.keys(p.deployAgents || {}),
    doors: p.doors || [],
    sleepWarning: !!p.sleepWarning,
    color: p.color,
    pinned: !!p.pinned,
    archived: !!p.archived,
    craft: p.craft || [],
    moons: normalizeMoons(p.moons),
    apps: apps.computeApps(p),
  };
}

const app = express();
app.use((req, res, next) => {
  if (!allowsLocalRequest(req, PORT)) return res.status(403).json({ error: 'Local same-origin access required' });
  next();
});
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// vendor mappings — xterm.js ships lib/ (js) and css/ (stylesheet) as separate dirs
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm', 'lib')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', 'xterm', 'css')));
app.get('/vendor/xterm-fit/addon-fit.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'xterm-addon-fit', 'lib', 'xterm-addon-fit.js'));
});
app.use('/vendor/novnc', express.static(path.join(__dirname, 'node_modules', '@novnc', 'novnc')));

app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/x-icon');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_ICO);
});

app.get('/api/planets', (req, res) => {
  const planets = loadPlanets();
  res.json(planets.map(toPlanetView));
});

app.patch('/api/planets/:id', (req, res) => {
  const planets = loadPlanets();
  const idx = planets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'unknown planet' });
    return;
  }

  const body = req.body || {};
  const planet = { ...planets[idx] };

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = validateShortString(body.name, 40);
    if (name === null) {
      res.status(400).json({ error: 'name must be non-empty, max 40 chars' });
      return;
    }
    planet.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    if (typeof body.pinned !== 'boolean') {
      res.status(400).json({ error: 'pinned must be a boolean' });
      return;
    }
    planet.pinned = body.pinned;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'archived')) {
    if (typeof body.archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' });
      return;
    }
    planet.archived = body.archived;
  }

  planets[idx] = planet;
  savePlanets(planets);
  res.json(toPlanetView(planet));
});

app.post('/api/planets', (req, res) => {
  const body = req.body || {};
  const name = validateShortString(body.name, 40);
  if (name === null) {
    res.status(400).json({ error: 'name must be non-empty, max 40 chars' });
    return;
  }

  const baseSlug = slugify(name);
  if (!baseSlug) {
    res.status(400).json({ error: 'name must contain at least one alphanumeric character' });
    return;
  }

  const planets = loadPlanets();
  const id = nextUniqueId(planets, baseSlug);
  const sshTarget = typeof body.sshTarget === 'string' && body.sshTarget.trim()
    ? body.sshTarget.trim()
    : null;

  const newPlanet = {
    id,
    name,
    kind: 'remote',
    color: nextUnusedColor(planets),
    sshAlias: null,
    sshTarget,
    defaultSession: 'bridge',
    deployAgents: {},
    doors: ['terminal'],
    sleepWarning: false,
    pinned: false,
    archived: false,
    craft: [],
    moons: [],
  };

  planets.push(newPlanet);
  savePlanets(planets);
  res.status(201).json(toPlanetView(newPlanet));
});

// Moons as connectable machines (todo_galaxy_map.md "MOONS AS CONNECTABLE MACHINES"):
// stored on planet.moons, historically bare name strings, now optionally richer
// {name, sshTarget} objects. Both endpoints below only ever touch the one entry they're
// adding/removing -- every other entry in the array (string or object) is carried through
// completely untouched, so planets.json is never silently rewritten into the new shape.
app.post('/api/planets/:id/moons', (req, res) => {
  const planets = loadPlanets();
  const idx = planets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'unknown planet' });
    return;
  }

  const body = req.body || {};
  const name = validateShortString(body.name, 40);
  if (name === null) {
    res.status(400).json({ error: 'name must be non-empty, max 40 chars' });
    return;
  }

  const sshTarget = typeof body.sshTarget === 'string' && body.sshTarget.trim()
    ? body.sshTarget.trim()
    : null;
  if (sshTarget !== null && sshTarget.length > 120) {
    res.status(400).json({ error: 'sshTarget must be 120 chars or fewer' });
    return;
  }

  const planet = { ...planets[idx] };
  const existingMoons = planet.moons || [];
  const lowerName = name.toLowerCase();
  const isDuplicate = normalizeMoons(existingMoons).some((m) => m.name.toLowerCase() === lowerName);
  if (isDuplicate) {
    res.status(409).json({ error: 'a moon with that name already exists on this planet' });
    return;
  }

  const moon = sshTarget ? { name, sshTarget } : { name };
  planet.moons = existingMoons.concat([moon]);

  planets[idx] = planet;
  savePlanets(planets);
  res.status(201).json({ moons: normalizeMoons(planet.moons) });
});

app.delete('/api/planets/:id/moons/:name', (req, res) => {
  const planets = loadPlanets();
  const idx = planets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'unknown planet' });
    return;
  }

  const planet = { ...planets[idx] };
  const rawMoons = planet.moons || [];
  const target = req.params.name.toLowerCase();
  const moonIdx = rawMoons.findIndex((m) => {
    const normalized = normalizeMoon(m);
    return normalized && normalized.name.toLowerCase() === target;
  });
  if (moonIdx === -1) {
    res.status(404).json({ error: 'moon not found' });
    return;
  }

  planet.moons = rawMoons.slice(0, moonIdx).concat(rawMoons.slice(moonIdx + 1));

  planets[idx] = planet;
  savePlanets(planets);
  res.json({ moons: normalizeMoons(planet.moons) });
});

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.patch('/api/config', (req, res) => {
  const body = req.body || {};
  const update = {};

  if (Object.prototype.hasOwnProperty.call(body, 'treeTitle')) {
    const v = validateShortString(body.treeTitle, 40);
    if (v === null) {
      res.status(400).json({ error: 'treeTitle must be non-empty, max 40 chars' });
      return;
    }
    update.treeTitle = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sunName')) {
    const v = validateShortString(body.sunName, 40);
    if (v === null) {
      res.status(400).json({ error: 'sunName must be non-empty, max 40 chars' });
      return;
    }
    update.sunName = v;
  }

  res.json(saveConfig(update));
});

app.get('/api/sun/doc', (req, res) => {
  if (!SUN_DOC_PATH) return res.status(404).json({ error: 'No document configured' });
  const cfg = loadConfig();
  fs.readFile(SUN_DOC_PATH, 'utf8', (err, content) => {
    if (err) {
      res.status(404).json({ error: 'sun document not found' });
      return;
    }
    res.json({ name: cfg.sunName, content });
  });
});

app.delete('/api/planets/:id/bases/:name', async (req, res) => {
  try {
    const result = await killBase(req.params.id, req.params.name);
    res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ ok: false, error: err.message });
  }
});

// Refresh-proof local terminals: the client cross-checks its localStorage
// tab list against this before recreating tabs on page load, so a session
// that already hit its idle TTL (or died in a server restart) doesn't leave
// a phantom tab trying to reattach to nothing. Local sessions only — remote
// tmux sessions are already discoverable via each planet's bases list.
app.get('/api/terminals', (req, res) => {
  res.json({ sessions: ptyBridge.listLocalSessions() });
});

app.post('/api/deploy', async (req, res) => {
  const { planetId, agent } = req.body || {};
  if (!planetId || !agent) {
    res.status(400).json({ error: 'planetId and agent are required' });
    return;
  }
  try {
    const result = await deploy(planetId, agent);
    res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message });
  }
});

const server = http.createServer(app);

const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', (ws, req) => {
  ptyBridge.attach(ws, req);
});

const vncWss = new WebSocketServer({ noServer: true });
vncWss.on('connection', (ws, req) => {
  vncBridge.attach(ws, req);
});

const eventsWss = new WebSocketServer({ noServer: true });
const eventsClients = new Set();
eventsWss.on('connection', (ws) => {
  eventsClients.add(ws);
  ws.on('close', () => eventsClients.delete(ws));
  ws.send(JSON.stringify({ type: 'status', planets: status.snapshotAll() }));
});

function broadcastStatus() {
  const payload = JSON.stringify({ type: 'status', planets: status.snapshotAll() });
  for (const ws of eventsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

status.events.on('poll', () => {
  broadcastStatus();
});

server.on('upgrade', (req, socket, head) => {
  if (!allowsLocalRequest(req, PORT)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (err) {
    socket.destroy();
    return;
  }

  if (pathname === '/term') {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit('connection', ws, req);
    });
  } else if (pathname === '/vnc') {
    vncWss.handleUpgrade(req, socket, head, (ws) => {
      vncWss.emit('connection', ws, req);
    });
  } else if (pathname === '/events') {
    eventsWss.handleUpgrade(req, socket, head, (ws) => {
      eventsWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Galaxy server listening on http://${HOST}:${PORT}`);
  status.startPolling(POLL_INTERVAL_MS);
  localProcs.startPolling(POLL_INTERVAL_MS);
});

process.on('SIGINT', () => {
  status.stopPolling();
  localProcs.stopPolling();
  server.close(() => process.exit(0));
});

module.exports = server;
