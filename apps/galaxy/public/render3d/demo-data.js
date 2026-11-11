/* TEST-HARNESS ONLY. This file exists so public/render3d/test.html has
 * something realistic to render WITHOUT touching app.js (which is owned by
 * another agent mid-edit, see todo_galaxy_map.md's v2.0 section).
 *
 * It deliberately duplicates a slice of app.js's layout math (orbit radius/
 * speed/phase, freighter/moon construction, color harmonization, the
 * orbitClock accumulator, and the Freeze/Align state machine) so the demo
 * page can exercise the SAME angle formulas renderer3d.js expects. This
 * duplication is intentional and confined to this one file -- in the real
 * app.js integration, none of this is needed: renderer3d.js reads app.js's
 * already-computed state.planets/state.terminalTabs/state.orbitClock
 * directly. See render3d_integration.md for the wiring that replaces this
 * file in production.
 */

var ORBIT_FIRST_MULT = 1.5;
var ORBIT_SPACING_MULT = 0.75;
var ORBIT_BASE_SPEED = 0.00003;
var ORBIT_SPEED_JITTER = 0.15;
var FREIGHTER_ORBIT_MIN = 30;
var FREIGHTER_ORBIT_MAX = 40;
var FREIGHTER_ORBIT_SPEED = 0.00007;
var FREIGHTER_HULL_BASE = '#9aa3b8';
var FREIGHTER_TINT_AMOUNT = 0.25;
var MOON_ORBIT_MIN = 52;
var MOON_ORBIT_MAX = 64;
var PLANET_COLORS = ['#6ea8ff', '#c77dff', '#ff9d5c', '#52e0a8', '#e0567e', '#5cd6e0'];
var SHIP_COLORS = ['#ff5c5c', '#ff9f45', '#f4d35e', '#45d3ff', '#4d7dff', '#ff5cc8', '#ff7f50', '#7c8cff'];

function hashStringToUnit(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return (hash % 1000) / 1000;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToHsl(hex) {
  var h = hex.replace('#', '');
  var r = parseInt(h.substring(0, 2), 16) / 255;
  var g = parseInt(h.substring(2, 4), 16) / 255;
  var b = parseInt(h.substring(4, 6), 16) / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var hue = 0, sat = 0, light = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    sat = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: sat * 100, l: light * 100 };
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs((h / 60) % 2 - 1));
  var m = l - c / 2, r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  function toHex(v) { var n = Math.round((v + m) * 255); var s2 = n.toString(16); return s2.length === 1 ? '0' + s2 : s2; }
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function harmonizePlanetColor(hex) {
  var hsl = hexToHsl(hex);
  return hslToHex(hsl.h, clamp(hsl.s, 42, 62), clamp(hsl.l, 48, 62));
}
function blendHexColors(hexA, hexB, t) {
  var a = hexA.replace('#', ''), b = hexB.replace('#', '');
  var ar = parseInt(a.substring(0, 2), 16), ag = parseInt(a.substring(2, 4), 16), ab = parseInt(a.substring(4, 6), 16);
  var br = parseInt(b.substring(0, 2), 16), bg = parseInt(b.substring(2, 4), 16), bb = parseInt(b.substring(4, 6), 16);
  function toHex(v) { var n = Math.max(0, Math.min(255, Math.round(v))); var s = n.toString(16); return s.length === 1 ? '0' + s : s; }
  return '#' + toHex(ar + (br - ar) * t) + toHex(ag + (bg - ag) * t) + toHex(ab + (bb - ab) * t);
}
function colorForPlanet(planet, index) {
  var seed = planet.color || PLANET_COLORS[index % PLANET_COLORS.length];
  return harmonizePlanetColor(seed);
}

