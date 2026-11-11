'use strict';

const fs = require('fs');
const path = require('path');
const { backupFile } = require('./backup');

const PLANETS_PATH = path.join(__dirname, '..', 'planets.json');

let cache = null;

function loadPlanets() {
  if (!cache) {
    if (!fs.existsSync(PLANETS_PATH)) fs.writeFileSync(PLANETS_PATH, '[]\n');
    const raw = fs.readFileSync(PLANETS_PATH, 'utf8');
    cache = JSON.parse(raw);
  }
  return cache;
}

// Moon Travel reuses the whole planet Travel/pty-bridge pipeline unmodified: pty-bridge.js
// resolves its ssh target purely from getPlanet(id).sshTarget, so a moon just needs an id
// that getPlanet() can turn into a planet-shaped object carrying the MOON's own sshTarget.
// "moon:" can never collide with a real planet id (those are plain slugs), and only the
// first colon after the prefix is treated as the parent/name separator, so a moon name that
// itself contains a colon still round-trips correctly.
const MOON_ID_PREFIX = 'moon:';

function moonPlanetId(parentId, moonName) {
  return MOON_ID_PREFIX + parentId + ':' + moonName;
}

function getMoonAsPlanet(id) {
  const rest = id.slice(MOON_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  const parentId = rest.slice(0, sep);
  const moonName = rest.slice(sep + 1);
  const parent = loadPlanets().find((p) => p.id === parentId);
  if (!parent) return null;
  const moon = normalizeMoons(parent.moons).find((m) => m.name === moonName);
  if (!moon || !moon.sshTarget) return null;
  // Deliberately independent of the parent: no sleepWarning inherited, no shared status
  // entry. The parent being asleep must never gate Travel on a moon that lives on a
  // different machine entirely.
  return {
    id,
    name: moon.name,
    kind: 'remote',
    sshAlias: null,
    sshTarget: moon.sshTarget,
    defaultSession: 'bridge',
    doors: ['terminal'],
    sleepWarning: false,
    deployAgents: {},
    moons: [],
  };
}

function getPlanet(id) {
  if (typeof id === 'string' && id.startsWith(MOON_ID_PREFIX)) {
    return getMoonAsPlanet(id);
  }
  return loadPlanets().find((p) => p.id === id) || null;
}

// Moon entries in planets.json are historically bare name strings (e.g. "Lightning").
// The add-moon UI writes richer {name, sshTarget?} objects instead, so every reader has
// to accept both shapes. This is the one place that normalization happens for reads --
// callers never need to check typeof a moon entry themselves. Invalid entries (not a
// string, not an object with a string name) are dropped rather than thrown on, since a
// hand-edited planets.json should degrade instead of taking the whole endpoint down.
function normalizeMoon(m) {
  if (typeof m === 'string') return { name: m };
  if (m && typeof m === 'object' && typeof m.name === 'string') {
    const out = { name: m.name };
    if (typeof m.sshTarget === 'string' && m.sshTarget.trim()) out.sshTarget = m.sshTarget.trim();
    return out;
  }
  return null;
}

function normalizeMoons(moons) {
  return (moons || []).map(normalizeMoon).filter(Boolean);
}

function reload() {
  cache = null;
  return loadPlanets();
}

// Backs up planets.json, persists the full array, then refreshes the in-memory cache.
function savePlanets(planets) {
  backupFile(PLANETS_PATH, 'planets');
  fs.writeFileSync(PLANETS_PATH, JSON.stringify(planets, null, 2));
  cache = planets;
  return planets;
}

module.exports = { loadPlanets, getPlanet, reload, savePlanets, normalizeMoon, normalizeMoons, moonPlanetId };