function normalizeAngle(a) { var tp = Math.PI * 2; a = a % tp; if (a < 0) a += tp; return a; }
function angularDistance(a, b) { var d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? (Math.PI * 2 - d) : d; }
function nearestAlignTarget(angle) { var n = normalizeAngle(angle); return angularDistance(n, 0) <= angularDistance(n, Math.PI) ? 0 : Math.PI; }
function lerpAngleShortest(a, b, t) { var diff = normalizeAngle(b - a); if (diff > Math.PI) diff -= Math.PI * 2; return a + diff * t; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

export function createDemoData() {
  var state = {
    planets: [],
    orbitClock: 0,
    lastFrameTimestamp: null,
    frozen: false,
    aligning: false,
    alignedFrozen: false,
    config: { sunName: 'Workspace' },
    ships: []
  };

  function layoutPlanets(rawPlanets) {
    var margin = 60;
    var maxRadius = Math.min(window.innerWidth * 0.5 - margin, (window.innerHeight * 0.5 - margin) / 0.55);
    var scale = 1;
    if (maxRadius < 110) { scale = Math.max(0.35, maxRadius / 110); maxRadius = 110 * scale; }
    var baseMinRadius = 90 * scale;
    if (maxRadius < baseMinRadius + 10) maxRadius = baseMinRadius + 10;

    var n = rawPlanets.length;
    var originalSpacing = n > 1 ? (maxRadius - baseMinRadius) / (n - 1) : 0;
    var firstOrbitRadius = baseMinRadius * ORBIT_FIRST_MULT;
    var orbitSpacing = originalSpacing * ORBIT_SPACING_MULT;
    if (n > 1) {
      var lastRadius = firstOrbitRadius + (n - 1) * orbitSpacing;
      if (lastRadius > maxRadius) orbitSpacing = Math.max(4, (maxRadius - firstOrbitRadius) / (n - 1));
    }
    var middleIndex = (n - 1) / 2;
    var middleRadius = firstOrbitRadius + middleIndex * orbitSpacing;

    return rawPlanets.map(function (planet, i) {
      var radius = firstOrbitRadius + i * orbitSpacing;
      var keplerSpeed = ORBIT_BASE_SPEED * Math.sqrt(middleRadius / radius);
      var jitter = 1 + (hashStringToUnit(planet.id + '|speed') * 2 - 1) * ORBIT_SPEED_JITTER;
      var color = colorForPlanet(planet, i);
      var visualRadius = (10 + (i % 3) * 2) * scale;

      var freighter = null;
      if (planet.craft && planet.craft.length) {
        var seed = planet.id + '|freighter';
        var fRadius = FREIGHTER_ORBIT_MIN + hashStringToUnit(seed + '|radius') * (FREIGHTER_ORBIT_MAX - FREIGHTER_ORBIT_MIN);
        var direction = hashStringToUnit(seed + '|dir') < 0.5 ? 1 : -1;
        freighter = {
          label: 'Apps (' + planet.craft.length + ')',
          manifest: planet.craft.slice(),
          hullColor: blendHexColors(FREIGHTER_HULL_BASE, color, FREIGHTER_TINT_AMOUNT),
          orbitRadius: fRadius,
          orbitPhase: hashStringToUnit(seed + '|phase') * Math.PI * 2,
          orbitSpeed: FREIGHTER_ORBIT_SPEED * direction
        };
      }

      var moonNames = planet.moons || [];
      var moonSprites = moonNames.map(function (name, idx) {
        var seed = planet.id + '|moon|' + name;
        var mr = moonNames.length > 1
          ? (MOON_ORBIT_MIN + (idx / (moonNames.length - 1)) * (MOON_ORBIT_MAX - MOON_ORBIT_MIN))
          : MOON_ORBIT_MIN + 4;
        return {
          label: name, radius: 4 + (idx % 2), orbitRadius: mr,
          orbitPhase: hashStringToUnit(seed) * Math.PI * 2,
          orbitSpeed: 0.00006 * ((idx % 2 === 0) ? 1 : -1)
        };
      });

      return {
        id: planet.id, name: planet.name, status: planet.status || 'unknown',
        color: color, orbitRadius: radius, orbitSpeed: keplerSpeed * jitter,
        orbitPhase: hashStringToUnit(planet.id) * Math.PI * 2,
        visualRadius: visualRadius, freighter: freighter, moonSprites: moonSprites
      };
    });
  }

  function synthesizeShips(planets) {
    var ships = [];
    var colorIdx = 0;
    var types = ['bridge', 'desktop'];
    planets.forEach(function (planet, i) {
      var count = i % 2 === 0 ? 2 : 1; // a mix, ~10 total across 5-6 planets
      for (var k = 0; k < count; k++) {
        ships.push({
          tabId: 'demo-' + planet.id + '-' + k,
          planetId: planet.id,
          type: types[(i + k) % types.length],
          color: SHIP_COLORS[colorIdx % SHIP_COLORS.length],
          label: planet.name + ' : demo-' + k,
          orbitRadius: 24 + Math.random() * 14,
          orbitSpeed: (0.0004 + Math.random() * 0.0003) * (Math.random() < 0.5 ? 1 : -1),
          orbitPhase: Math.random() * Math.PI * 2,
          bobPhase: Math.random() * Math.PI * 2,
          spawnTime: performance.now()
        });
        colorIdx++;
      }
    });
    return ships;
  }

  function load() {
    return fetch('/api/planets', { cache: 'no-store' }).then(function (res) { return res.json(); })
      .then(function (planets) {
        var active = planets.filter(function (p) { return !p.archived; });
        state.planets = layoutPlanets(active);
        state.ships = synthesizeShips(state.planets);
        return state.planets;
      })
      .then(function (planets) {
        return fetch('/api/config', { cache: 'no-store' }).then(function (res) { return res.json(); }).then(function (cfg) {
          state.config = cfg;
          return planets;
        });
      });
  }

  function tick(timestamp) {
    if (state.lastFrameTimestamp === null) state.lastFrameTimestamp = timestamp;
    var dt = timestamp - state.lastFrameTimestamp;
    state.lastFrameTimestamp = timestamp;
    if (dt < 0) dt = 0;
    if (!state.frozen) state.orbitClock += dt;
    updateAligning(timestamp);
  }

  function toggleFreeze() {
    state.frozen = !state.frozen;
    state.alignedFrozen = false;
  }

  function triggerAlign() {
    if (state.aligning) return;
    if (state.frozen && state.alignedFrozen) {
      state.frozen = false;
      state.alignedFrozen = false;
      return;
    }
    state.frozen = true;
    state.alignedFrozen = false;
    var now = performance.now();
    state.planets.forEach(function (planet) {
      var currentAngle = normalizeAngle(planet.orbitPhase + state.orbitClock * planet.orbitSpeed);
      var target = nearestAlignTarget(currentAngle);
      planet._align = { startAngle: currentAngle, targetAngle: target, startTime: now, duration: 300 + Math.random() * 300 };
      planet._alignAngle = currentAngle;
    });
    state.aligning = true;
  }

  function updateAligning(timestamp) {
    if (!state.aligning) return;
    var stillGoing = false;
    state.planets.forEach(function (planet) {
      var a = planet._align;
      if (!a) return;
      var t = clamp((timestamp - a.startTime) / a.duration, 0, 1);
      if (t < 1) {
        stillGoing = true;
        planet._alignAngle = lerpAngleShortest(a.startAngle, a.targetAngle, easeInOutCubic(t));
      } else {
        planet.orbitPhase = normalizeAngle(a.targetAngle - state.orbitClock * planet.orbitSpeed);
        delete planet._align;
        delete planet._alignAngle;
      }
    });
    if (!stillGoing) { state.aligning = false; state.alignedFrozen = true; }
  }

  return {
    state: state,
    load: load,
    tick: tick,
    toggleFreeze: toggleFreeze,
    triggerAlign: triggerAlign,
    dataProvider: {
      getPlanets: function () { return state.planets; },
      getShips: function () { return state.ships; },
      getSunName: function () { return state.config.sunName || 'Workspace'; },
      getOrbitClock: function () { return state.orbitClock; }
      // no getViewport(): test.html has no sidebar/drawer, full window is correct.
    }
  };
}
