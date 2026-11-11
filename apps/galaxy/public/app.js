/* Galaxy control map frontend. Vanilla JS, no framework, no build step. */
(function () {
  "use strict";

  /* ======================================================================
   * STATE
   * ==================================================================== */

  var FALLBACK_PLANETS = [];

  var PLANET_COLORS = ["#6ea8ff", "#c77dff", "#ff9d5c", "#52e0a8", "#e0567e", "#5cd6e0"];

  // Mirrors each known planet's real identity color from planets.json. /api/planets
  // does not forward that field today, so this is the frontend's own copy -- without it,
  // colorForPlanet has nothing but array position to go on, and a planet can end up
  // harmonized from the wrong seed hue entirely (e.g. Remote workspace, at array index 1,
  // silently inheriting PLANET_COLORS[1]'s purple instead of its own orange).
  var PLANET_IDENTITY_COLORS = {};

  // Ships get their own rotating palette, distinct from planet colors and from the
  // online/asleep/offline status hues (green/violet/gray/amber), so a ship never
  // reads as a status signal by accident.
  var SHIP_COLORS = ["#ff5c5c", "#ff9f45", "#f4d35e", "#45d3ff", "#4d7dff", "#ff5cc8", "#ff7f50", "#7c8cff"];

  var SIDEBAR_EXPANDED_PX = 300;
  var SIDEBAR_RAIL_PX = 44;
  var PULSE_DURATION_MS = 900;
  var SHIP_SIZE = 6;
  var SHIP_HIT_RADIUS = 11;
  var SHIP_SPAWN_MS = 350;
  var SHIP_DEPART_MS = 500;
  var SHIP_TRAIL_MAX = 10;

  // Must match the drawer's own CSS: open height is 50vh (.terminal-drawer), collapsed
  // shows only the 34px handle strip (.drawer-handle / the collapsed transform).
  var DRAWER_OPEN_HEIGHT_FRAC = 0.5;
  var DRAWER_HANDLE_PX = 34;

  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 4;
  var ZOOM_STEP = 1.12;
  var PAN_THRESHOLD_PX = 4;
  var DRAG_THRESHOLD_PX = 4;   // planet-drag arms only past this, so a plain click still selects/filters

  // Align mode layout: when aligned, moons stack straight up from their parent (in world
  // units, since screenPositions holds pre-transform world coords) and aligned planets on
  // each side keep at least the widest label's width between them so neighbor labels never
  // touch. localStorage key persists a dragged/frozen arrangement across a reload.
  // Aligned mode arranges each planet's moons on a small ring around the parent, spread
  // evenly across the upper arc (top-left through top to top-right). The arc deliberately
  // stops short of the horizontal line and never reaches straight-down, where the planet's
  // own label sits and where neighbour planets' labels run.
  var MOON_ALIGN_RING_GAP = 20;          // world gap beyond the planet's visual radius to the moon ring
  var MOON_ALIGN_ARC_START = Math.PI * 1.18; // ~212deg (upper-left), y is down so this is above the line
  var MOON_ALIGN_ARC_END = Math.PI * 1.82;   // ~328deg (upper-right)
  var ALIGN_LABEL_PAD = 14;       // extra world padding added to the widest label width for min spacing
  var PLANET_OVERRIDE_STORAGE_KEY = "galaxy_planet_overrides_v1";
  var LABEL_ZOOM_SCALE_MIN = 0.6;
  var LABEL_ZOOM_SCALE_MAX = 1.8;

  // Beauty pass constants (screen-space background layers + sprite caches)
  var STAR_FAR_PARALLAX = 0.1;
  var STAR_NEAR_PARALLAX = 0.25;
  var NEBULA_PARALLAX = 0.08;
  var NEBULA_PADDING = 160;
  var SHOOTING_STAR_MIN_MS = 6000;
  var SHOOTING_STAR_MAX_MS = 12000;
  var SHOOTING_STAR_LIFE_MS = 400;
  var SUN_CORONA_SCALE = 3.2;
  // Canonical light direction baked into cached sphere sprites (upper-left). The live
  // sun-facing angle is applied by rotating the sprite at blit time, not by rebuilding it.
  var LIGHT_ANGLE = Math.PI * -0.75;

  // Orbit geometry/motion tuning (Galaxy v1.3): first orbit sits 50% farther out, orbits
  // pack 25% tighter, and the shared base speed is halved before the per-orbit Kepler
  // law (~1/sqrt(radius)) spreads it back out around that new baseline.
  var ORBIT_FIRST_MULT = 1.5;
  var ORBIT_SPACING_MULT = 0.75;
  var ORBIT_BASE_SPEED = 0.00003;
  var ORBIT_SPEED_JITTER = 0.15;

  // Static freighter/moon decoration bands, in the same fixed pixel units as live ship
  // orbits (createShip below), not scaled by layoutScale.
  var FREIGHTER_ORBIT_MIN = 30;
  var FREIGHTER_ORBIT_MAX = 40;
  var FREIGHTER_ORBIT_SPEED = 0.00007; // slow, in the same range as a moon's
  var FREIGHTER_LENGTH = SHIP_SIZE * 4;    // base length unit the hull scales from
  var FREIGHTER_WIDTH = SHIP_SIZE * 1.5;
  var FREIGHTER_HIT_RADIUS = SHIP_HIT_RADIUS * 1.8; // unused now that the hull glyph is off the map (the original call); kept with buildFreighterSprite/drawFreighterGlyph below in case the hull comes back
  var FREIGHTER_HULL_BASE = "#9aa3b8";  // subdued neutral gray-blue
  var FREIGHTER_TINT_AMOUNT = 0.25;     // slight tint of the planet's own color
  var FREIGHTER_SEG_MIN = 2;  // segment count floor, even a single-app manifest still reads as a hull
  var FREIGHTER_SEG_MAX = 8;  // segment count ceiling; manifests longer than this share the last segments
  var FREIGHTER_LEN_SCALE_MIN = 1.6; // length multiplier on FREIGHTER_LENGTH at FREIGHTER_SEG_MIN segments
  var FREIGHTER_LEN_SCALE_MAX = 2.2; // length multiplier on FREIGHTER_LENGTH at FREIGHTER_SEG_MAX segments
  var MOON_ORBIT_MIN = 52;
  var MOON_ORBIT_MAX = 64;
  var MOON_COLOR = "#d6deef";
  var SPRITE_SUPERSAMPLE = 2; // extra resolution factor baked into every cached sprite on top of dpr, so a small on-screen radius (e.g. default fit-zoom) still downscales from a higher-res source instead of smearing rims/gradients

  // Full-view legibility fix (2026-07-09): a small on-screen disc wrapped in a glow halo
  // 2.4x its radius reads as an out-of-focus smudge no matter how many physical pixels it
  // has -- confirmed by direct pixel measurement on the live app, not a resolution bug (see
  // apparentBodyRender). Below TIGHTEN_START (apparent, post-zoom CSS px radius) the glow
  // ratio/alpha lerp down toward the NEAR values and the disc is floored at MIN_APPARENT_R,
  // so small/far planets and moons read like the already-good zoomed-in look instead of
  // continuing to shrink into a blur. At/above TIGHTEN_START nothing changes at all -- normal
  // and zoomed-in rendering stays pixel-identical to before this fix. Planets and moons get
  // their own floor/start pair since moons are already much smaller bodies.
  var PLANET_MIN_APPARENT_R = 8;       // CSS px: a planet disc never renders smaller than this
  var PLANET_GLOW_TIGHTEN_START = 22;  // CSS px: today's full glow, unchanged at/above this apparent size
  var MOON_MIN_APPARENT_R = 2.5;       // CSS px: a moon dot never renders smaller than this
  var MOON_GLOW_TIGHTEN_START = 10;    // CSS px: today's full glow, unchanged at/above this apparent size
  var GLOW_RATIO_FAR = 2.4;            // today's halo-to-disc ratio (was a literal in buildPlanetSprite)
  var GLOW_RATIO_NEAR = 1.4;           // tightened ratio at/below the floor
  var GLOW_ALPHA_FAR = 0.35;           // today's glow peak alpha (was a literal in buildPlanetSprite)
  var GLOW_ALPHA_NEAR = 0.2;           // tightened peak alpha at/below the floor
  var RIM_ALPHA_FAR = 0.2;             // today's additive atmosphere-rim alpha (was a literal in buildPlanetSprite)
  var RIM_ALPHA_NEAR = 0.05;           // thinned near the floor -- a soft rim stroke is itself a big share of a tiny disc's edge, so this needed to shrink too, not just the halo
  var APPARENT_RADIUS_QUANT = 0.5;     // CSS px steps the clamped radius snaps to, so a slow zoom inside the tighten zone rebuilds the sprite cache occasionally, not every frame

  var state = {
    planets: [],           // active (non-archived) planets only -- the map's own list
    allPlanets: [],        // full set as returned by the server, including archived
    archivedPlanets: [],   // derived subset of allPlanets, kept for the archived tree section
    config: { treeTitle: "Galaxy", sunName: "Workspace" },
    selectedPlanetId: null,   // the one accordion row expanded in the tree, shared with the map
    serverOffline: false,
    canvas: null,
    ctx: null,
    starsFar: [],
    starsNear: [],
    nebula: null,           // { canvas, w, h }, offscreen, regenerated only on resize
    shootingStars: [],
    nextShootingStarAt: 0,
    shootingStarsInited: false,
    lastDpr: null,          // devicePixelRatio as of the last resizeCanvas() call; sprite caches below are cleared when this changes
    sunSprite: null,        // { canvas, half, size, key }, regenerated only when sun radius or spriteScale() changes
    planetSpriteCache: {},  // "radius|status|color|spriteScale" -> { canvas, half, size }
    moonSpriteCache: {},    // "radius|color|spriteScale" -> { canvas, half, size }
    shipGlowCache: {},      // "shipColor|spriteScale" -> { canvas, half, size }
    freighterSpriteCache: {}, // "segCount|runningSig|hullColor|spriteScale" -> { canvas, half, size, len, halfW }
    screenPositions: {},   // planetId -> { x, y, r } (pre-view-transform world coords, despite the name)
    decorPositions: {},    // "freighter:<planetId>" / "moon:<planetId>:<idx>" -> { x, y, r, label[, manifest] }
    planetLabelBoxes: {},   // planetId -> screen-space text bounding box, refreshed each frame in drawWorldLabels
    dragOverrides: {},     // planetId -> { x, y } world coords, set by dragging a planet while frozen; wins over the computed orbit/align position
    sunPosition: { x: 0, y: 0, r: 0 },
    orbitClock: 0,          // ms of accumulated orbit motion; stops advancing while frozen
    lastFrameTimestamp: null,
    frozen: false,          // Freeze button: planet/moon/freighter orbital angles stop advancing
    aligning: false,        // Align tween in progress
    alignedFrozen: false,   // frozen state was reached via a completed Align (so re-clicking Align resumes)
    sunDocTabId: null,
    terminalTabs: [],       // { id, planetId, session, kind, type, ship, term, fitAddon, ws, iframeEl, tabEl, paneEl }
    activeTabId: null,
    tabCounter: 0,
    showAllTabs: false,    // false = tab strip filtered to state.selectedPlanetId's tabs
    eventsWs: null,
    eventsReconnectDelay: 1000,
    drawerCollapsed: true,
    drawerFullscreen: false,
    drawerExpanded: false,  // "^" tall mode: terminal fills the full right-side height, sidebar stays
    renderPaused: false,
    render3dTickId: null,   // rAF id for the orbit-clock-only ticker that runs while 2D drawing is paused for 3D
    hoveredPlanetId: null,
    sidebarCollapsed: false,
    treeRows: {},          // planetId -> row DOM refs, see buildTreeRow
    pulsePlanetId: null,   // transient map highlight when a planet is picked from the tree
    pulseStartTime: 0,
    shipPositions: {},     // tabId -> { x, y, r }, rebuilt every frame, used for ship hit-testing
    hoveredShipTabId: null,
    pinnedDecorId: null,   // decorPositions key of a freighter whose manifest tooltip is pinned open
    agentTabCounts: {},    // agent name -> count, for "hermes 1", "hermes 2" garrison tab labels
    closingShips: [],      // departing ships mid fade-out: { ship, closingSince }
    shipColorIndex: 0,
    layoutScale: 1,        // shrinks planets/sun/labels together when the visible strip is short
    view: { scale: 1, offsetX: 0, offsetY: 0 }, // user zoom/pan on top of the fitted layout; screen = world * scale + offset
    panArmed: false,       // mousedown on empty space while zoomed in, waiting to see if it becomes a drag
    isPanning: false,
    panStartScreen: null,
    panStartOffset: null,
    planetDragArmed: false,   // mousedown on a planet while frozen, waiting to see if it becomes a drag
    isDraggingPlanet: false,  // a planet drag passed the movement threshold and is live
    dragPlanetId: null,       // id of the planet currently being dragged
    dragStartScreen: null,    // canvas-space pointer position when the drag armed
    dragStartWorld: null,     // planet world position when the drag armed
    suppressNextClick: false, // set when a real pan/drag just happened, so the trailing click does not also select
    render3dActive: false,  // user intent, set synchronously on toggle click (renderer3d.js loads async)
    render3d: null,         // the handle from initRenderer3D once the dynamic import resolves
    lastPointer3d: { x: 0, y: 0 }, // last onHover clientX/clientY from the 3D canvas; onClick's own
                                  // callback gets no coordinates (see renderer3DOnClick), so a
                                  // freighter-pin click reuses the position from the hover just before it
    pendingCloseTabId: null // tab awaiting a Yes/No answer in the close-tab popup, see requestTabClose
  };

  var els = {};

  /* ======================================================================
   * API
   * ==================================================================== */

  function apiGetPlanets() {
    return fetch("/api/planets", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("planets fetch failed: " + res.status);
        return res.json();
      });
  }

  function apiPatchPlanet(id, patch) {
    return fetch("/api/planets/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }).then(function (res) {
      if (!res.ok) throw new Error("planet update failed: " + res.status);
      return res.json();
    });
  }

  function apiCreatePlanet(data) {
    return fetch("/api/planets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }).then(function (res) {
      if (!res.ok) throw new Error("world create failed: " + res.status);
      return res.json();
    });
  }

  function apiGetConfig() {
    return fetch("/api/config", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("config fetch failed: " + res.status);
        return res.json();
      });
  }

  function apiPatchConfig(patch) {
    return fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }).then(function (res) {
      if (!res.ok) throw new Error("config update failed: " + res.status);
      return res.json();
    });
  }

  function apiGetSunDoc() {
    return fetch("/api/sun/doc", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("sun doc fetch failed: " + res.status);
        return res.json();
      });
  }

  function apiDeploy(planetId, agent) {
    return fetch("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planetId: planetId, agent: agent })
    }).then(function (res) {
      if (!res.ok) throw new Error("deploy failed: " + res.status);
      return res.json();
    });
  }

  // Contract: DELETE /api/planets/:id/bases/:name -> {ok:true} | {ok:false,error}, and the
  // documented error statuses (400/404/502) still carry that same JSON body. The one status
  // this can't tell apart from a documented 404 on its own: the backend hasn't been restarted
  // with this route yet, so Express serves its own default (non-JSON) 404 page instead. Resolve
  // with the parsed body whenever the response IS JSON (whatever its HTTP status, per the
  // contract above); only reject with notImplemented when the body isn't JSON at all, which is
  // what an unmatched route looks like.
  function apiRemoveBase(planetId, sessionName) {
    return fetch("/api/planets/" + encodeURIComponent(planetId) + "/bases/" + encodeURIComponent(sessionName), {
      method: "DELETE"
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!body) {
          var err = new Error("remove endpoint not available yet");
          err.notImplemented = true;
          throw err;
        }
        return body;
      });
    });
  }

  // Local-only: alive local pty sessions the server is currently holding
  // (attached or detached-but-buffering). Used on load to cross-check
  // localStorage before recreating any tab — see restoreLocalTerminalTabs.
  function apiGetTerminals() {
    return fetch("/api/terminals", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("terminals fetch failed: " + res.status);
        return res.json();
      });
  }

  // Moon add/remove mirror apiPatchPlanet/apiCreatePlanet's plain reject-on-!ok contract
  // (unlike apiRemoveBase, which has to tell a real 404 apart from an old server that
  // doesn't have the route yet) -- this route always exists once the server is running
  // the current code, so a non-JSON response just isn't a case worth handling specially.
  function apiAddMoon(planetId, name, sshTarget) {
    var payload = { name: name };
    if (sshTarget) payload.sshTarget = sshTarget;
    return fetch("/api/planets/" + encodeURIComponent(planetId) + "/moons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error("add moon failed: " + res.status);
      return res.json();
    });
  }

  function apiRemoveMoon(planetId, name) {
    return fetch("/api/planets/" + encodeURIComponent(planetId) + "/moons/" + encodeURIComponent(name), {
      method: "DELETE"
    }).then(function (res) {
      if (!res.ok) throw new Error("remove moon failed: " + res.status);
      return res.json();
    });
  }

  function wsUrl(path) {
    var scheme = (location.protocol === "https:") ? "wss://" : "ws://";
    return scheme + location.host + path;
  }

  /* ======================================================================
   * CANVAS RENDER
   * ==================================================================== */

  function setupCanvas() {
    state.canvas = document.getElementById("galaxy-canvas");
    state.ctx = state.canvas.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", function () {
      resizeCanvas();
      layoutPlanets(); // usable width and the drawer's own 50vh height both changed, refit orbits
      resetView(); // area shape changed -- drop any zoom/pan so the fit and the view never fight
    });
    state.canvas.addEventListener("click", onCanvasClick);
    state.canvas.addEventListener("dblclick", onCanvasDblClick);
    state.canvas.addEventListener("wheel", onCanvasWheel, { passive: false });
    state.canvas.addEventListener("mousedown", onCanvasMouseDown);
    state.canvas.addEventListener("mousemove", onCanvasMouseMove);
    state.canvas.addEventListener("mouseleave", onCanvasMouseLeave);
  }

  // Single source of truth for device pixel ratio. Used both to size the main canvas
  // (below) and to size every pre-rendered sprite (sun/planet/moon/ship-glow/freighter)
  // so a sprite's actual bitmap resolution matches what the dpr-scaled context asks of
  // it -- otherwise the browser has to upsample a 1x sprite onto a dpr-times-larger
  // physical-pixel rect, which is exactly the blur reported on high-DPI displays.
  function currentDpr() {
    return window.devicePixelRatio || 1;
  }

  // The resolution factor every cached sprite is actually built at: real device pixel
  // ratio times the fixed supersample factor above. Kept separate from currentDpr()
  // because the MAIN canvas (resizeCanvas below) must stay at true dpr -- building it
  // 2x larger than the screen would just waste memory/fill-rate for nothing, since a
  // full-size canvas has no "downscale headroom" problem the way a small sprite does.
  function spriteScale() {
    return currentDpr() * SPRITE_SUPERSAMPLE;
  }

  function resizeCanvas() {
    var dpr = currentDpr();
    var w = window.innerWidth;
    var h = window.innerHeight;
    state.canvas.width = Math.floor(w * dpr);
    state.canvas.height = Math.floor(h * dpr);
    state.canvas.style.width = w + "px";
    state.canvas.style.height = h + "px";
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Sprites are supersampled (see spriteScale()) specifically so they can be downscaled
    // onto the main canvas at small on-screen radii; "high" quality filtering is what
    // makes that downscale actually look good instead of aliasing. Must be re-set here
    // because it resets whenever canvas.width/height are assigned above.
    state.ctx.imageSmoothingEnabled = true;
    state.ctx.imageSmoothingQuality = "high";

    // Every sprite cache key below already includes dpr (see the build*Sprite callers),
    // so a stale low-res sprite is never reused after a dpr change -- but the cache
    // dicts would otherwise just accumulate one extra stale entry per old dpr forever
    // (e.g. dragging the window between a 100% and a 150% monitor repeatedly). Clearing
    // them here, only when dpr actually changed, keeps that bounded.
    if (state.lastDpr !== dpr) {
      state.lastDpr = dpr;
      state.sunSprite = null;
      state.planetSpriteCache = {};
      state.moonSpriteCache = {};
      state.shipGlowCache = {};
      state.freighterSpriteCache = {};
    }

    generateStars();
    buildNebula();
  }

  function generateStars() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    // Far layer: more, smaller, dimmer. Near layer: fewer, bigger, brighter. Both give a
    // two-plane depth cue when parallax-shifted by different fractions of the pan offset.
    state.starsFar = buildStarLayer(w, h, Math.min(220, Math.floor((w * h) / 3200)), 0.2, 0.6, 0.15, 0.35);
    state.starsNear = buildStarLayer(w, h, Math.min(70, Math.floor((w * h) / 11000)), 0.8, 1.4, 0.35, 0.55);
  }

  function buildStarLayer(w, h, count, rMin, rMax, baseAlpha, twinkleAlpha) {
    var stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: rMin + Math.random() * (rMax - rMin),
        phase: Math.random() * Math.PI * 2,
        speed: 0.0006 + Math.random() * 0.0012,
        baseAlpha: baseAlpha,
        twinkleAlpha: twinkleAlpha
      });
    }
    return stars;
  }

  // Soft nebula blobs, generated once per viewport size onto an offscreen canvas (with
  // padding so a small pan never reveals the edge). Regenerated only on resize.
  // Deliberately left at 1x (no dpr) unlike the other sprites below: it is meant to read
  // as a soft background wash, so upscaling it costs nothing visually and building it at
  // dpr resolution would only add pixels nobody would notice.
  function buildNebula() {
    var w = window.innerWidth + NEBULA_PADDING * 2;
    var h = window.innerHeight + NEBULA_PADDING * 2;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var c = canvas.getContext("2d");
    c.globalCompositeOperation = "lighter";

    var blobCount = 25 + Math.floor(Math.random() * 11);
    for (var i = 0; i < blobCount; i++) {
      var x = Math.random() * w;
      var y = Math.random() * h;
      var r = 80 + Math.random() * 180;
      var violet = Math.random() < 0.5;
      var color = violet ? "rgba(107, 77, 155, 0.08)" : "rgba(42, 61, 107, 0.08)";
      var grad = c.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      c.fillStyle = grad;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }

    state.nebula = { canvas: canvas, w: w, h: h };
  }

  function hashStringToUnit(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return (hash % 1000) / 1000;
  }

  // Seeds from the planet's own identity color: the server-forwarded planet.color field
  // first (so renames never shift a planet's hue -- it's keyed by id via that field, never
  // by name or array position), then the map's own PLANET_IDENTITY_COLORS as a fallback
  // for planets the server doesn't tag yet, then the generic rotation as a last resort.
  // harmonizePlanetColor() is idempotent, so re-deriving from an already-harmonized
  // planet.color on every layout pass is safe and never drifts.
  function colorForPlanet(planet, index) {
    var seed = planet.color || PLANET_IDENTITY_COLORS[planet.id] || PLANET_COLORS[index % PLANET_COLORS.length];
    return harmonizePlanetColor(seed);
  }

  // Rotates through SHIP_COLORS so every open tab gets a distinct, persistent color
  // for the lifetime of that tab (assigned once, at tab-open, never reassigned).
  function nextShipColor() {
    var color = SHIP_COLORS[state.shipColorIndex % SHIP_COLORS.length];
    state.shipColorIndex++;
    return color;
  }

  /* ---- color helpers: hex <-> hsl, used for the harmonized planet palette and for the
   * sphere shading (lit/base/dark terminator colors derived from one identity hue) ---- */

  function hexToRgba(hex, alpha) {
    var h = hex.replace("#", "");
    var r = parseInt(h.substring(0, 2), 16);
    var g = parseInt(h.substring(2, 4), 16);
    var b = parseInt(h.substring(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  // Linear RGB blend of two hex colors, used to tint the freighter's neutral hull with a
  // touch of the planet's own color (t = 0 is pure hexA, 1 is pure hexB).
  function blendHexColors(hexA, hexB, t) {
    var a = hexA.replace("#", "");
    var b = hexB.replace("#", "");
    var ar = parseInt(a.substring(0, 2), 16), ag = parseInt(a.substring(2, 4), 16), ab = parseInt(a.substring(4, 6), 16);
    var br = parseInt(b.substring(0, 2), 16), bg = parseInt(b.substring(2, 4), 16), bb = parseInt(b.substring(4, 6), 16);
    var toHex = function (v) {
      var n = Math.max(0, Math.min(255, Math.round(v)));
      var s = n.toString(16);
      return s.length === 1 ? "0" + s : s;
    };
    return "#" + toHex(ar + (br - ar) * t) + toHex(ag + (bg - ag) * t) + toHex(ab + (bb - ab) * t);
  }

  function hexToHsl(hex) {
    var h = hex.replace("#", "");
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
    s = s / 100;
    l = l / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    var toHex = function (v) {
      var n = Math.round((v + m) * 255);
      var s2 = n.toString(16);
      return s2.length === 1 ? "0" + s2 : s2;
    };
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }

  function adjustLightness(hex, deltaPercent) {
    var hsl = hexToHsl(hex);
    var l = clamp(hsl.l + deltaPercent, 4, 96);
    return hslToHex(hsl.h, hsl.s, l);
  }

  // Keeps each planet's identity hue but pulls saturation/lightness into one shared band
  // so the palette reads as one universe instead of scattered arbitrary colors, without
  // collapsing distinct planets down to just two or three color families.
  function harmonizePlanetColor(hex) {
    var hsl = hexToHsl(hex);
    var s = clamp(hsl.s, 42, 62);
    var l = clamp(hsl.l, 48, 62);
    return hslToHex(hsl.h, s, l);
  }

  // The sidebar eats the left edge of the window in split view (0 in fullscreen, since
  // both the sidebar and the canvas are hidden then). Map centering and orbit radii read
  // this every frame / on layout so they always fit the space actually left for the map.
  function currentSidebarPx() {
    if (state.drawerFullscreen) return 0;
    return state.sidebarCollapsed ? SIDEBAR_RAIL_PX : SIDEBAR_EXPANDED_PX;
  }

  // The terminal drawer eats the bottom of the window in split view (irrelevant in
  // fullscreen, since the map is hidden then). Only the strip above the drawer's top
  // edge is actually visible, so that is what the map has to fit inside.
  function currentDrawerTopPx() {
    if (state.drawerFullscreen) return window.innerHeight;
    // Tall mode ("^"): the drawer fills the whole right-side height, so its top edge sits at
    // y=0 -- the map gets zero height, same idea as fullscreen, but unlike fullscreen the
    // sidebar is untouched: currentSidebarPx() below still reserves its width, so this is
    // zero-height, not zero-width. getMapArea()'s Math.max(140, ...) floor keeps this sane even
    // though nothing draws while expanded (render is paused -- see enterDrawerExpanded).
    if (state.drawerExpanded) return 0;
    if (state.drawerCollapsed) return window.innerHeight - DRAWER_HANDLE_PX;
    return window.innerHeight * (1 - DRAWER_OPEN_HEIGHT_FRAC);
  }

  function getMapArea() {
    var offsetX = currentSidebarPx();
    var width = Math.max(200, window.innerWidth - offsetX);
    var height = Math.max(140, currentDrawerTopPx());
    return { offsetX: offsetX, width: width, height: height };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Shared label-collision helpers used by drawWorldLabels (planet names) and
  // drawDecorLabels (moon/freighter labels) to keep default-orbit-mode labels from
  // rendering on top of each other. A "box" is a centered text bounding rect in screen
  // space: {left, right, top, bottom}.
  function textLabelBox(centerX, baselineY, width, fontSize) {
    var halfW = width / 2;
    return { left: centerX - halfW, right: centerX + halfW, top: baselineY - fontSize * 0.8, bottom: baselineY + fontSize * 0.3 };
  }

  function labelBoxesIntersect(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  // Single shared view transform: everything drawn on the map (sun, orbits, planets,
  // ships, pulse ring) and every hit-test both go through this pair, so zoom/pan never
  // needs separate math bolted onto individual features.
  //   screen = world * view.scale + view.offset
  function worldToScreen(wx, wy) {
    return { x: wx * state.view.scale + state.view.offsetX, y: wy * state.view.scale + state.view.offsetY };
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - state.view.offsetX) / state.view.scale, y: (sy - state.view.offsetY) / state.view.scale };
  }

  function applyViewTransform(ctx) {
    ctx.translate(state.view.offsetX, state.view.offsetY);
    ctx.scale(state.view.scale, state.view.scale);
  }

  // Default fitted view: scale 1, no pan -- world and screen coincide exactly, same as
  // before zoom existed. Called on reset (dblclick / Fit button) and whenever the map
  // area's shape changes (drawer, sidebar, fullscreen) so the fit fix and zoom never fight.
  function resetView() {
    state.view.scale = 1;
    state.view.offsetX = 0;
    state.view.offsetY = 0;
  }

  // Anything that changes getMapArea()'s shape WITHOUT an actual browser window resize
  // (drawer toggle, sidebar collapse, returning from fullscreen) must call this instead of
  // layoutPlanets()+resetView() directly. renderer3d.js only re-syncs its camera aspect and
  // setViewOffset rectangle from its own internal window-resize listener (see applyViewport
  // in that file) -- a drawer/sidebar change alone never fires that event, so without this,
  // the 3D camera's framing silently drifts out of sync with the live map area (root cause
  // of the "planet slides behind the sidebar on drawer open" bug: the 2D map re-centers every
  // frame by moving the sun's own world position via getMapArea(), but the 3D camera instead
  // shifts its projected frustum via setViewOffset, and that only ever gets refreshed here).
  function refitMapArea() {
    layoutPlanets();
    resetView();
    if (state.render3d) state.render3d.resize();
  }

  function layoutPlanets() {
    var area = getMapArea();
    var margin = 60; // room for sun glow + outermost planet + its label

    // Orbits are drawn flattened (y-extent = orbitRadius * 0.55, see drawPlanets), so
    // the height budget affords a bigger radius than the width budget for the same
    // pixel count. Compute both and take the tighter one so nothing clips either edge.
    var maxRadiusFromWidth = area.width * 0.5 - margin;
    var maxRadiusFromHeight = (area.height * 0.5 - margin) / 0.55;
    var maxRadius = Math.min(maxRadiusFromWidth, maxRadiusFromHeight);

    // When the visible strip is short or narrow (drawer open on a small window), shrink
    // the whole system together -- orbits, planet size, labels -- instead of clipping.
    var scale = 1;
    if (maxRadius < 110) {
      scale = Math.max(0.35, maxRadius / 110);
      maxRadius = 110 * scale;
    }
    var baseMinRadius = 90 * scale;
    if (maxRadius < baseMinRadius + 10) maxRadius = baseMinRadius + 10;

    state.layoutScale = scale;

    var n = state.planets.length;
    // Pre-v1.3 spacing (kept only as the reference the 25%-tighter gap is measured from).
    var originalSpacing = n > 1 ? (maxRadius - baseMinRadius) / (n - 1) : 0;

    var firstOrbitRadius = baseMinRadius * ORBIT_FIRST_MULT;
    var orbitSpacing = originalSpacing * ORBIT_SPACING_MULT;

    // Safety net only: the 50%-farther first orbit never yields, but spacing tightens
    // further than the 25% above if that's what it takes to keep the outermost planet
    // inside the visible area when there are many planets.
    if (n > 1) {
      var lastRadius = firstOrbitRadius + (n - 1) * orbitSpacing;
      if (lastRadius > maxRadius) {
        orbitSpacing = Math.max(4, (maxRadius - firstOrbitRadius) / (n - 1));
      }
    }

    var middleIndex = (n - 1) / 2;
    var middleRadius = firstOrbitRadius + middleIndex * orbitSpacing;

    state.planets.forEach(function (planet, i) {
      var radius = firstOrbitRadius + i * orbitSpacing;
      planet.orbitRadius = radius;

      // Kepler-style variation: angular speed ~ 1/sqrt(radius), normalized so the middle
      // orbit runs at the new (halved) base speed, plus a small +/-15% per-planet jitter
      // seeded from the planet id so it's stable across frames (but free to differ across
      // reloads, since layoutPlanets recomputes fresh planet objects on every refresh).
      var keplerSpeed = ORBIT_BASE_SPEED * Math.sqrt(middleRadius / radius);
      var jitter = 1 + (hashStringToUnit(planet.id + "|speed") * 2 - 1) * ORBIT_SPEED_JITTER;
      planet.orbitSpeed = keplerSpeed * jitter;

      planet.orbitPhase = hashStringToUnit(planet.id) * Math.PI * 2;
      planet.color = colorForPlanet(planet, i);
      planet.visualRadius = (10 + (i % 3) * 2) * scale;
      planet.freighter = buildFreighterForPlanet(planet);
      planet.moonSprites = buildMoonsForPlanet(planet);
    });
  }

  // Cargo freighter: ONE static vessel per planet carrying all of planet.craft (its apps),
  // orbiting in the fixed FREIGHTER_ORBIT_MIN..MAX band. Hull color is a slight tint of the
  // planet's own color over a subdued neutral base, hash-derived from planet id so it's
  // stable across reloads. Returns null for planets with no craft (nothing gets drawn).
  function buildFreighterForPlanet(planet) {
    var names = planet.craft || [];
    if (!names.length) return null;
    // Live-status contract (v1.6, backend landing in parallel): planet.apps, when present,
    // is [{name, running: true|false|null}] in the same order as craft. Until it lands (or
    // for any planet the backend hasn't wired up yet), planet.apps is simply absent and we
    // fall back to the plain name list exactly as before -- appsKnown stays false and
    // manifestText/drawDecorLabels skip the status-dot styling entirely.
    // NOTE: "manifest" itself stays a plain string[] -- that's a documented cross-agent
    // contract field (public/render3d/renderer3d.js reads planet.freighter.manifest.join('|')
    // as a rebuild cache key, expecting plain names). The richer per-app status lives in the
    // separate appStatus field below, which only this file's own tooltip code reads.
    var apps = Array.isArray(planet.apps) ? planet.apps : null;
    var appsKnown = !!apps;
    var appStatus = names.map(function (name, idx) {
      var entry = apps && apps[idx];
      return { name: name, running: entry ? entry.running : null };
    });
    var anyRunning = appsKnown && apps.some(function (a) { return a && a.running === true; });
    var seed = planet.id + "|freighter";
    var radius = FREIGHTER_ORBIT_MIN + hashStringToUnit(seed + "|radius") * (FREIGHTER_ORBIT_MAX - FREIGHTER_ORBIT_MIN);
    var direction = hashStringToUnit(seed + "|dir") < 0.5 ? 1 : -1;
    // The hull's own dimensions (segment count, length, hit radius) come from one shared
    // metrics function so the drawn sprite and the click hit-test never disagree.
    var metrics = freighterHullMetrics(names.length);
    return {
      label: "Apps (" + names.length + ")",
      manifest: names.slice(),
      appStatus: appStatus,
      appsKnown: appsKnown,
      anyRunning: anyRunning,
      segCount: metrics.segCount,
      hitRadius: metrics.hitRadius,
      hullColor: blendHexColors(FREIGHTER_HULL_BASE, planet.color, FREIGHTER_TINT_AMOUNT),
      orbitRadius: radius,
      orbitPhase: hashStringToUnit(seed + "|phase") * Math.PI * 2,
      orbitSpeed: FREIGHTER_ORBIT_SPEED * direction
    };
  }

  // Moon entries are {name, sshTarget?} objects going forward (added via the sidebar's
  // Add moon control), but planets.json -- and the server response, belt-and-suspenders --
  // may still carry bare name strings for moons that predate that UI. Normalizing on read
  // here means every other place that touches a moon (rendering, tooltip) only ever deals
  // with one shape.
  function normalizeMoonEntry(m) {
    if (typeof m === "string") return { name: m, sshTarget: null };
    return { name: m.name, sshTarget: m.sshTarget || null };
  }

  // Mirrors lib/planets.js's moonPlanetId() exactly -- this string is what lets moon Travel
  // reuse the whole unmodified planet Travel/pty-bridge pipeline: the server's getPlanet(id)
  // recognizes the "moon:" prefix and hands pty-bridge a planet-shaped object carrying the
  // MOON's own sshTarget instead of the parent's. Never used for planet lookups on the
  // client side (findPlanet/state.planets), only as the id passed into openTerminalTab.
  function moonTravelPlanetId(parentId, moonName) {
    return "moon:" + parentId + ":" + moonName;
  }

  // Per-planet collapse state for the Moons section, so a reload restores whatever the
  // user last chose for THAT planet rather than one global on/off. Absent key (never
  // toggled) is distinct from an explicit "0" -- buildTreeRow falls back to the
  // has-moons-by-default rule only when this returns null.
  function moonsOpenStorageKey(planetId) {
    return "galaxy.moonsOpen." + planetId;
  }

  function getMoonsOpenPref(planetId) {
    var stored;
    try { stored = localStorage.getItem(moonsOpenStorageKey(planetId)); } catch (e) { stored = null; }
    if (stored === "1") return true;
    if (stored === "0") return false;
    return null;
  }

  function setMoonsOpenPref(planetId, isOpen) {
    try { localStorage.setItem(moonsOpenStorageKey(planetId), isOpen ? "1" : "0"); } catch (e) { /* private mode etc, non-fatal */ }
  }

  // Moons: small pale spheres orbiting outside the freighter band, one per planet.moons entry.
  function buildMoonsForPlanet(planet) {
    var rawMoons = planet.moons || [];
    var n = rawMoons.length;
    return rawMoons.map(function (raw, idx) {
      var moon = normalizeMoonEntry(raw);
      var seed = planet.id + "|moon|" + moon.name;
      var radius = n > 1 ? (MOON_ORBIT_MIN + (idx / (n - 1)) * (MOON_ORBIT_MAX - MOON_ORBIT_MIN)) : MOON_ORBIT_MIN + 4;
      return {
        label: moon.name,
        sshTarget: moon.sshTarget,
        radius: 4 + (idx % 2),
        orbitRadius: radius,
        orbitPhase: hashStringToUnit(seed) * Math.PI * 2,
        orbitSpeed: 0.00006 * ((idx % 2 === 0) ? 1 : -1)
      };
    });
  }

  function drawFrame(timestamp) {
    if (state.renderPaused) return; // fullscreen terminals: map hidden, stop the rAF chain entirely

    updateOrbitClock(timestamp);
    updateAligning(timestamp);

    var ctx = state.ctx;
    var w = window.innerWidth;
    var h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    var area = getMapArea();

    // Background layers: screen space, outside the view transform. Nebula and starfield
    // shift a little with pan (parallax) but never scale with zoom -- they read as
    // infinitely distant. Shooting stars are a foreground screen-space flourish.
    drawNebula(ctx);
    drawStarfield(ctx, timestamp);
    drawShootingStars(ctx, timestamp);

    ctx.save();
    applyViewTransform(ctx);
    drawSun(ctx, area, timestamp);
    drawPlanets(ctx, area, timestamp);
    drawShips(ctx, timestamp);
    drawStaticDecor(ctx);
    ctx.restore();

    // Text is drawn in screen space (after the transform is restored) with its own
    // zoom-clamped size, so labels stay readable at any zoom level instead of shrinking
    // or blowing up 1:1 with the map content.
    drawWorldLabels(ctx);
    drawDecorLabels(ctx);

    requestAnimationFrame(drawFrame);
  }

  // Orbit clock: the only clock planet/moon/freighter angles read from. It stops advancing
  // while frozen and resumes exactly where it left off, so freeze/unfreeze never jumps.
  // Ship motion, star twinkle, and trails deliberately keep reading the raw rAF timestamp
  // instead, so they never freeze with the planets.
  function updateOrbitClock(timestamp) {
    if (state.lastFrameTimestamp === null) state.lastFrameTimestamp = timestamp;
    var dt = timestamp - state.lastFrameTimestamp;
    state.lastFrameTimestamp = timestamp;
    if (dt < 0) dt = 0;
    if (!state.frozen) state.orbitClock += dt;
  }

  function normalizeAngle(a) {
    var twoPi = Math.PI * 2;
    a = a % twoPi;
    if (a < 0) a += twoPi;
    return a;
  }

  function angularDistance(a, b) {
    var d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? (Math.PI * 2 - d) : d;
  }

  // Nearest of angle 0 or PI (right/left of the sun), so aligned planets land on both
  // sides rather than all piling onto the same side.
  function nearestAlignTarget(angle) {
    var norm = normalizeAngle(angle);
    return (angularDistance(norm, 0) <= angularDistance(norm, Math.PI)) ? 0 : Math.PI;
  }

  // Shortest-arc interpolation so a planet at ~350deg tweening to 0 sweeps forward through
  // 360/0 instead of the long way back around.
  function lerpAngleShortest(a, b, t) {
    var diff = normalizeAngle(b - a);
    if (diff > Math.PI) diff -= Math.PI * 2;
    return a + diff * t;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? (4 * t * t * t) : (1 - Math.pow(-2 * t + 2, 3) / 2);
  }

  function updateFreezeButtonUI() {
    els.btnMapFreeze.classList.toggle("active", state.frozen);
  }

  function toggleFreeze() {
    state.frozen = !state.frozen;
    state.alignedFrozen = false;
    // Unfreezing returns everything to its computed orbit position, so any dragged
    // arrangement (and its stored copy) is dropped; freezing persists the current state
    // so a reload while frozen can restore it.
    if (state.frozen) persistFrozenArrangement(); else clearFrozenArrangement();
    updateFreezeButtonUI();
  }

  // True once an Align has settled (planets held on the 0/PI line). Drives the moon-stacking
  // and min-label-spacing layout; plain Freeze leaves planets wherever their orbit paused.
  function isAligned() {
    return state.alignedFrozen;
  }

  // Persist the current frozen arrangement (frozen flags + any per-planet drag overrides) so
  // a reload while still frozen restores it. Non-fatal in private mode.
  function persistFrozenArrangement() {
    try {
      localStorage.setItem(PLANET_OVERRIDE_STORAGE_KEY, JSON.stringify({
        frozen: state.frozen,
        alignedFrozen: state.alignedFrozen,
        overrides: state.dragOverrides
      }));
    } catch (e) { /* private mode etc, non-fatal */ }
  }

  // Drop every drag override AND its stored copy, returning planets to computed positions.
  function clearFrozenArrangement() {
    state.dragOverrides = {};
    try { localStorage.removeItem(PLANET_OVERRIDE_STORAGE_KEY); } catch (e) { /* non-fatal */ }
  }

  // On load, if the last session left the map frozen, restore that (flags + overrides) so the
  // arrangement survives a reload. Anything cleared on unfreeze already removed the storage.
  function restoreFrozenArrangement() {
    var raw = null;
    try { raw = localStorage.getItem(PLANET_OVERRIDE_STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed || !parsed.frozen) return;
    state.frozen = true;
    state.alignedFrozen = !!parsed.alignedFrozen;
    state.dragOverrides = (parsed.overrides && typeof parsed.overrides === "object") ? parsed.overrides : {};
    if (els.btnMapFreeze) updateFreezeButtonUI();
  }

  // Align: freezes the orbit clock immediately (so the tween has a stable start), tweens
  // each planet's own angle to the nearest of 0/PI over 300-600ms, then leaves everything
  // frozen in place. Clicking Align again while in that aligned-frozen state resumes normal
  // orbiting instead of re-aligning (mirrors "toggling Freeze off" per spec).
  function triggerAlign() {
    if (state.aligning) return;
    if (state.frozen && state.alignedFrozen) {
      state.frozen = false;
      state.alignedFrozen = false;
      clearFrozenArrangement(); // re-clicking Align resumes orbiting and drops the arrangement
      updateFreezeButtonUI();
      return;
    }

    state.frozen = true;
    state.alignedFrozen = false;
    // A fresh Align recomputes every position from scratch, so any earlier drag overrides
    // are discarded first; the settled arrangement is persisted in updateAligning.
    clearFrozenArrangement();
    updateFreezeButtonUI();

    var now = performance.now();
    state.planets.forEach(function (planet) {
      var currentAngle = normalizeAngle(planet.orbitPhase + state.orbitClock * planet.orbitSpeed);
      var target = nearestAlignTarget(currentAngle);
      planet._align = {
        startAngle: currentAngle,
        targetAngle: target,
        startTime: now,
        duration: 300 + Math.random() * 300
      };
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
        // orbitClock is frozen for the whole tween, so this exactly holds the planet at
        // targetAngle once frozen motion resumes being read through the normal formula.
        planet.orbitPhase = normalizeAngle(a.targetAngle - state.orbitClock * planet.orbitSpeed);
        delete planet._align;
        delete planet._alignAngle;
      }
    });
    if (!stillGoing) {
      state.aligning = false;
      state.alignedFrozen = true;
      persistFrozenArrangement(); // remember the settled aligned state so a reload restores it
    }
  }

  function pauseRender() {
    state.renderPaused = true;
  }

  function resumeRender() {
    if (!state.renderPaused) return;
    state.renderPaused = false;
    requestAnimationFrame(drawFrame);
  }

  // MOTION BUG FIX (3D mode): drawFrame is the only place that ever advances state.orbitClock
  // (via updateOrbitClock) or ticks the Align tween (via updateAligning), and it does both
  // only on its way to the expensive 2D canvas draw calls. pauseRender() -- called by
  // enterRender3D() -- makes drawFrame return before reaching any of that, which used to
  // freeze orbitClock forever the instant 3D turned on. renderer3d.js was never the problem:
  // it already re-reads dataProvider.getOrbitClock() every one of its own animation frames
  // and computes planet/moon/freighter angles with the identical orbitPhase + orbitClock *
  // orbitSpeed formula 2D uses (including _align/_alignAngle support for the Align button) --
  // it was just being handed the same frozen number forever. This ticker keeps orbitClock
  // and the Align tween alive while 2D drawing is paused for 3D specifically, without
  // resurrecting any of the canvas draw work and without touching pauseRender/resumeRender's
  // other caller (enterFullscreen/exitFullscreen), whose "stop advancing while hidden" behavior
  // is intentional and untouched. Ship motion needs no equivalent fix -- ships read a raw
  // wallClock timestamp inside renderer3d.js's own always-running animation loop, never
  // app.js's orbitClock, so they were already animating correctly in 3D.
  function tickOrbitClock3D(timestamp) {
    if (!state.render3dActive) { state.render3dTickId = null; return; }
    updateOrbitClock(timestamp);
    updateAligning(timestamp);
    state.render3dTickId = requestAnimationFrame(tickOrbitClock3D);
  }

  /* ======================================================================
   * 3D RENDER TOGGLE -- RETIRED (2026-07-09, product decision)
   * The toggle button is hidden in index.html and initRender3DPreference()
   * below no longer honors a stored "1", so nothing in the app can reach
   * enterRender3D()/the dynamic import() anymore. Everything in this
   * section stays in the file, unused, per the no-delete rule -- along
   * with public/render3d/ itself, untouched on disk. Original header:
   *
   * 3D RENDER TOGGLE (v2.0, see galaxy/render3d_integration.md)
   * public/render3d/renderer3d.js is an ES module (owned by a different
   * agent); this file stays a classic script, so it's loaded via dynamic
   * import() only on first switch-on rather than a static module tag. The
   * 2D canvas stays the default renderer always -- this section only ever
   * runs once the user opts in (or had opted in on a previous visit).
   * ==================================================================== */
  var RENDER3D_STORAGE_KEY = "galaxyRenderer3d";

  // Read-only view of live app.js state for the 3D renderer to poll each frame -- it never
  // mutates any of this, only mirrors it onto its own meshes (see the module's own header
  // comment). tab.ship doesn't carry tabId today, so it's added here at mapping time.
  function buildRenderer3DDataProvider() {
    return {
      getPlanets: function () { return state.planets; },
      getShips: function () {
        var live = state.terminalTabs.filter(function (t) { return t.ship; })
          .map(function (t) { return Object.assign({ tabId: t.id }, t.ship); });
        var closing = state.closingShips.map(function (entry) {
          var elapsed = performance.now() - entry.closingSince;
          return Object.assign(
            { tabId: "closing:" + entry.closingSince, fadeAlpha: Math.max(0, 1 - elapsed / SHIP_DEPART_MS) },
            entry.ship
          );
        });
        return live.concat(closing);
      },
      getSunName: function () { return state.config.sunName || "Workspace"; },
      getOrbitClock: function () { return state.orbitClock; },
      getViewport: getMapArea
    };
  }

  // Click dispatch mirrors onCanvasClick's own priority order (ship > freighter/moon > sun
  // > planet) -- the raycaster in renderer3d.js already reproduces that same order, so this
  // only routes each resolved hit to the same functions the 2D canvas calls.
  // CONTRACT NOTE: the integration spec's own pseudocode references clientX/clientY inside
  // this callback, but renderer3d.js's real onClick handler only ever passes hit (confirmed
  // by reading the module directly -- onHover gets coordinates, onClick does not). A
  // freighter-pin click needs a screen position for the pinned tooltip, so this reuses
  // state.lastPointer3d, captured by the hover callback just below -- accurate because a
  // click can't land on a hit without an onHover over that same spot having fired first.
  function renderer3DOnClick(hit) {
    if (hit.kind === "ship") {
      closeManifestPin();
      var shipTab = findTabById(hit.id);
      if (shipTab) selectPlanet(shipTab.planetId, "map");
      activateTab(hit.id);
      expandDrawer();
      return;
    }
    if (hit.kind === "freighter") {
      toggleManifestPinAt("freighter:" + hit.id, state.lastPointer3d.x, state.lastPointer3d.y);
      return;
    }
    if (hit.kind === "moon") {
      closeManifestPin();
      return;
    }
    closeManifestPin(); // click-away on sun/planet closes any pinned manifest, same as 2D
    if (hit.kind === "sun") {
      openSunDocTab();
      return;
    }
    if (hit.kind === "planet") {
      selectPlanet(hit.id, "map");
    }
  }

  // Hover dispatch mirrors onCanvasMouseMove: ship/freighter/moon get the same tooltip
  // functions the 2D canvas already uses (no duplicate tooltip rendering); sun/planet show
  // no tooltip in 2D either, so this just clears one if present.
  // Moon hit.id from renderer3d.js is "<planetId>:<moonIdx>" (see its resolveHit) -- prefixing
  // "moon:" reconstructs app.js's own decorPositions key ("moon:<planetId>:<idx>") exactly;
  // the integration spec only spelled out the freighter case explicitly, this follows the
  // same pattern for moons since showDecorTooltip needs the real decorPositions key either way.
  function renderer3DOnHover(hit, clientX, clientY) {
    state.lastPointer3d = { x: clientX, y: clientY };
    if (hit.kind === "ship") {
      showShipTooltip(hit.id, clientX, clientY);
      return;
    }
    if (hit.kind === "freighter") {
      showDecorTooltip("freighter:" + hit.id, clientX, clientY);
      return;
    }
    if (hit.kind === "moon") {
      showDecorTooltip("moon:" + hit.id, clientX, clientY);
      return;
    }
    hideShipTooltip();
  }

  function persistRender3DPref(active) {
    try { localStorage.setItem(RENDER3D_STORAGE_KEY, active ? "1" : "0"); } catch (e) { /* private mode etc, non-fatal */ }
  }

  function enterRender3D() {
    if (state.render3dActive) return;
    state.render3dActive = true;
    els.canvas3d.classList.remove("hidden");
    state.canvas.classList.add("hidden");
    pauseRender();
    state.lastFrameTimestamp = null; // fresh dt=0 for the first 3D tick, no post-pause time jump
    if (state.render3dTickId === null) state.render3dTickId = requestAnimationFrame(tickOrbitClock3D);
    els.btnMapRenderer.classList.add("active");
    persistRender3DPref(true);
    import("./render3d/renderer3d.js").then(function (mod) {
      if (!state.render3dActive) return; // toggled back off again before this resolved
      state.render3d = mod.initRenderer3D(els.canvas3d, buildRenderer3DDataProvider(), {
        onClick: renderer3DOnClick,
        onEmptyClick: closeManifestPin,
        onHover: renderer3DOnHover,
        onHoverEnd: hideShipTooltip
      });
    }).catch(function (err) {
      showToast("3D renderer failed to load: " + err.message);
      exitRender3D();
    });
  }

  function exitRender3D() {
    state.render3dActive = false;
    if (state.render3d) {
      state.render3d.dispose();
      state.render3d = null;
    }
    els.canvas3d.classList.add("hidden");
    state.canvas.classList.remove("hidden");
    resumeRender();
    resetView(); // 2D fitted view, so toggling back to 2D always lands on a sane default
    els.btnMapRenderer.classList.remove("active");
    persistRender3DPref(false);
  }

  function toggleRender3D() {
    if (state.render3dActive) {
      exitRender3D();
    } else {
      enterRender3D();
    }
  }

  // RETIRED (2026-07-09): this used to restore the user's last 2D/3D choice on load by calling
  // enterRender3D() when RENDER3D_STORAGE_KEY held "1". Now it always forces 2D regardless of
  // what's in localStorage, so a stale "1" saved before the toggle was hidden can never
  // resurrect 3D mode. The storage key itself is left alone (not read anywhere else, no need
  // to clear it) -- see the retirement note on the "3D RENDER TOGGLE" header above.
  function initRender3DPreference() {
    state.render3dActive = false;
  }

  function drawNebula(ctx) {
    if (!state.nebula) return;
    var shiftX = clamp(state.view.offsetX * NEBULA_PARALLAX, -NEBULA_PADDING, NEBULA_PADDING);
    var shiftY = clamp(state.view.offsetY * NEBULA_PARALLAX, -NEBULA_PADDING, NEBULA_PADDING);
    ctx.drawImage(state.nebula.canvas, -NEBULA_PADDING + shiftX, -NEBULA_PADDING + shiftY);
  }

  function drawStarfield(ctx, timestamp) {
    drawStarLayer(ctx, state.starsFar, timestamp, STAR_FAR_PARALLAX);
    drawStarLayer(ctx, state.starsNear, timestamp, STAR_NEAR_PARALLAX);
  }

  function drawStarLayer(ctx, stars, timestamp, parallax) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var shiftX = state.view.offsetX * parallax;
    var shiftY = state.view.offsetY * parallax;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var sx = wrapCoord(s.x + shiftX, w);
      var sy = wrapCoord(s.y + shiftY, h);
      var twinkle = 0.55 + 0.45 * Math.sin(timestamp * s.speed + s.phase);
      ctx.beginPath();
      ctx.fillStyle = "rgba(216, 224, 240, " + (s.baseAlpha + twinkle * s.twinkleAlpha).toFixed(3) + ")";
      ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Keeps a parallax-shifted star inside the viewport instead of drifting off one edge
  // and never coming back while the user holds a large pan.
  function wrapCoord(v, size) {
    var m = v % size;
    if (m < 0) m += size;
    return m;
  }

  function spawnShootingStar(timestamp) {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var fromLeft = Math.random() < 0.5;
    var startX = fromLeft ? -20 : w + 20;
    var startY = Math.random() * h * 0.6;
    var travel = 220 + Math.random() * 140;
    var angle = fromLeft
      ? (Math.PI * 0.18 + Math.random() * 0.15)
      : (Math.PI - Math.PI * 0.18 - Math.random() * 0.15);
    var endX = startX + Math.cos(angle) * travel;
    var endY = startY + Math.sin(angle) * travel;

    state.shootingStars.push({
      startX: startX, startY: startY, endX: endX, endY: endY,
      startTime: timestamp
    });
  }

  function drawShootingStars(ctx, timestamp) {
    if (!state.shootingStarsInited) {
      state.shootingStarsInited = true;
      state.nextShootingStarAt = timestamp + SHOOTING_STAR_MIN_MS + Math.random() * (SHOOTING_STAR_MAX_MS - SHOOTING_STAR_MIN_MS);
    }
    if (timestamp >= state.nextShootingStarAt) {
      spawnShootingStar(timestamp);
      state.nextShootingStarAt = timestamp + SHOOTING_STAR_MIN_MS + Math.random() * (SHOOTING_STAR_MAX_MS - SHOOTING_STAR_MIN_MS);
    }

    state.shootingStars = state.shootingStars.filter(function (star) {
      var elapsed = timestamp - star.startTime;
      if (elapsed > SHOOTING_STAR_LIFE_MS) return false;
      drawOneShootingStar(ctx, star, elapsed);
      return true;
    });
  }

  // A short fading polyline sampled backward along the star's (deterministic, linear)
  // path from its current head position -- cheaper than storing a live position history.
  function drawOneShootingStar(ctx, star, elapsed) {
    var headT = clamp(elapsed / SHOOTING_STAR_LIFE_MS, 0, 1);
    var overallFade = 1 - headT;
    var points = 7;

    ctx.save();
    ctx.lineCap = "round";
    for (var i = 0; i < points; i++) {
      var t0 = clamp(headT - (i + 1) * 0.05, 0, 1);
      var t1 = clamp(headT - i * 0.05, 0, 1);
      var alpha = overallFade * (1 - i / points);
      if (alpha <= 0) continue;
      var x0 = star.startX + (star.endX - star.startX) * t0;
      var y0 = star.startY + (star.endY - star.startY) * t0;
      var x1 = star.startX + (star.endX - star.startX) * t1;
      var y1 = star.startY + (star.endY - star.startY) * t1;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(216, 224, 240, " + alpha.toFixed(3) + ")";
      ctx.lineWidth = 1.5;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Layered corona pre-rendered once per sun radius (regenerates only when layoutScale
  // changes it). Blitted every frame with the breathing pulse applied as a scale factor,
  // never rebuilt for the pulse itself.
  function buildSunSprite(r) {
    var half = r * SUN_CORONA_SCALE;
    var size = Math.ceil(half * 2);
    var dpr = spriteScale();
    var canvas = document.createElement("canvas");
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    var c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    var cx = half, cy = half;

    var outer = c.createRadialGradient(cx, cy, r * 0.5, cx, cy, half);
    outer.addColorStop(0, "rgba(255, 226, 150, 0.35)");
    outer.addColorStop(1, "rgba(255, 226, 150, 0)");
    c.fillStyle = outer;
    c.beginPath();
    c.arc(cx, cy, half, 0, Math.PI * 2);
    c.fill();

    var mid = c.createRadialGradient(cx, cy, r * 0.15, cx, cy, r * 1.6);
    mid.addColorStop(0, "rgba(255, 200, 120, 0.55)");
    mid.addColorStop(1, "rgba(255, 160, 80, 0)");
    c.fillStyle = mid;
    c.beginPath();
    c.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
    c.fill();

    c.beginPath();
    c.fillStyle = "#ffe296";
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();

    return { canvas: canvas, half: half, size: size };
  }

  function drawSun(ctx, area, timestamp) {
    var scale = state.layoutScale || 1;
    var cx = area.offsetX + area.width / 2;
    var cy = area.height / 2;
    var r = 34 * scale;
    state.sunPosition = { x: cx, y: cy, r: r };

    var dpr = spriteScale();
    var spriteKey = Math.round(r * 10) + "|" + dpr;
    if (!state.sunSprite || state.sunSprite.key !== spriteKey) {
      state.sunSprite = buildSunSprite(r);
      state.sunSprite.key = spriteKey;
    }

    var pulse = 0.95 + 0.05 * Math.sin(timestamp * 0.0009);
    var sprite = state.sunSprite;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(pulse, pulse);
    ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half, sprite.size, sprite.size);
    ctx.restore();

    // No crossed lens-flare streaks: the disc plus its baked corona/glow is the whole sun
    // now (the original call -- the rotating "X" over the disc was removed). "Galaxy" label is
    // drawn later in drawWorldLabels(), in screen space, so its size can be zoom-clamped
    // instead of scaling 1:1 with the view transform.
  }

  function drawPlanets(ctx, area, timestamp) {
    var cx = area.offsetX + area.width / 2;
    var cy = area.height / 2;

    // When aligned, precompute an x for each planet that enforces a minimum horizontal gap
    // between same-side neighbours so their labels never touch (see computeAlignedLayout).
    var alignedX = isAligned() ? computeAlignedLayout(ctx, cx) : null;

    state.planets.forEach(function (planet) {
      var angle = planet._align ? planet._alignAngle : (planet.orbitPhase + state.orbitClock * planet.orbitSpeed);
      var x = cx + Math.cos(angle) * planet.orbitRadius;
      var y = cy + Math.sin(angle) * planet.orbitRadius * 0.55; // flattened orbit, galaxy-plane feel

      // Aligned spacing spreads same-side planets onto the 0/PI line; then a live drag
      // override (a planet the user has grabbed while frozen) wins over the computed spot.
      if (alignedX && alignedX[planet.id] !== undefined) {
        x = alignedX[planet.id];
        y = cy;
      }
      var override = state.dragOverrides[planet.id];
      if (override) {
        x = override.x;
        y = override.y;
      }

      // Computed once per planet per frame (not per-caller) since it depends on the live
      // view.scale -- drawPlanetBody, the hit-test radius below, the aligned moon-ring gap,
      // and the label offset in drawWorldLabels all read the same _renderRadius/_glowRatio/
      // _glowAlpha/_rimAlpha so nothing drifts out of sync with what's actually drawn.
      var apparent = apparentBodyRender(planet.visualRadius, PLANET_MIN_APPARENT_R, PLANET_GLOW_TIGHTEN_START);
      planet._renderRadius = apparent.r;
      planet._glowRatio = apparent.glowRatio;
      planet._glowAlpha = apparent.glowAlpha;
      planet._rimAlpha = apparent.rimAlpha;

      state.screenPositions[planet.id] = { x: x, y: y, r: apparent.r + 6 };

      drawOrbitRing(ctx, cx, cy, planet.orbitRadius, angle);
      drawPlanetBody(ctx, planet, x, y, timestamp);
    });
  }

  // Aligned horizontal layout: split planets by the side they settled on (angle 0 = right of
  // the sun, PI = left), then push each side outward so consecutive planets sit at least the
  // widest label's width apart. Measured in world units (font at zoom factor 1) because
  // screenPositions holds pre-view-transform coords; at the default fitted view world and
  // screen coincide, and zooming in only grows the gap faster than the (clamped) labels.
  function computeAlignedLayout(ctx, cx) {
    var fit = state.layoutScale || 1;
    var fontSize = Math.max(9, Math.round(12 * fit));
    ctx.save();
    ctx.font = "500 " + fontSize + "px -apple-system, Segoe UI, sans-serif";
    var minGap = 0;
    state.planets.forEach(function (planet) {
      minGap = Math.max(minGap, ctx.measureText(planet.name).width);
      (planet.moons || []).forEach(function (m) {
        minGap = Math.max(minGap, ctx.measureText(m).width);
      });
    });
    ctx.restore();
    minGap += ALIGN_LABEL_PAD;

    var right = [];
    var left = [];
    state.planets.forEach(function (planet) {
      var angle = planet._align ? planet._alignAngle : (planet.orbitPhase + state.orbitClock * planet.orbitSpeed);
      (Math.cos(angle) >= 0 ? right : left).push(planet);
    });
    var byRadius = function (a, b) { return a.orbitRadius - b.orbitRadius; };
    right.sort(byRadius);
    left.sort(byRadius);

    var out = {};
    var lastX = null;
    right.forEach(function (planet) {
      var x = cx + planet.orbitRadius;
      if (lastX !== null && x < lastX + minGap) x = lastX + minGap;
      out[planet.id] = x;
      lastX = x;
    });
    lastX = null;
    left.forEach(function (planet) {
      var x = cx - planet.orbitRadius;
      if (lastX !== null && x > lastX - minGap) x = lastX - minGap;
      out[planet.id] = x;
      lastX = x;
    });
    return out;
  }

  // Cargo freighter (one per planet, carries its deployed apps) and moons: always labeled.
  // Moons are decorative and swallow clicks with no further action; the freighter also
  // swallows clicks but toggles its manifest pin (see onCanvasClick). Both read
  // state.orbitClock (not the raw timestamp) so they freeze along with their host planet --
  // only real live terminal-tab ships (drawShips/drawOneShip, which still take a raw
  // timestamp) are exempt from freeze, per spec.
  function drawStaticDecor(ctx) {
    state.decorPositions = {};
    var aligned = isAligned();

    state.planets.forEach(function (planet) {
      var planetPos = state.screenPositions[planet.id];
      if (!planetPos) return;

      if (planet.freighter) {
        // the original call: the hull glyph is gone entirely (no glow, no sprite) -- only the
        // "Apps (N)" label survives, still riding the same orbital position so it keeps
        // moving the way the freighter used to. r starts as a small placeholder and gets
        // replaced with the label's own measured half-width in drawDecorLabels below, since
        // the hit-test area is now the label's bounds, not a hull silhouette.
        var freighter = planet.freighter;
        var fAngle = freighter.orbitPhase + state.orbitClock * freighter.orbitSpeed;
        var fx = planetPos.x + Math.cos(fAngle) * freighter.orbitRadius;
        var fy = planetPos.y + Math.sin(fAngle) * freighter.orbitRadius * 0.7;

        state.decorPositions["freighter:" + planet.id] = {
          x: fx, y: fy, r: 12, label: freighter.label, manifest: freighter.manifest,
          appStatus: freighter.appStatus, appsKnown: freighter.appsKnown, anyRunning: freighter.anyRunning,
          isLabelOnly: true, planetId: planet.id
        };
      }

      var moonCount = (planet.moonSprites || []).length;
      (planet.moonSprites || []).forEach(function (moon, idx) {
        // Aligned mode arranges moons on a small ring around the parent across the upper arc
        // (label pushed radially outward from each moon); normal orbit mode keeps the moon
        // circling its planet. planetPos already carries any drag override, so a dragged
        // planet takes its whole moon formation with it.
        var x, y, radial = null;
        if (aligned) {
          var ringR = planet._renderRadius + MOON_ALIGN_RING_GAP;
          var t = moonCount > 1 ? idx / (moonCount - 1) : 0.5;
          var theta = MOON_ALIGN_ARC_START + (MOON_ALIGN_ARC_END - MOON_ALIGN_ARC_START) * t;
          var cosT = Math.cos(theta), sinT = Math.sin(theta);
          x = planetPos.x + cosT * ringR;
          y = planetPos.y + sinT * ringR;
          radial = { x: cosT, y: sinT }; // outward unit direction, used to place the label clear of the planet
        } else {
          var angle = moon.orbitPhase + state.orbitClock * moon.orbitSpeed;
          x = planetPos.x + Math.cos(angle) * moon.orbitRadius;
          y = planetPos.y + Math.sin(angle) * moon.orbitRadius * 0.7;
        }

        // Same apparent-size/glow-tighten treatment as planets (see PLANET_MIN_APPARENT_R
        // note), just with a smaller floor/start pair since moons are already tiny bodies.
        var moonApparent = apparentBodyRender(moon.radius, MOON_MIN_APPARENT_R, MOON_GLOW_TIGHTEN_START);
        var key = moonApparent.r.toFixed(2) + "|" + MOON_COLOR + "|" +
          moonApparent.glowRatio.toFixed(2) + "|" + moonApparent.glowAlpha.toFixed(2) + "|" +
          moonApparent.rimAlpha.toFixed(2) + "|" + spriteScale();
        var sprite = state.moonSpriteCache[key];
        if (!sprite) {
          sprite = buildPlanetSprite(moonApparent.r, "", MOON_COLOR, moonApparent.glowRatio, moonApparent.glowAlpha, moonApparent.rimAlpha);
          state.moonSpriteCache[key] = sprite;
        }
        ctx.drawImage(sprite.canvas, x - sprite.half, y - sprite.half, sprite.size, sprite.size);

        state.decorPositions["moon:" + planet.id + ":" + idx] = { x: x, y: y, r: moonApparent.r + 6, label: moon.label, sshTarget: moon.sshTarget, radial: radial, planetId: planet.id };
      });
    });
  }

  // Permanent small labels for the freighter/moons, drawn in screen space like the other
  // world labels so they stay crisp at any zoom level.
  function drawDecorLabels(ctx) {
    var zoomForLabels = clamp(state.view.scale, LABEL_ZOOM_SCALE_MIN, LABEL_ZOOM_SCALE_MAX);
    var fontSize = Math.max(7, Math.round(9 * zoomForLabels));
    ctx.font = "500 " + fontSize + "px -apple-system, Segoe UI, sans-serif";
    // Normal-orbit-mode labels (freighter "Apps (N)" + non-aligned moons) already placed
    // this frame, checked so a later label can dodge an earlier one (moon-vs-moon /
    // freighter-vs-moon), on top of the parent-planet-name check below. Aligned mode
    // (d.radial branch) is untouched and does not feed or consult this list.
    var placedBoxes = [];
    Object.keys(state.decorPositions).forEach(function (id) {
      var d = state.decorPositions[id];
      var screen = worldToScreen(d.x, d.y);
      // Subtle lift (brightness only, same neutral hue -- no color noise) for a freighter
      // with at least one app confirmed running. Everything else -- moons, and freighters
      // with no live-status data or nothing running -- keeps the standard dim label.
      ctx.fillStyle = d.anyRunning ? "rgba(226, 236, 250, 0.8)" : "rgba(216, 224, 240, 0.55)";
      // Aligned moons: push the label radially outward from the moon (away from the planet)
      // so it never crosses the planet body or its neighbours. Alignment follows the outward
      // direction so the text extends away from the dot. Freighter "Apps (N)" labels sit just
      // below their point; normal-mode moons label below the dot.
      if (d.radial) {
        var gap = d.r * state.view.scale + 5;
        var lx = screen.x + d.radial.x * gap;
        var ly = screen.y + d.radial.y * gap;
        ctx.textAlign = d.radial.x > 0.25 ? "left" : (d.radial.x < -0.25 ? "right" : "center");
        ly += (d.radial.y < 0 ? -1 : 9); // lift the baseline for an upward label, drop it for a downward one
        ctx.fillText(d.label, lx, ly);
      } else {
        ctx.textAlign = "center";
        var labelY = d.isLabelOnly ? screen.y + 8 : screen.y + d.r * state.view.scale + 10;
        var labelWidth = ctx.measureText(d.label).width;
        // Drop straight down, clear of the parent planet's name and any sibling
        // freighter/moon label already placed this frame, before actually drawing. A
        // handful of small steps is enough: the orbit radius that causes the overlap is
        // small, so the box only needs to clear the bottom edge of whatever it collided
        // with, not travel far.
        var box = textLabelBox(screen.x, labelY, labelWidth, fontSize);
        var avoid = placedBoxes;
        if (d.planetId && state.planetLabelBoxes[d.planetId]) avoid = avoid.concat(state.planetLabelBoxes[d.planetId]);
        var guard = 0;
        while (guard < 24 && avoid.some(function (b) { return labelBoxesIntersect(box, b); })) {
          labelY += 4;
          box = textLabelBox(screen.x, labelY, labelWidth, fontSize);
          guard++;
        }
        placedBoxes.push(box);
        ctx.fillText(d.label, screen.x, labelY);
      }
      if (d.isLabelOnly) {
        // Hit-test area = the label's own rendered bounds, in world units so hitTestDecor's
        // plain world-space distance check still works unchanged.
        var halfWidth = ctx.measureText(d.label).width / 2;
        d.r = Math.max(6, halfWidth / state.view.scale);
      }
    });
  }

  function hitTestDecor(wx, wy) {
    var ids = Object.keys(state.decorPositions);
    for (var i = 0; i < ids.length; i++) {
      var pos = state.decorPositions[ids[i]];
      var dx = wx - pos.x;
      var dy = wy - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pos.r) {
        return ids[i];
      }
    }
    return null;
  }

  function hitTestSun(wx, wy) {
    var sun = state.sunPosition;
    if (!sun || !sun.r) return false;
    var hitR = sun.r + 24; // generous: corona reads bigger than the hit target needs to be
    var dx = wx - sun.x;
    var dy = wy - sun.y;
    return (dx * dx + dy * dy) <= (hitR * hitR);
  }

  // Faint full ellipse (always visible) plus a brighter ~50deg arc riding along the
  // planet's current position, built from short alpha-ramped slices so the orbit reads
  // as alive rather than a static guideline.
  function drawOrbitRing(ctx, cx, cy, orbitRadius, centerAngle) {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(120, 140, 180, 0.08)";
    ctx.ellipse(cx, cy, orbitRadius, orbitRadius * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();

    var segments = 16;
    var span = Math.PI * 0.28; // roughly 50 degrees total
    for (var i = 0; i < segments; i++) {
      var t0 = centerAngle - span / 2 + (i / segments) * span;
      var t1 = centerAngle - span / 2 + ((i + 1) / segments) * span;
      var alpha = 0.35 * Math.sin(Math.PI * ((i + 0.5) / segments));
      ctx.beginPath();
      ctx.strokeStyle = "rgba(180, 200, 230, " + alpha.toFixed(3) + ")";
      ctx.lineWidth = 1.5;
      ctx.moveTo(cx + Math.cos(t0) * orbitRadius, cy + Math.sin(t0) * orbitRadius * 0.55);
      ctx.lineTo(cx + Math.cos(t1) * orbitRadius, cy + Math.sin(t1) * orbitRadius * 0.55);
      ctx.stroke();
    }
  }

  // Shared by drawPlanets (planets) and drawStaticDecor (moons): computes the world-space
  // radius to actually build/draw a body's sprite at, plus the glow ratio/alpha to bake into
  // it, given the body's true (world) radius and the live view.scale. Above tightenStartR the
  // apparent size already looks fine (any real zoom-in), so this returns worldR and today's
  // glow constants completely unchanged -- the tightening only ever engages below that
  // threshold. r is quantized (only inside the tighten zone, see APPARENT_RADIUS_QUANT) so a
  // slow zoom doesn't rebuild the sprite cache every single frame.
  function apparentBodyRender(worldR, minApparentR, tightenStartR) {
    var viewScale = state.view.scale;
    var naturalScreenR = worldR * viewScale;
    if (naturalScreenR >= tightenStartR) {
      return { r: worldR, glowRatio: GLOW_RATIO_FAR, glowAlpha: GLOW_ALPHA_FAR, rimAlpha: RIM_ALPHA_FAR };
    }
    var t = clamp((tightenStartR - naturalScreenR) / (tightenStartR - minApparentR), 0, 1);
    var clampedScreenR = Math.max(naturalScreenR, minApparentR);
    clampedScreenR = Math.round(clampedScreenR / APPARENT_RADIUS_QUANT) * APPARENT_RADIUS_QUANT;
    return {
      r: clampedScreenR / viewScale,
      glowRatio: lerp(GLOW_RATIO_FAR, GLOW_RATIO_NEAR, t),
      glowAlpha: lerp(GLOW_ALPHA_FAR, GLOW_ALPHA_NEAR, t),
      rimAlpha: lerp(RIM_ALPHA_FAR, RIM_ALPHA_NEAR, t)
    };
  }

  // Shaded sphere sprite: outer status glow, a lit/base/dark-terminator radial gradient
  // (light baked in from LIGHT_ANGLE, rotated live at blit time to track the real sun
  // direction), a thin additive atmosphere rim, and a small specular highlight. Cached by
  // radius+status+color+glowRatio+glowAlpha+rimAlpha so it is built once per combination,
  // never per frame. glowRatio/glowAlpha/rimAlpha default to today's constants for any caller
  // that omits them.
  function buildPlanetSprite(radius, status, color, glowRatio, glowAlpha, rimAlpha) {
    if (glowRatio === undefined) glowRatio = GLOW_RATIO_FAR;
    if (glowAlpha === undefined) glowAlpha = GLOW_ALPHA_FAR;
    if (rimAlpha === undefined) rimAlpha = RIM_ALPHA_FAR;
    var glowR = radius * glowRatio;
    var half = glowR;
    var size = Math.ceil(half * 2);
    var dpr = spriteScale();
    var canvas = document.createElement("canvas");
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    var c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    var cx = half, cy = half;

    var baseColor = color;
    var lit = adjustLightness(color, 22);
    var dark = adjustLightness(color, -32);
    var glowColor = color;

    if (status === "offline") {
      baseColor = "#3a4258";
      lit = "#4c5570";
      dark = "#262c3d";
      glowColor = null;
    } else if (status === "asleep") {
      baseColor = "#9b6bdb";
      lit = adjustLightness(baseColor, 20);
      dark = adjustLightness(baseColor, -28);
      glowColor = "#9b6bdb";
    } else if (status === "unknown") {
      baseColor = "#e0b652";
      lit = adjustLightness(baseColor, 18);
      dark = adjustLightness(baseColor, -26);
      glowColor = "#e0b652";
    }

    if (glowColor) {
      var glow = c.createRadialGradient(cx, cy, radius * 0.7, cx, cy, glowR);
      glow.addColorStop(0, hexToRgba(glowColor, glowAlpha));
      glow.addColorStop(1, hexToRgba(glowColor, 0));
      c.fillStyle = glow;
      c.beginPath();
      c.arc(cx, cy, glowR, 0, Math.PI * 2);
      c.fill();
    }

    var lightOffsetX = Math.cos(LIGHT_ANGLE) * radius * 0.3;
    var lightOffsetY = Math.sin(LIGHT_ANGLE) * radius * 0.3;

    var sphere = c.createRadialGradient(
      cx + lightOffsetX, cy + lightOffsetY, radius * 0.1,
      cx, cy, radius
    );
    sphere.addColorStop(0, lit);
    sphere.addColorStop(0.55, baseColor);
    sphere.addColorStop(1, dark);
    c.beginPath();
    c.fillStyle = sphere;
    c.arc(cx, cy, radius, 0, Math.PI * 2);
    c.fill();

    c.save();
    c.globalCompositeOperation = "lighter";
    c.beginPath();
    c.strokeStyle = hexToRgba(color, rimAlpha);
    c.lineWidth = Math.max(1, radius * 0.12);
    c.arc(cx, cy, radius + 1, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    var specX = cx + Math.cos(LIGHT_ANGLE) * radius * 0.55;
    var specY = cy + Math.sin(LIGHT_ANGLE) * radius * 0.55;
    var specR = Math.max(1.2, radius * 0.16);
    c.save();
    c.globalCompositeOperation = "lighter";
    var spec = c.createRadialGradient(specX, specY, 0, specX, specY, specR);
    spec.addColorStop(0, "rgba(255, 255, 255, 0.45)");
    spec.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = spec;
    c.beginPath();
    c.arc(specX, specY, specR, 0, Math.PI * 2);
    c.fill();
    c.restore();

    return { canvas: canvas, half: half, size: size };
  }

  function drawPlanetBody(ctx, planet, x, y, timestamp) {
    // _renderRadius/_glowRatio/_glowAlpha/_rimAlpha are computed once per frame in drawPlanets
    // (they depend on the live view.scale, via apparentBodyRender) and reused here so the
    // disc, the hit-test radius (screenPositions), and the label offset all agree on the exact
    // same apparent size -- see the full-view legibility fix note near PLANET_MIN_APPARENT_R.
    var r = planet._renderRadius;
    var status = planet.status || "unknown";
    var hovered = (planet.id === state.hoveredPlanetId);

    var spriteKey = Math.round(r * 10) + "|" + status + "|" + planet.color + "|" +
      planet._glowRatio.toFixed(2) + "|" + planet._glowAlpha.toFixed(2) + "|" + planet._rimAlpha.toFixed(2) + "|" + spriteScale();
    var sprite = state.planetSpriteCache[spriteKey];
    if (!sprite) {
      sprite = buildPlanetSprite(r, status, planet.color, planet._glowRatio, planet._glowAlpha, planet._rimAlpha);
      state.planetSpriteCache[spriteKey] = sprite;
    }

    // Rotate the pre-baked sphere so its lit side always faces the sun's live position,
    // without rebuilding the sprite -- this is what keeps the cache key small.
    var sun = state.sunPosition;
    var liveAngle = Math.atan2(sun.y - y, sun.x - x);
    var rotation = liveAngle - LIGHT_ANGLE;

    // asleep/unknown keep their live pulse as a blit-time alpha instead of invalidating
    // the sprite cache every frame.
    var alphaMul = 1;
    if (status === "asleep") {
      alphaMul = 0.55 + 0.25 * (0.5 + 0.5 * Math.sin(timestamp * 0.0009 + hashStringToUnit(planet.id) * 10));
    } else if (status === "unknown") {
      alphaMul = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(timestamp * 0.003 + hashStringToUnit(planet.id) * 10));
    }

    ctx.save();
    ctx.globalAlpha = alphaMul;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half, sprite.size, sprite.size);
    ctx.restore();

    if (hovered) {
      drawTargetingRing(ctx, x, y, r, timestamp, { color: "#d8e0f0" });
    }

    if (planet.id === state.pulsePlanetId) {
      var elapsed = timestamp - state.pulseStartTime;
      if (elapsed >= 0 && elapsed < PULSE_DURATION_MS) {
        var t = elapsed / PULSE_DURATION_MS;
        drawTargetingRing(ctx, x, y, r, timestamp, { color: "#d8e0f0", burstT: t });
      }
    }
    // Planet name label is drawn later in drawWorldLabels(), in screen space, so its
    // size can be zoom-clamped instead of scaling 1:1 with the view transform.
  }

  // Reusable two-layer targeting indicator (soft halo + animated dashed ring), used both
  // as a steady hover highlight and as the transient tree-click selection burst (via
  // opts.burstT, 0..1) -- one shared implementation for planets and ships alike.
  function drawTargetingRing(ctx, x, y, baseR, timestamp, opts) {
    opts = opts || {};
    var color = opts.color || "#d8e0f0";
    var r = baseR;
    var haloAlpha = 0.2;
    var ringAlpha = 0.7;

    if (opts.burstT !== undefined) {
      r = baseR + 6 + opts.burstT * 20;
      haloAlpha = 0.24 * (1 - opts.burstT);
      ringAlpha = 0.8 * (1 - opts.burstT);
    }

    ctx.save();

    var haloR = r + 14;
    var halo = ctx.createRadialGradient(x, y, Math.max(0, r * 0.6), x, y, haloR);
    halo.addColorStop(0, hexToRgba(color, haloAlpha));
    halo.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -(timestamp * 0.02) % 10;
    ctx.strokeStyle = hexToRgba(color, ringAlpha);
    ctx.lineWidth = 1.5;
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  // All map text (sun label, planet names), drawn outside the view-transformed block in
  // plain screen space via worldToScreen(). Font size follows zoom but is clamped so text
  // never becomes unreadably tiny or absurdly huge at the extremes (0.5x-4x).
  function drawWorldLabels(ctx) {
    var fit = state.layoutScale || 1;
    var zoomForLabels = clamp(state.view.scale, LABEL_ZOOM_SCALE_MIN, LABEL_ZOOM_SCALE_MAX);

    var sunScreen = worldToScreen(state.sunPosition.x, state.sunPosition.y);
    var sunScreenR = state.sunPosition.r * state.view.scale;
    var sunFontSize = Math.max(10, Math.round(13 * fit * zoomForLabels));
    ctx.font = "600 " + sunFontSize + "px -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "rgba(216, 224, 240, 0.85)";
    ctx.textAlign = "center";
    ctx.fillText(state.config.sunName || "Workspace", sunScreen.x, sunScreen.y + sunScreenR + 22 * fit);

    var planetFontSize = Math.max(9, Math.round(12 * fit * zoomForLabels));
    ctx.font = "500 " + planetFontSize + "px -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "rgba(216, 224, 240, 0.8)";
    ctx.textAlign = "center";
    // Bounding box per planet label, refreshed every frame and consumed by
    // drawDecorLabels() (drawn right after this) so moon/freighter labels can detect and
    // dodge an overlap with their parent's name.
    state.planetLabelBoxes = {};
    state.planets.forEach(function (planet) {
      var pos = state.screenPositions[planet.id];
      if (!pos) return;
      var screen = worldToScreen(pos.x, pos.y);
      var screenR = planet._renderRadius * state.view.scale;
      var labelY = screen.y + screenR + 16 * fit;
      ctx.fillText(planet.name, screen.x, labelY);
      state.planetLabelBoxes[planet.id] = textLabelBox(screen.x, labelY, ctx.measureText(planet.name).width, planetFontSize);
    });
  }

  // One ship per open drawer tab, orbiting its anchor planet's current screen position.
  // Runs after drawPlanets in the same frame so state.screenPositions is fresh. Ships take
  // hit-test priority over the planet beneath them (see hitTestShip / onCanvasClick).
  function drawShips(ctx, timestamp) {
    state.shipPositions = {};

    state.terminalTabs.forEach(function (tab) {
      if (!tab.ship) return; // the sun's memory-doc tab has no ship, per spec
      drawOneShip(ctx, tab.ship, timestamp, 1, tab.id);
    });

    // Departing ships: tab already closed, but the sprite fades out in place rather
    // than vanishing instantly.
    state.closingShips = state.closingShips.filter(function (entry) {
      var elapsed = timestamp - entry.closingSince;
      if (elapsed > SHIP_DEPART_MS) return false;
      var alpha = 1 - (elapsed / SHIP_DEPART_MS);
      drawOneShip(ctx, entry.ship, timestamp, alpha, null);
      return true;
    });
  }

  // Small pre-rendered glow blob per ship color, replacing shadowBlur with a cached
  // radial-gradient sprite (cross-cutting requirement: no shadowBlur anywhere).
  function buildShipGlowSprite(color) {
    var r = SHIP_SIZE * 2.6;
    var size = Math.ceil(r * 2);
    var dpr = spriteScale();
    var canvas = document.createElement("canvas");
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    var c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    var grad = c.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, hexToRgba(color, 0.5));
    grad.addColorStop(1, hexToRgba(color, 0));
    c.fillStyle = grad;
    c.beginPath();
    c.arc(r, r, r, 0, Math.PI * 2);
    c.fill();
    return { canvas: canvas, half: r, size: size };
  }

  // tabIdForHit is null for departing ships: they no longer accept clicks/hover.
  function drawOneShip(ctx, ship, timestamp, alpha, tabIdForHit) {
    var planetPos = state.screenPositions[ship.planetId];
    if (!planetPos) return;

    var angle = ship.orbitPhase + timestamp * ship.orbitSpeed;
    var bob = Math.sin(timestamp * 0.002 + ship.bobPhase) * 3;
    var x = planetPos.x + Math.cos(angle) * ship.orbitRadius;
    var y = planetPos.y + Math.sin(angle) * ship.orbitRadius * 0.7 + bob;

    var spawnElapsed = timestamp - ship.spawnTime;
    var spawnAlpha = spawnElapsed < SHIP_SPAWN_MS ? Math.max(0, spawnElapsed / SHIP_SPAWN_MS) : 1;
    var totalAlpha = alpha * spawnAlpha;

    if (!ship.trail) ship.trail = [];
    ship.trail.push({ x: x, y: y });
    if (ship.trail.length > SHIP_TRAIL_MAX) ship.trail.shift();

    // Trail, then glow, then glyph -- each layer painted before the next so the glyph
    // always reads crisply on top.
    drawShipTrail(ctx, ship.trail, ship.color, totalAlpha);

    var glowKey = ship.color + "|" + spriteScale();
    var glow = state.shipGlowCache[glowKey];
    if (!glow) {
      glow = buildShipGlowSprite(ship.color);
      state.shipGlowCache[glowKey] = glow;
    }
    ctx.save();
    ctx.globalAlpha = totalAlpha;
    ctx.drawImage(glow.canvas, x - glow.half, y - glow.half, glow.size, glow.size);
    ctx.restore();

    drawShipGlyph(ctx, ship, x, y, angle, totalAlpha);

    if (tabIdForHit) {
      state.shipPositions[tabIdForHit] = { x: x, y: y, r: SHIP_HIT_RADIUS };
      if (tabIdForHit === state.hoveredShipTabId) {
        drawTargetingRing(ctx, x, y, SHIP_HIT_RADIUS * 0.75, timestamp, { color: ship.color });
      }
    }
  }

  // Ring buffer of the ship's last few positions, stroked as short segments that taper
  // width and alpha toward the tail, so the ship reads as moving rather than teleporting.
  function drawShipTrail(ctx, trail, color, alphaMul) {
    var len = trail.length;
    if (len < 2) return;
    for (var i = 1; i < len; i++) {
      var frac = i / (len - 1);
      var width = 0.3 + frac * 1.7;
      var segAlpha = frac * 0.5 * alphaMul;
      ctx.beginPath();
      ctx.strokeStyle = hexToRgba(color, segAlpha);
      ctx.lineWidth = width;
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
  }

  function drawShipGlyph(ctx, ship, x, y, angle, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.fillStyle = ship.color;

    if (ship.type === "desktop") {
      // rounded pod / saucer, no directional facing
      ctx.beginPath();
      ctx.ellipse(0, 1, SHIP_SIZE * 0.95, SHIP_SIZE * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -0.5, SHIP_SIZE * 0.45, Math.PI, 0);
      ctx.fill();
    } else {
      // small pointed ship, oriented along its direction of travel around the orbit
      var travelAngle = angle + (ship.orbitSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2);
      ctx.rotate(travelAngle);
      ctx.beginPath();
      ctx.moveTo(SHIP_SIZE, 0);
      ctx.lineTo(-SHIP_SIZE * 0.6, SHIP_SIZE * 0.55);
      ctx.lineTo(-SHIP_SIZE * 0.25, 0);
      ctx.lineTo(-SHIP_SIZE * 0.6, -SHIP_SIZE * 0.55);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  // Shared source of truth for hull sizing: segment count (clamped app count), overall
  // length (scales gently with segment count), half-width, and the bounding radius used
  // both to size the cached sprite canvas and to set the click hit-test circle -- so the
  // drawn hull and the clickable area are always the same hull.
  function freighterHullMetrics(appCount) {
    var segCount = clamp(appCount, FREIGHTER_SEG_MIN, FREIGHTER_SEG_MAX);
    var t = (segCount - FREIGHTER_SEG_MIN) / (FREIGHTER_SEG_MAX - FREIGHTER_SEG_MIN);
    var lenScale = FREIGHTER_LEN_SCALE_MIN + t * (FREIGHTER_LEN_SCALE_MAX - FREIGHTER_LEN_SCALE_MIN);
    var len = FREIGHTER_LENGTH * lenScale;
    var halfW = FREIGHTER_WIDTH / 2;
    var towerH = halfW * 2.4;   // bridge tower rises above the hull deck
    var finH = halfW * 0.9;     // keel fins drop below the hull
    var boundHalf = Math.ceil(Math.max(len / 2 + 3, halfW + towerH + 3));
    return {
      segCount: segCount, len: len, halfW: halfW, towerH: towerH, finH: finH,
      boundHalf: boundHalf, hitRadius: Math.round(boundHalf * 0.8)
    };
  }

  // Bakes the full capital-freighter side profile into an offscreen canvas once per
  // (segment count, running-states signature, hull color) combination, the same
  // cached-sprite technique buildPlanetSprite/buildShipGlowSprite use above. The hull is
  // baked nose-forward along local +x; drawFreighterGlyph just translates, rotates to the
  // live travel angle, and blits it -- no per-frame path building.
  function buildFreighterSprite(metrics, appStatus, hullColor) {
    var len = metrics.len, halfW = metrics.halfW, towerH = metrics.towerH,
        finH = metrics.finH, half = metrics.boundHalf, segCount = metrics.segCount;
    var size = half * 2;
    var dpr = spriteScale();
    var canvas = document.createElement("canvas");
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    var c = canvas.getContext("2d");
    c.scale(dpr, dpr);
    c.translate(half, half);

    var noseLen = len * 0.24;
    var sternLen = len * 0.14;
    var segZoneStart = -len / 2 + sternLen;
    var segZoneEnd = len / 2 - noseLen;
    var segZoneLen = segZoneEnd - segZoneStart;
    var segW = segZoneLen / segCount;

    var darkHull = adjustLightness(hullColor, -18);
    var warmLit = blendHexColors(hullColor, "#ffd27a", 0.75);

    // Main hull silhouette: stern bevel, full-height deck across the cargo segments, a
    // curved taper down to a point at the prow (direction of travel), mirrored on the
    // underside back to the stern.
    c.beginPath();
    c.moveTo(-len / 2, -halfW * 0.7);
    c.lineTo(segZoneStart, -halfW);
    c.lineTo(segZoneEnd, -halfW);
    c.quadraticCurveTo(segZoneEnd + noseLen * 0.55, -halfW * 0.35, len / 2, 0);
    c.quadraticCurveTo(segZoneEnd + noseLen * 0.55, halfW * 0.35, segZoneEnd, halfW);
    c.lineTo(segZoneStart, halfW);
    c.lineTo(-len / 2, halfW * 0.7);
    c.closePath();
    c.fillStyle = hullColor;
    c.fill();
    c.strokeStyle = "rgba(6, 10, 20, 0.35)";
    c.lineWidth = 1;
    c.stroke();

    // Centerline seam so the deck reads as plating, not a flat silhouette.
    c.beginPath();
    c.strokeStyle = "rgba(6, 10, 20, 0.25)";
    c.moveTo(segZoneStart, 0);
    c.lineTo(len / 2 - 1, 0);
    c.stroke();

    // Cargo segments: the silhouette IS the live manifest. One rect per app, in manifest
    // order, lit warm (planet-tinted) when that app is running, dark hull plating otherwise.
    // No invented in-between state -- running is either true, or it reads as dark.
    var segPad = segW * 0.12;
    for (var i = 0; i < segCount; i++) {
      var sx = segZoneStart + i * segW + segPad;
      var sw = segW - segPad * 2;
      if (i > 0) {
        c.beginPath();
        c.strokeStyle = "rgba(6, 10, 20, 0.3)";
        c.moveTo(segZoneStart + i * segW, -halfW * 0.9);
        c.lineTo(segZoneStart + i * segW, halfW * 0.9);
        c.stroke();
      }
      var app = appStatus[i];
      var running = !!(app && app.running === true);
      if (running) {
        var glowGrad = c.createLinearGradient(sx, -halfW * 0.55, sx, halfW * 0.55);
        glowGrad.addColorStop(0, hexToRgba(warmLit, 0.9));
        glowGrad.addColorStop(1, hexToRgba(warmLit, 0.55));
        c.fillStyle = glowGrad;
        c.fillRect(sx, -halfW * 0.5, sw, halfW);
        c.save();
        c.globalCompositeOperation = "lighter";
        c.fillStyle = hexToRgba(warmLit, 0.35);
        c.fillRect(sx - 1, -halfW * 0.6, sw + 2, halfW * 1.2);
        c.restore();
      } else {
        c.fillStyle = darkHull;
        c.fillRect(sx, -halfW * 0.45, sw, halfW * 0.9);
      }
    }

    // Raised stern bridge tower: a two-tier block sitting above the hull at the stern end.
    var towerBaseW = sternLen * 0.85;
    var towerX0 = -len / 2 + sternLen * 0.08;
    c.fillStyle = darkHull;
    c.fillRect(towerX0, -halfW - towerH * 0.55, towerBaseW, towerH * 0.55);
    var towerTopW = towerBaseW * 0.6;
    var towerTopX0 = towerX0 + (towerBaseW - towerTopW) / 2;
    c.fillStyle = adjustLightness(hullColor, -8);
    c.fillRect(towerTopX0, -halfW - towerH, towerTopW, towerH * 0.45);

    // Subtle ventral keel fin near the stern.
    c.fillStyle = darkHull;
    var finX0 = segZoneStart + segZoneLen * 0.15;
    c.beginPath();
    c.moveTo(finX0, halfW);
    c.lineTo(finX0 + sternLen * 0.9, halfW);
    c.lineTo(finX0 + sternLen * 0.4, halfW + finH);
    c.closePath();
    c.fill();

    return { canvas: canvas, half: half, size: size, len: len, halfW: halfW };
  }

  // Cargo freighter: a capital-hauler side profile, a visually distinct silhouette from
  // the small pointed ships (drawShipGlyph above), oriented along its direction of travel
  // around the orbit the same way a live ship is. Drawn as a cached sprite (see
  // buildFreighterSprite) keyed on segment count + which segments are lit + hull color, so
  // it relights automatically when the 30s status poll changes appStatus.
  function drawFreighterGlyph(ctx, x, y, angle, orbitSpeed, freighter) {
    // Screenshot-verified: with the base +/-90-degree travel-angle formula (the same one
    // drawShipGlyph above uses, where its nose is drawn nose-forward at local +x just like
    // this hull's tapered prow), the freighter's tapered prow trailed and the blunt stern
    // tower led -- backwards. Adding PI flips the hull 180 degrees so the prow leads.
    var travelAngle = angle + (orbitSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2) + Math.PI;
    var metrics = freighterHullMetrics(freighter.manifest.length);
    var runningSig = "";
    for (var i = 0; i < metrics.segCount; i++) {
      var app = freighter.appStatus[i];
      runningSig += (app && app.running === true) ? "1" : "0";
    }
    var spriteKey = metrics.segCount + "|" + runningSig + "|" + freighter.hullColor + "|" + spriteScale();
    var sprite = state.freighterSpriteCache[spriteKey];
    if (!sprite) {
      sprite = buildFreighterSprite(metrics, freighter.appStatus, freighter.hullColor);
      state.freighterSpriteCache[spriteKey] = sprite;
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(travelAngle);
    ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half, sprite.size, sprite.size);
    ctx.restore();
  }

  // wx/wy are WORLD coordinates (pre-view-transform). Callers convert screen -> world
  // once via screenToWorld() and pass the result in here; see onCanvasClick etc. below.
  function hitTestShip(wx, wy) {
    var ids = Object.keys(state.shipPositions);
    for (var i = 0; i < ids.length; i++) {
      var pos = state.shipPositions[ids[i]];
      var dx = wx - pos.x;
      var dy = wy - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pos.r) {
        return ids[i]; // tabId
      }
    }
    return null;
  }

  function hitTestPlanet(wx, wy) {
    for (var i = 0; i < state.planets.length; i++) {
      var planet = state.planets[i];
      var pos = state.screenPositions[planet.id];
      if (!pos) continue;
      var dx = wx - pos.x;
      var dy = wy - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pos.r) {
        return planet;
      }
    }
    return null;
  }

  function canvasEventCoords(evt) {
    var rect = state.canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function onCanvasClick(evt) {
    if (state.suppressNextClick) {
      // A real pan just finished; the browser still fires a click on mouseup, but it
      // must not also select whatever planet/ship happens to be under the cursor now.
      state.suppressNextClick = false;
      return;
    }

    var coords = canvasEventCoords(evt);
    var world = screenToWorld(coords.x, coords.y);

    // Ships take hit priority: clicking a ship activates its tab and must NOT also
    // trigger the planet click underneath it. Selecting the ship's planet first means
    // the tab filter (if active) is already showing this ship's planet by the time the
    // tab itself is activated, so the click lands exactly on that ship's terminal.
    var shipTabId = hitTestShip(world.x, world.y);
    if (shipTabId) {
      closeManifestPin(); // clicking a ship elsewhere on the map closes any pinned manifest
      var shipTab = findTabById(shipTabId);
      if (shipTab) selectPlanet(shipTab.planetId, "map");
      activateTab(shipTabId);
      expandDrawer();
      return;
    }

    // Freighters swallow the click and toggle their pinned manifest open/closed. Moons
    // swallow the click too (same priority reasoning as ships above) but have no tab or
    // pin behavior -- they're decorative only, so clicking one just closes any open pin.
    var decorHit = hitTestDecor(world.x, world.y);
    if (decorHit) {
      if (isFreighterDecorId(decorHit)) {
        toggleManifestPinAt(decorHit, evt.clientX, evt.clientY);
      } else {
        closeManifestPin();
      }
      return;
    }

    closeManifestPin(); // click-away on sun/planet/empty space closes any pinned manifest

    if (hitTestSun(world.x, world.y)) {
      openSunDocTab();
      return;
    }

    var hit = hitTestPlanet(world.x, world.y);
    if (hit) selectPlanet(hit.id, "map");
  }

  function onCanvasDblClick(evt) {
    var coords = canvasEventCoords(evt);
    var world = screenToWorld(coords.x, coords.y);
    // Only resets on empty space; double-clicking a planet/ship keeps its normal meaning.
    if (hitTestShip(world.x, world.y) || hitTestDecor(world.x, world.y) || hitTestSun(world.x, world.y) || hitTestPlanet(world.x, world.y)) return;
    resetView();
  }

  function onCanvasWheel(evt) {
    evt.preventDefault();
    var coords = canvasEventCoords(evt);
    var worldUnderCursor = screenToWorld(coords.x, coords.y);
    var factor = evt.deltaY < 0 ? ZOOM_STEP : (1 / ZOOM_STEP);
    var newScale = clamp(state.view.scale * factor, MIN_ZOOM, MAX_ZOOM);
    // Re-derive the offset so the world point under the cursor stays under the cursor.
    state.view.offsetX = coords.x - worldUnderCursor.x * newScale;
    state.view.offsetY = coords.y - worldUnderCursor.y * newScale;
    state.view.scale = newScale;
  }

  function onCanvasMouseDown(evt) {
    var coords = canvasEventCoords(evt);
    var world = screenToWorld(coords.x, coords.y);

    // While frozen/aligned, a mousedown on a planet arms a drag instead of a pan. It only
    // becomes a real drag past DRAG_THRESHOLD_PX -- a plain click below that still falls
    // through to onCanvasClick's select/filter behaviour (suppressNextClick stays false).
    if (state.frozen) {
      var dragHit = hitTestPlanet(world.x, world.y);
      if (dragHit) {
        var pos = state.screenPositions[dragHit.id];
        state.planetDragArmed = true;
        state.isDraggingPlanet = false;
        state.dragPlanetId = dragHit.id;
        state.dragStartScreen = { x: coords.x, y: coords.y };
        state.dragStartWorld = { x: pos.x, y: pos.y };
        window.addEventListener("mousemove", onWindowMouseMoveForDrag);
        window.addEventListener("mouseup", onWindowMouseUpForDrag);
        return;
      }
    }

    // Never arm a pan over an interactive target -- planet/ship clicks work as before.
    if (hitTestShip(world.x, world.y) || hitTestDecor(world.x, world.y) || hitTestSun(world.x, world.y) || hitTestPlanet(world.x, world.y)) return;
    // Panning only matters once zoomed in; at the default fitted view there is nowhere to pan to.
    if (state.view.scale <= 1.001) return;

    state.panArmed = true;
    state.isPanning = false;
    state.panStartScreen = { x: coords.x, y: coords.y };
    state.panStartOffset = { x: state.view.offsetX, y: state.view.offsetY };

    window.addEventListener("mousemove", onWindowMouseMoveForPan);
    window.addEventListener("mouseup", onWindowMouseUpForPan);
  }

  // Tracked on window (not just the canvas) so a fast drag that briefly leaves the
  // canvas bounds doesn't get stuck mid-pan.
  function onWindowMouseMoveForPan(evt) {
    if (!state.panArmed) return;
    var coords = canvasEventCoords(evt);
    var dx = coords.x - state.panStartScreen.x;
    var dy = coords.y - state.panStartScreen.y;

    if (!state.isPanning && (Math.abs(dx) > PAN_THRESHOLD_PX || Math.abs(dy) > PAN_THRESHOLD_PX)) {
      state.isPanning = true;
      state.canvas.style.cursor = "grabbing";
      state.hoveredShipTabId = null;
      state.hoveredPlanetId = null;
      hideShipTooltip();
    }

    if (state.isPanning) {
      state.view.offsetX = state.panStartOffset.x + dx;
      state.view.offsetY = state.panStartOffset.y + dy;
    }
  }

  function onWindowMouseUpForPan() {
    window.removeEventListener("mousemove", onWindowMouseMoveForPan);
    window.removeEventListener("mouseup", onWindowMouseUpForPan);
    if (state.isPanning) {
      state.suppressNextClick = true;
    }
    state.panArmed = false;
    state.isPanning = false;
    state.canvas.style.cursor = "default";
  }

  // Planet drag (frozen only): screen-space movement converted to a world delta (divide by
  // view.scale, since offset is constant mid-drag) and written into the per-planet override
  // map. Moons, labels, ships and the Apps label anchor off screenPositions[id], so they all
  // follow live from the next frame with no extra bookkeeping here.
  function onWindowMouseMoveForDrag(evt) {
    if (!state.planetDragArmed) return;
    var coords = canvasEventCoords(evt);
    var dx = coords.x - state.dragStartScreen.x;
    var dy = coords.y - state.dragStartScreen.y;

    if (!state.isDraggingPlanet && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
      state.isDraggingPlanet = true;
      state.canvas.style.cursor = "grabbing";
      state.hoveredShipTabId = null;
      state.hoveredPlanetId = null;
      hideShipTooltip();
    }

    if (state.isDraggingPlanet) {
      state.dragOverrides[state.dragPlanetId] = {
        x: state.dragStartWorld.x + dx / state.view.scale,
        y: state.dragStartWorld.y + dy / state.view.scale
      };
    }
  }

  function onWindowMouseUpForDrag() {
    window.removeEventListener("mousemove", onWindowMouseMoveForDrag);
    window.removeEventListener("mouseup", onWindowMouseUpForDrag);
    if (state.isDraggingPlanet) {
      state.suppressNextClick = true;  // a real drag must not also select/filter the planet
      persistFrozenArrangement();      // remember the new spot so a reload while frozen restores it
    }
    state.planetDragArmed = false;
    state.isDraggingPlanet = false;
    state.dragPlanetId = null;
    // Cursor returns to grab while still hovering the planet under a frozen map.
    state.canvas.style.cursor = state.frozen ? "grab" : "default";
  }

  function onCanvasMouseMove(evt) {
    if (state.isPanning) return; // the window-level drag listener owns movement during a pan
    if (state.isDraggingPlanet) return; // the window-level planet-drag listener owns the cursor here

    var coords = canvasEventCoords(evt);
    var world = screenToWorld(coords.x, coords.y);

    var shipTabId = hitTestShip(world.x, world.y);
    if (shipTabId) {
      state.hoveredShipTabId = shipTabId;
      state.hoveredPlanetId = null;
      state.canvas.style.cursor = "pointer";
      showShipTooltip(shipTabId, evt.clientX, evt.clientY);
      return;
    }

    if (state.hoveredShipTabId) {
      state.hoveredShipTabId = null;
      hideShipTooltip();
    }

    var decorHit = hitTestDecor(world.x, world.y);
    if (decorHit) {
      state.hoveredPlanetId = null;
      state.canvas.style.cursor = "default";
      showDecorTooltip(decorHit, evt.clientX, evt.clientY);
      return;
    }
    hideShipTooltip();

    if (hitTestSun(world.x, world.y)) {
      state.hoveredPlanetId = null;
      state.canvas.style.cursor = "pointer";
      return;
    }

    var hit = hitTestPlanet(world.x, world.y);
    var hitId = hit ? hit.id : null;
    state.hoveredPlanetId = hitId;
    if (hitId) {
      // Frozen planets are draggable, so they read as grabbable rather than clickable.
      state.canvas.style.cursor = state.frozen ? "grab" : "pointer";
    } else {
      state.canvas.style.cursor = (state.view.scale > 1.001) ? "grab" : "default";
    }
  }

  function onCanvasMouseLeave() {
    if (state.isPanning) return; // let the drag keep going via the window-level listeners
    state.hoveredPlanetId = null;
    state.hoveredShipTabId = null;
    hideShipTooltip();
    state.canvas.style.cursor = "default";
  }

  function findTabById(tabId) {
    return state.terminalTabs.filter(function (t) { return t.id === tabId; })[0] || null;
  }

  // A base row (or Travel/Deploy) can be clicked again while a tab for that exact
  // (planet, session) pair is already open. tmux mirrors its window size across every
  // attached client, so two differently-sized tabs on the same session fight each other
  // over the terminal dimensions, on top of just being duplicate clutter. Used to focus the
  // existing tab instead of opening a second connection to the same session.
  function findTerminalTab(planetId, session) {
    return state.terminalTabs.filter(function (t) {
      return t.planetId === planetId && t.session === session;
    })[0] || null;
  }

  // Raw tooltip primitives -- the only code allowed to touch els.shipTooltip directly.
  // Everything else goes through the hover-safe wrappers below, or through pinManifest/
  // closeManifestPin for the pinned-open freighter manifest.
  function renderTooltipAt(text, clientX, clientY) {
    els.shipTooltip.textContent = text;
    els.shipTooltip.classList.toggle("multiline", text.indexOf("\n") !== -1);
    els.shipTooltip.style.left = (clientX + 14) + "px";
    els.shipTooltip.style.top = (clientY + 14) + "px";
    els.shipTooltip.classList.remove("hidden");
  }

  function renderTooltipHide() {
    els.shipTooltip.classList.add("hidden");
  }

  // Hover-driven display: a no-op while a freighter manifest is pinned open, so moving the
  // mouse elsewhere on the map can never steal or hide the pinned tooltip.
  function showTooltipText(text, clientX, clientY) {
    if (state.pinnedDecorId) return;
    renderTooltipAt(text, clientX, clientY);
  }

  function showShipTooltip(tabId, clientX, clientY) {
    var tab = findTabById(tabId);
    if (!tab || !tab.ship) {
      hideShipTooltip();
      return;
    }
    showTooltipText(tab.ship.label, clientX, clientY);
  }

  // The tooltip is plain textContent (no HTML/CSS reach in there -- see renderTooltipAt),
  // so a literal colored dot isn't possible; these bracket markers are the ASCII-safe
  // stand-in for bright-green/dim-gray/hollow-"?" the live-status contract asks for.
  // Running true -> "(*)" (filled/bright), false -> "( )" (empty/dim), null/unknown -> "(?)".
  // When appsKnown is false (planet.apps hasn't landed for this planet yet), no markers are
  // added at all -- output is byte-for-byte the old plain name list.
  function manifestStatusMark(running) {
    if (running === true) return "(*) ";
    if (running === false) return "( ) ";
    return "(?) ";
  }

  function manifestText(d) {
    var lines = (d.appStatus || []).map(function (entry) {
      if (!d.appsKnown) return entry.name;
      return manifestStatusMark(entry.running) + entry.name;
    });
    return ["Cargo"].concat(lines).join("\n");
  }

  // Static freighter/moons share the same tooltip element; decorHit is a decorPositions
  // key, its stored label/manifest is looked up fresh each time in case a planet was
  // renamed. A freighter (has a manifest) shows the app list; a moon shows its label, plus
  // its ssh target ("name - target") once the moon has one set via the Add moon control.
  function showDecorTooltip(decorId, clientX, clientY) {
    var d = state.decorPositions[decorId];
    if (!d) {
      hideShipTooltip();
      return;
    }
    var text = d.manifest ? manifestText(d) : (d.sshTarget ? (d.label + " - " + d.sshTarget) : d.label);
    showTooltipText(text, clientX, clientY);
  }

  function hideShipTooltip() {
    if (state.pinnedDecorId) return;
    renderTooltipHide();
  }

  function isFreighterDecorId(decorId) {
    return decorId.indexOf("freighter:") === 0;
  }

  // Click on a freighter: pin its manifest tooltip open (bypassing the hover guard above)
  // until the next click elsewhere or Escape. Clicking the same pinned freighter again
  // unpins it.
  function toggleManifestPinAt(decorId, clientX, clientY) {
    if (state.pinnedDecorId === decorId) {
      closeManifestPin();
      return;
    }
    var d = state.decorPositions[decorId];
    if (!d) return;
    state.pinnedDecorId = decorId;
    renderTooltipAt(manifestText(d), clientX, clientY);
  }

  function closeManifestPin() {
    if (!state.pinnedDecorId) return;
    state.pinnedDecorId = null;
    renderTooltipHide();
  }

  /* ======================================================================
   * TREE (left sidebar: planet list + in-place accordion detail, replaces
   * the old right slide-in panel entirely -- single source of truth)
   * ==================================================================== */

  function findPlanet(planetId) {
    for (var i = 0; i < state.planets.length; i++) {
      if (state.planets[i].id === planetId) return state.planets[i];
    }
    return null;
  }

  // Archived planets aren't in state.planets (excluded from the map/active tree on
  // purpose), so anything working with the archived section looks them up here instead.
  function findAnyPlanet(planetId) {
    for (var i = 0; i < state.allPlanets.length; i++) {
      if (state.allPlanets[i].id === planetId) return state.allPlanets[i];
    }
    return null;
  }

  // Single funnel for every planets-list mutation (initial load, rename, pin, archive,
  // create): splits into active/archived, sorts (pinned first then alpha; archived alpha),
  // and re-derives everything that depends on the list. Nothing else should assign
  // state.planets directly.
  function splitAndSortPlanets(all) {
    var active = [];
    var archived = [];
    all.forEach(function (p) {
      if (p.archived) archived.push(p); else active.push(p);
    });
    active.sort(function (a, b) {
      var ap = !!a.pinned, bp = !!b.pinned;
      if (ap !== bp) return ap ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    archived.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return { active: active, archived: archived };
  }

  function applyPlanetsData(all) {
    state.allPlanets = all;
    var split = splitAndSortPlanets(all);
    state.planets = split.active;
    state.archivedPlanets = split.archived;
    layoutPlanets(); // archived set changed or not, this is cheap and keeps orbits in sync
    renderTreeList();
    applyTabFilter();
  }

  // Local merge from a PATCH/POST response, avoiding a full re-fetch for rename/pin/archive.
  function mergePlanetUpdate(updated) {
    var all = state.allPlanets.slice();
    var idx = -1;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === updated.id) { idx = i; break; }
    }
    if (idx === -1) all.push(updated); else all[idx] = updated;
    applyPlanetsData(all);
  }

  function refreshPlanetsFromServer() {
    return apiGetPlanets().then(function (planets) {
      state.serverOffline = false;
      applyPlanetsData(planets);
    }).catch(function (err) {
      showToast("Could not refresh worlds: " + err.message);
    });
  }

  function togglePlanetPin(planet) {
    apiPatchPlanet(planet.id, { pinned: !planet.pinned }).then(function (updated) {
      mergePlanetUpdate(updated);
    }).catch(function (err) {
      showToast("Pin update failed: " + err.message);
    });
  }

  function setPlanetArchived(planet, archived) {
    apiPatchPlanet(planet.id, { archived: archived }).then(function (updated) {
      mergePlanetUpdate(updated);
      showToast((archived ? "Archived " : "Unarchived ") + planet.name + ".");
    }).catch(function (err) {
      showToast("Archive update failed: " + err.message);
    });
  }

  function renderTreeList() {
    els.treeList.innerHTML = "";
    state.treeRows = {};
    // Pre-sorted by applyPlanetsData (pinned first, then alpha) -- render in that order.
    state.planets.forEach(function (planet) {
      var row = buildTreeRow(planet);
      els.treeList.appendChild(row.rowEl);
      state.treeRows[planet.id] = row;
      updateRowStatus(planet);
    });
    renderArchivedSection();
  }

  function renderArchivedSection() {
    var archived = state.archivedPlanets || [];
    els.archivedHeader.textContent = "Archived (" + archived.length + ")";
    els.archivedSection.classList.toggle("hidden", archived.length === 0);

    els.archivedList.innerHTML = "";
    archived.forEach(function (planet) {
      var li = document.createElement("li");
      li.className = "archived-row";

      var nameEl = document.createElement("span");
      nameEl.className = "archived-row-name";
      nameEl.textContent = planet.name;
      li.appendChild(nameEl);

      var unarchiveBtn = document.createElement("button");
      unarchiveBtn.className = "tree-icon-btn archived-unarchive-btn";
      unarchiveBtn.textContent = "Unarchive";
      unarchiveBtn.title = "Bring this world back to the map";
      unarchiveBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        setPlanetArchived(planet, false);
      });
      li.appendChild(unarchiveBtn);

      els.archivedList.appendChild(li);
    });
  }

  // Turns planet.nameEl into an inline input; Enter saves via PATCH, Escape/blur cancels.
  function beginRenamePlanet(planet) {
    var row = state.treeRows[planet.id];
    if (!row || row.renaming) return;
    row.renaming = true;

    var input = document.createElement("input");
    input.type = "text";
    input.className = "tree-row-name-input";
    input.value = planet.name;
    input.maxLength = 60;
    input.addEventListener("click", function (evt) { evt.stopPropagation(); });
    row.nameEl.replaceWith(input);
    input.focus();
    input.select();

    // Removing/replacing a focused input fires a synchronous "blur" on it, which would
    // re-enter finish() mid-mutation (the reentrant call's own replaceWith then fails
    // because the outer call already detached the node). settled + detaching the blur
    // listener up front closes both the reentrancy and any later double-fire.
    var settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      row.renaming = false;
      input.removeEventListener("blur", finish);
      if (input.parentNode) input.replaceWith(row.nameEl);
    }

    function commit() {
      if (settled) return;
      var newName = input.value.trim();
      if (!newName || newName === planet.name) { finish(); return; }

      settled = true;
      row.renaming = false;
      input.removeEventListener("blur", finish);

      apiPatchPlanet(planet.id, { name: newName }).then(function (updated) {
        mergePlanetUpdate(updated); // full tree rebuild replaces this input naturally
      }).catch(function (err) {
        showToast("Rename failed: " + err.message);
        if (input.parentNode) input.replaceWith(row.nameEl);
      });
    }

    input.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); commit(); }
      else if (evt.key === "Escape") { evt.preventDefault(); finish(); }
    });
    input.addEventListener("blur", finish);
  }

  /* ====================================================================
   * MODAL (shared small-form pop-up, v2.6)
   * ==================================================================== */

  // Replaces window.prompt/alert (banned here -- they block the event loop) for any
  // short add/edit form: centered card over a dimmed backdrop. Callers supply
  // buildBody(bodyEl) to append their own fields and onSubmit(modal) to run on Save;
  // the modal stays open until the caller calls modal.close() itself, so a failed API
  // call can leave it open with a toast instead of silently vanishing. Esc and a
  // backdrop click both cancel; Enter inside any text input in the body submits, same
  // as clicking Save. The first <input> in the body is focused once built.
  function openModal(opts) {
    var backdropEl = document.createElement("div");
    backdropEl.className = "modal-backdrop";

    var cardEl = document.createElement("div");
    cardEl.className = "modal-card";
    cardEl.addEventListener("click", function (evt) { evt.stopPropagation(); });
    backdropEl.appendChild(cardEl);

    var titleEl = document.createElement("div");
    titleEl.className = "modal-title";
    titleEl.textContent = opts.title;
    cardEl.appendChild(titleEl);

    var bodyEl = document.createElement("div");
    bodyEl.className = "modal-body";
    cardEl.appendChild(bodyEl);

    var actionsEl = document.createElement("div");
    actionsEl.className = "modal-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "modal-cancel-btn";
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    actionsEl.appendChild(cancelBtn);

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "modal-submit-btn";
    submitBtn.textContent = opts.submitLabel || "Save";
    actionsEl.appendChild(submitBtn);

    cardEl.appendChild(actionsEl);
    document.body.appendChild(backdropEl);

    function close() {
      document.removeEventListener("keydown", onKeydown);
      backdropEl.remove();
    }

    function onKeydown(evt) {
      if (evt.key === "Escape") {
        evt.preventDefault();
        close();
      } else if (evt.key === "Enter" && document.activeElement && document.activeElement.tagName === "INPUT") {
        evt.preventDefault();
        submitBtn.click();
      }
    }
    document.addEventListener("keydown", onKeydown);

    backdropEl.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);

    var modal = { bodyEl: bodyEl, submitBtn: submitBtn, cancelBtn: cancelBtn, close: close };

    opts.buildBody(bodyEl, modal);
    submitBtn.addEventListener("click", function () { opts.onSubmit(modal); });

    var firstInput = bodyEl.querySelector("input");
    if (firstInput) firstInput.focus();

    return modal;
  }

  // Add-moon pop-up: opened from the (+) button on the Moons section header. onCountChange
  // is the same header-label updater renderMoonsInto/buildMoonAddForm already take, kept
  // consistent so a later remove (on the card this creates) updates the same label. onAdded
  // fires once, only after a successful add, so buildTreeRow can force the section open --
  // it is deliberately NOT threaded into renderMoonsInto's onCountChange, otherwise a later
  // remove on an unrelated card would also re-force the section open.
  function openAddMoonModal(planet, listEl, emptyEl, onCountChange, onAdded) {
    var nameInput, targetInput;
    openModal({
      title: "Add moon to " + planet.name,
      submitLabel: "Add",
      buildBody: function (bodyEl) {
        nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "modal-input";
        nameInput.placeholder = "Moon name";
        nameInput.maxLength = 40;
        bodyEl.appendChild(nameInput);

        targetInput = document.createElement("input");
        targetInput.type = "text";
        targetInput.className = "modal-input";
        targetInput.placeholder = "SSH target (optional)";
        targetInput.maxLength = 120;
        bodyEl.appendChild(targetInput);
      },
      onSubmit: function (modal) {
        var name = nameInput.value.trim();
        if (!name) return;
        var sshTarget = targetInput.value.trim();
        modal.submitBtn.disabled = true;
        apiAddMoon(planet.id, name, sshTarget).then(function (result) {
          planet.moons = result.moons;
          layoutPlanets(); // rebuilds moonSprites/decor from the new planet.moons, map updates immediately
          renderMoonsInto(planet, listEl, emptyEl, onCountChange);
          if (onCountChange) onCountChange();
          modal.close();
          if (onAdded) onAdded();
          showToast("Moon " + name + " added to " + planet.name + ".");
        }).catch(function (err) {
          modal.submitBtn.disabled = false;
          showToast("Add moon failed: " + (err && err.message ? err.message : "network error"));
        });
      }
    });
  }

  // Add-world pop-up: opened from the "+" button in the sidebar header (btn-add-world).
  // Reuses the exact same openModal helper as openAddMoonModal so the two flows look
  // identical. Supersedes the old inline #add-world-form toggle (toggleAddWorldForm/
  // submitAddWorldForm below) -- those functions are left in place, unused, per the
  // no-deletion rule; only wireAddWorldForm's button wiring changed.
  function openAddWorldModal() {
    var nameInput, sshInput;
    openModal({
      title: "Add world",
      submitLabel: "Create",
      buildBody: function (bodyEl) {
        nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "modal-input";
        nameInput.placeholder = "World name";
        bodyEl.appendChild(nameInput);

        sshInput = document.createElement("input");
        sshInput.type = "text";
        sshInput.className = "modal-input";
        sshInput.placeholder = "SSH target (optional)";
        bodyEl.appendChild(sshInput);
      },
      onSubmit: function (modal) {
        var name = nameInput.value.trim();
        if (!name) {
          showToast("World name is required.");
          return;
        }
        var sshTarget = sshInput.value.trim();
        var payload = { name: name };
        if (sshTarget) payload.sshTarget = sshTarget;
        modal.submitBtn.disabled = true;
        apiCreatePlanet(payload).then(function () {
          modal.close();
          return refreshPlanetsFromServer();
        }).catch(function (err) {
          modal.submitBtn.disabled = false;
          showToast("Could not create world: " + err.message);
        });
      }
    });
  }

  // Shared positioned tooltip for the small "?" info buttons next to the planet action
  // buttons (Remote Control / Local Control / Desktop) and the moon card's Remote button.
  // One tooltip element is reused for all of them (only one can be open at a time, same as
  // the map's own ship-tooltip pattern), positioned relative to whichever "?" is hovered.
  var infoTooltipEl = null;

  function showInfoTooltip(anchorEl, text) {
    if (!infoTooltipEl) {
      infoTooltipEl = document.createElement("div");
      infoTooltipEl.className = "info-tooltip-popup hidden";
      document.body.appendChild(infoTooltipEl);
    }
    infoTooltipEl.textContent = text;
    infoTooltipEl.classList.remove("hidden");
    var rect = anchorEl.getBoundingClientRect();
    var tipRect = infoTooltipEl.getBoundingClientRect();
    var left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    var top = rect.top - tipRect.height - 8;
    if (top < 8) top = rect.bottom + 8; // not enough room above -- flip below instead
    infoTooltipEl.style.left = left + "px";
    infoTooltipEl.style.top = top + "px";
  }

  function hideInfoTooltip() {
    if (infoTooltipEl) infoTooltipEl.classList.add("hidden");
  }

  // small=true shrinks the circle to fit the narrower moon card row. A click on the "?"
  // always stopPropagation()s so it can never fire whatever action button/row it sits next
  // to -- the tooltip itself only ever shows via hover or keyboard focus, never a click
  // toggle, so there is no extra state to manage and no new modal.
  function createInfoTipButton(text, small) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "info-tip-btn" + (small ? " small" : "");
    btn.textContent = "?";
    btn.setAttribute("aria-label", "What does this do?");
    btn.addEventListener("mouseenter", function () { showInfoTooltip(btn, text); });
    btn.addEventListener("mouseleave", hideInfoTooltip);
    btn.addEventListener("focus", function () { showInfoTooltip(btn, text); });
    btn.addEventListener("blur", hideInfoTooltip);
    btn.addEventListener("click", function (evt) {
      evt.stopPropagation();
    });
    return btn;
  }

  function buildTreeRow(planet) {
    var rowEl = document.createElement("li");
    rowEl.className = "tree-row";
    rowEl.dataset.planetId = planet.id;

    var headerEl = document.createElement("div");
    headerEl.className = "tree-row-header";
    headerEl.addEventListener("click", function () {
      selectPlanet(planet.id, "tree");
    });

    var dotEl = document.createElement("span");
    dotEl.className = "tree-status-dot";
    headerEl.appendChild(dotEl);

    var nameEl = document.createElement("span");
    nameEl.className = "tree-row-name";
    nameEl.textContent = planet.name;
    nameEl.title = "Double-click to rename";
    nameEl.addEventListener("dblclick", function (evt) {
      evt.stopPropagation();
      beginRenamePlanet(planet);
    });
    headerEl.appendChild(nameEl);

    var pinBtn = document.createElement("button");
    pinBtn.className = "tree-icon-btn tree-pin-btn";
    pinBtn.textContent = planet.pinned ? "Unpin" : "Pin";
    pinBtn.title = planet.pinned ? "Unpin this world" : "Pin this world to the top";
    pinBtn.classList.toggle("active", !!planet.pinned);
    pinBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      togglePlanetPin(planet);
    });
    headerEl.appendChild(pinBtn);

    var archiveBtn = document.createElement("button");
    archiveBtn.className = "tree-icon-btn tree-archive-btn";
    archiveBtn.textContent = "Archive";
    archiveBtn.title = "Archive this world";
    archiveBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      setPlanetArchived(planet, true);
    });
    headerEl.appendChild(archiveBtn);

    rowEl.appendChild(headerEl);

    var expansionEl = document.createElement("div");
    expansionEl.className = "tree-row-expansion";

    var kindEl = document.createElement("div");
    kindEl.className = "tree-expansion-kind";
    kindEl.textContent = planet.kind || "unknown kind";
    expansionEl.appendChild(kindEl);

    var statusPillEl = document.createElement("div");
    statusPillEl.className = "status-pill status-unknown";
    statusPillEl.textContent = "unknown";
    expansionEl.appendChild(statusPillEl);

    var sleepWarningEl = document.createElement("div");
    sleepWarningEl.className = "sleep-warning hidden";
    sleepWarningEl.textContent = "This planet sleeps. Garrisons die when it does.";
    expansionEl.appendChild(sleepWarningEl);

    var asleepNoticeEl = document.createElement("div");
    asleepNoticeEl.className = "asleep-notice hidden";
    asleepNoticeEl.textContent = "Planet asleep. Wake it from the Lightning.ai dashboard, then it answers SSH.";
    expansionEl.appendChild(asleepNoticeEl);

    var basesTitleEl = document.createElement("div");
    basesTitleEl.className = "tree-section-title";
    basesTitleEl.textContent = "Bases";
    expansionEl.appendChild(basesTitleEl);

    var basesListEl = document.createElement("ul");
    basesListEl.className = "bases-list";
    expansionEl.appendChild(basesListEl);

    var basesEmptyEl = document.createElement("div");
    basesEmptyEl.className = "tree-bases-empty hidden";
    basesEmptyEl.textContent = "No bases running.";
    expansionEl.appendChild(basesEmptyEl);

    renderBasesInto(planet, basesListEl, basesEmptyEl);

    // Collapsible Moons section (v2.6, per the original design revision): header row is
    // clickable (chevron + "Moons (N)" + a (+) button at the right end that opens the
    // add-moon modal -- see openAddMoonModal), moonsBodyEl holds just the card list and
    // toggles independently. Default is ALWAYS collapsed on first visit, regardless of
    // moon count; once the user (or a successful add, see onAdded below) opens it, the
    // choice is remembered per planet (see getMoonsOpenPref/setMoonsOpenPref) so it
    // survives a reload. There is no inline add-form in the panel anymore -- buildMoonAddForm
    // still exists below, unused, per the no-deletion rule.
    var moonsHeaderEl = document.createElement("div");
    moonsHeaderEl.className = "tree-section-title moons-section-header";

    var moonsChevronEl = document.createElement("span");
    moonsChevronEl.className = "moons-chevron";
    moonsChevronEl.textContent = ">";
    moonsHeaderEl.appendChild(moonsChevronEl);

    var moonsHeaderLabelEl = document.createElement("span");
    moonsHeaderLabelEl.className = "moons-header-label";
    moonsHeaderEl.appendChild(moonsHeaderLabelEl);

    var moonsAddBtn = document.createElement("button");
    moonsAddBtn.type = "button";
    moonsAddBtn.className = "moons-add-btn";
    moonsAddBtn.title = "Add moon";
    moonsAddBtn.textContent = "+";
    moonsHeaderEl.appendChild(moonsAddBtn);

    expansionEl.appendChild(moonsHeaderEl);

    function updateMoonsHeaderLabel() {
      var count = (planet.moons || []).length;
      moonsHeaderLabelEl.textContent = count > 0 ? ("Moons (" + count + ")") : "Moons";
    }
    updateMoonsHeaderLabel();

    var moonsBodyEl = document.createElement("div");
    moonsBodyEl.className = "moons-section-body";

    var moonsListEl = document.createElement("ul");
    moonsListEl.className = "moons-list";
    moonsBodyEl.appendChild(moonsListEl);

    var moonsEmptyEl = document.createElement("div");
    moonsEmptyEl.className = "tree-moons-empty hidden";
    moonsEmptyEl.textContent = "No moons.";
    moonsBodyEl.appendChild(moonsEmptyEl);

    renderMoonsInto(planet, moonsListEl, moonsEmptyEl, updateMoonsHeaderLabel);

    expansionEl.appendChild(moonsBodyEl);

    var moonsOpen = getMoonsOpenPref(planet.id);
    if (moonsOpen === null) moonsOpen = false; // v2.6: always collapsed by default, regardless of moon count

    function applyMoonsOpenState() {
      moonsBodyEl.classList.toggle("hidden", !moonsOpen);
      moonsChevronEl.classList.toggle("open", moonsOpen);
    }
    applyMoonsOpenState();

    moonsAddBtn.addEventListener("click", function (evt) {
      evt.stopPropagation(); // don't also trigger moonsHeaderEl's own collapse/expand toggle below
      openAddMoonModal(planet, moonsListEl, moonsEmptyEl, updateMoonsHeaderLabel, function () {
        moonsOpen = true;
        setMoonsOpenPref(planet.id, true);
        applyMoonsOpenState();
      });
    });

    moonsHeaderEl.addEventListener("click", function (evt) {
      evt.stopPropagation();
      moonsOpen = !moonsOpen;
      setMoonsOpenPref(planet.id, moonsOpen);
      applyMoonsOpenState();
    });

    var actionsEl = document.createElement("div");
    actionsEl.className = "tree-actions";

    var isLocal = planet.kind === "local";

    var remoteControlTip = "An agent on your local machine connects to " + planet.name + " over SSH and controls it remotely.";
    var localControlTip = "Deploys an agent that runs directly on " + planet.name + ". Nothing runs on your computer.";
    var desktopTip = "See " + planet.name + "'s virtual desktop and interact with it.";

    var travelRowEl = document.createElement("div");
    travelRowEl.className = "action-row";

    var btnTravel = document.createElement("button");
    // Local planets (we are already standing on this machine): Remote Control makes no
    // sense, so this button is relabeled "Local Control" and keeps its open-local-shell
    // behavior; the agent-selection Local Control dropdown below is hidden instead (see
    // deployWrapEl below). User-visible text only -- class names/identifiers unchanged.
    btnTravel.className = isLocal ? "action-btn action-deploy has-info-tip" : "action-btn action-travel has-info-tip";
    btnTravel.textContent = isLocal ? "Local Control" : "Remote Control";
    btnTravel.addEventListener("click", function (evt) {
      evt.stopPropagation();
      openTerminalTab(planet, "bridge", "visitor");
    });
    travelRowEl.appendChild(btnTravel);
    travelRowEl.appendChild(createInfoTipButton(isLocal ? localControlTip : remoteControlTip));
    actionsEl.appendChild(travelRowEl);

    var deployWrapEl = document.createElement("div");
    deployWrapEl.className = "deploy-wrap";
    if (isLocal) deployWrapEl.classList.add("hidden");

    var btnDeploy = document.createElement("button");
    btnDeploy.className = "action-btn action-deploy has-info-tip";
    btnDeploy.textContent = "Local Control";
    deployWrapEl.appendChild(btnDeploy);
    deployWrapEl.appendChild(createInfoTipButton(localControlTip));

    var deployDropdownEl = document.createElement("div");
    deployDropdownEl.className = "deploy-dropdown hidden";
    deployWrapEl.appendChild(deployDropdownEl);

    btnDeploy.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var wasHidden = deployDropdownEl.classList.contains("hidden");
      closeAllDeployDropdowns();
      if (wasHidden) deployDropdownEl.classList.remove("hidden");
    });

    (planet.deployAgents || []).forEach(function (agent) {
      var opt = document.createElement("div");
      opt.className = "deploy-option";
      opt.textContent = agent;
      opt.addEventListener("click", function (evt) {
        evt.stopPropagation();
        deployDropdownEl.classList.add("hidden");
        handleDeploy(planet.id, agent);
      });
      deployDropdownEl.appendChild(opt);
    });

    actionsEl.appendChild(deployWrapEl);

    var desktopRowEl = document.createElement("div");
    desktopRowEl.className = "action-row";

    var btnDesktop = document.createElement("button");
    btnDesktop.className = "action-btn action-desktop has-info-tip";
    btnDesktop.disabled = true;
    btnDesktop.title = "coming in v2";
    btnDesktop.textContent = "Desktop";
    btnDesktop.addEventListener("click", function (evt) {
      evt.stopPropagation();
      var hasDesktopDoor = (planet.doors || []).indexOf("desktop") !== -1;
      if (!hasDesktopDoor || btnDesktop.disabled) return;
      openDesktopTab(planet, "/desktop.html?planet=" + planet.id);
    });
    desktopRowEl.appendChild(btnDesktop);
    desktopRowEl.appendChild(createInfoTipButton(desktopTip));
    actionsEl.appendChild(desktopRowEl);

    expansionEl.appendChild(actionsEl);

    var offlineReasonEl = document.createElement("div");
    offlineReasonEl.className = "tree-offline-reason hidden";
    expansionEl.appendChild(offlineReasonEl);

    rowEl.appendChild(expansionEl);

    return {
      id: planet.id,
      rowEl: rowEl,
      headerEl: headerEl,
      dotEl: dotEl,
      nameEl: nameEl,
      renaming: false,
      statusPillEl: statusPillEl,
      sleepWarningEl: sleepWarningEl,
      asleepNoticeEl: asleepNoticeEl,
      btnTravel: btnTravel,
      btnDeploy: btnDeploy,
      deployDropdownEl: deployDropdownEl,
      btnDesktop: btnDesktop,
      offlineReasonEl: offlineReasonEl
    };
  }

  function renderBasesInto(planet, listEl, emptyEl) {
    listEl.innerHTML = "";
    var bases = planet.bases || [];
    if (bases.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    bases.forEach(function (base) {
      var li = document.createElement("li");
      li.className = "base-row";

      var cardEl = document.createElement("div");
      cardEl.className = "base-card-main";
      var nameEl = document.createElement("div");
      nameEl.className = "base-session-name";
      nameEl.textContent = base.session;
      var metaEl = document.createElement("div");
      metaEl.className = "base-meta";
      var windows = (base.windows !== undefined) ? (base.windows + " windows") : "";
      var created = base.created ? (", created " + base.created) : "";
      metaEl.textContent = windows + created;
      cardEl.appendChild(nameEl);
      cardEl.appendChild(metaEl);
      li.appendChild(cardEl);

      // Hover-revealed remove control. Click opens an inline confirm INSTEAD of removing
      // anything -- the actual removal only ever fires from a second, distinct click on the
      // confirm button below, so a fast double-click on the same spot can never delete a
      // base by accident (the confirm button doesn't exist yet at the time of the first click).
      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "base-remove-btn";
      removeBtn.title = "Remove base";
      removeBtn.textContent = "x";
      li.appendChild(removeBtn);

      var confirmEl = null;

      function hideRemoveConfirm() {
        if (!confirmEl) return;
        confirmEl.remove();
        confirmEl = null;
        cardEl.classList.remove("hidden");
        removeBtn.classList.remove("hidden");
      }

      function showRemoveConfirm() {
        if (confirmEl) return;
        cardEl.classList.add("hidden");
        removeBtn.classList.add("hidden");

        confirmEl = document.createElement("div");
        confirmEl.className = "base-remove-confirm";
        confirmEl.addEventListener("click", function (evt) { evt.stopPropagation(); });

        var textEl = document.createElement("div");
        textEl.className = "base-remove-confirm-text";
        textEl.textContent = "Remove base " + base.session + "? This kills the tmux session on " +
          planet.name + " and anything running in it.";
        confirmEl.appendChild(textEl);

        var actionsEl = document.createElement("div");
        actionsEl.className = "base-remove-confirm-actions";

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "base-remove-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          hideRemoveConfirm();
        });

        var confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "base-remove-confirm-btn";
        confirmBtn.textContent = "Remove";
        confirmBtn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          confirmBtn.textContent = "Removing...";
          apiRemoveBase(planet.id, base.session).then(function (result) {
            if (result && result.ok) {
              var idx = (planet.bases || []).indexOf(base);
              if (idx !== -1) planet.bases.splice(idx, 1);
              li.remove();
              if ((planet.bases || []).length === 0) emptyEl.classList.remove("hidden");
              showToast("Base " + base.session + " removed from " + planet.name + ".");
            } else {
              showToast("Remove failed: " + ((result && result.error) || "unknown error"));
              hideRemoveConfirm();
            }
          }).catch(function (err) {
            if (err && err.notImplemented) {
              showToast("Remove not available yet.");
            } else {
              showToast("Remove failed: " + (err && err.message ? err.message : "network error"));
            }
            hideRemoveConfirm();
          });
        });

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(confirmBtn);
        confirmEl.appendChild(actionsEl);
        li.appendChild(confirmEl);
      }

      removeBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        showRemoveConfirm();
      });

      li.addEventListener("click", function (evt) {
        evt.stopPropagation();
        openTerminalTab(planet, base.session, "visitor");
      });
      listEl.appendChild(li);
    });
  }

  // Moons as connectable machines: same hover-revealed remove + inline confirm pattern as
  // renderBasesInto above. A moon with an sshTarget also gets its own Travel button (see
  // moonTravelPlanetId) that opens a terminal ssh'd straight to that machine, independent of
  // whatever state the parent planet is in -- a moon is a different box, so the parent being
  // asleep never disables it. Moons with no sshTarget (legacy bare-string entries) stay
  // decorative, no Travel control. onCountChange is optional -- buildTreeRow passes its
  // header-label updater so removing a moon keeps the "Moons (N)" count in sync.
  function renderMoonsInto(planet, listEl, emptyEl, onCountChange) {
    listEl.innerHTML = "";
    var moons = planet.moons || [];
    if (moons.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    moons.forEach(function (raw) {
      var moon = normalizeMoonEntry(raw);
      var li = document.createElement("li");
      li.className = "moon-row";

      var cardEl = document.createElement("div");
      cardEl.className = "moon-card-main";
      var nameEl = document.createElement("div");
      nameEl.className = "moon-name";
      nameEl.textContent = moon.name;
      cardEl.appendChild(nameEl);
      if (moon.sshTarget) {
        var targetEl = document.createElement("div");
        targetEl.className = "moon-target";
        targetEl.textContent = moon.sshTarget;
        cardEl.appendChild(targetEl);

        var travelRowEl = document.createElement("div");
        travelRowEl.className = "moon-travel-row";

        var travelBtn = document.createElement("button");
        travelBtn.type = "button";
        travelBtn.className = "moon-travel-btn";
        travelBtn.textContent = "Remote Control";
        travelBtn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          // A pseudo-planet, never added to state.planets/state.allPlanets: only .id, .name,
          // and .kind are read along this path (createShip, autoTabLabel, tabDotStatus), and
          // "remote" kind is what makes openTab spawn an ssh tab instead of a local shell one.
          // The synthetic id is what routes the server's getPlanet() to the MOON's own
          // sshTarget -- see moonTravelPlanetId's comment for the whole chain.
          var moonPlanet = { id: moonTravelPlanetId(planet.id, moon.name), name: moon.name, kind: "remote" };
          var tab = openTerminalTab(moonPlanet, "bridge", "visitor", moon.name);
          if (tab) {
            tab.moonParentId = planet.id;
            // openTerminalTab/openTab already ran applyTabFilter() once, before moonParentId
            // existed on the tab -- at that point isTabVisible had only the synthetic id to
            // compare against state.selectedPlanetId, so it hid the tab. Re-run the filter now
            // that moonParentId is set, so the tab the user just opened doesn't appear to vanish.
            applyTabFilter();
          }
        });
        travelRowEl.appendChild(travelBtn);
        travelRowEl.appendChild(createInfoTipButton(
          "An agent on your local machine connects to " + moon.name + " over SSH and controls it remotely.",
          true
        ));
        cardEl.appendChild(travelRowEl);
      }
      li.appendChild(cardEl);

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "moon-remove-btn";
      removeBtn.title = "Remove moon";
      removeBtn.textContent = "x";
      li.appendChild(removeBtn);

      var confirmEl = null;

      function hideRemoveConfirm() {
        if (!confirmEl) return;
        confirmEl.remove();
        confirmEl = null;
        cardEl.classList.remove("hidden");
        removeBtn.classList.remove("hidden");
      }

      function showRemoveConfirm() {
        if (confirmEl) return;
        cardEl.classList.add("hidden");
        removeBtn.classList.add("hidden");

        confirmEl = document.createElement("div");
        confirmEl.className = "moon-remove-confirm";
        confirmEl.addEventListener("click", function (evt) { evt.stopPropagation(); });

        var textEl = document.createElement("div");
        textEl.className = "moon-remove-confirm-text";
        textEl.textContent = "Remove moon " + moon.name + " from " + planet.name + "?";
        confirmEl.appendChild(textEl);

        var actionsEl = document.createElement("div");
        actionsEl.className = "moon-remove-confirm-actions";

        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "moon-remove-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          hideRemoveConfirm();
        });

        var confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "moon-remove-confirm-btn";
        confirmBtn.textContent = "Remove";
        confirmBtn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          confirmBtn.textContent = "Removing...";
          apiRemoveMoon(planet.id, moon.name).then(function (result) {
            planet.moons = result.moons;
            layoutPlanets(); // rebuilds moonSprites/decor from the new planet.moons, map updates immediately
            renderMoonsInto(planet, listEl, emptyEl, onCountChange);
            if (onCountChange) onCountChange();
            showToast("Moon " + moon.name + " removed from " + planet.name + ".");
          }).catch(function (err) {
            showToast("Remove moon failed: " + (err && err.message ? err.message : "network error"));
            hideRemoveConfirm();
          });
        });

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(confirmBtn);
        confirmEl.appendChild(actionsEl);
        li.appendChild(confirmEl);
      }

      removeBtn.addEventListener("click", function (evt) {
        evt.stopPropagation();
        showRemoveConfirm();
      });

      listEl.appendChild(li);
    });
  }

  // UNUSED as of v2.6 -- superseded by openAddMoonModal (the Moons section header's (+)
  // button), per the original design revision. Left in place, unwired, per the no-deletion rule
  // rather than removed. "Add moon" mini-form, styled after the global add-world-form
  // (#add-world-form in index.html) but built dynamically per tree row since each planet
  // got its own copy inline in its expansion panel rather than one shared floating form.
  function buildMoonAddForm(planet, listEl, emptyEl, onCountChange) {
    var wrap = document.createElement("div");
    wrap.addEventListener("click", function (evt) { evt.stopPropagation(); });

    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "moon-add-toggle-btn";
    toggleBtn.textContent = "+ Add moon";
    wrap.appendChild(toggleBtn);

    var formEl = document.createElement("div");
    formEl.className = "moon-add-form hidden";
    wrap.appendChild(formEl);

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "moon-add-input";
    nameInput.placeholder = "Moon name";
    nameInput.maxLength = 40;
    formEl.appendChild(nameInput);

    var targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.className = "moon-add-input";
    targetInput.placeholder = "SSH target (optional)";
    targetInput.maxLength = 120;
    formEl.appendChild(targetInput);

    var formActionsEl = document.createElement("div");
    formActionsEl.className = "moon-add-actions";

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "moon-add-btn";
    addBtn.textContent = "Add moon";
    formActionsEl.appendChild(addBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "moon-add-cancel-btn";
    cancelBtn.textContent = "Cancel";
    formActionsEl.appendChild(cancelBtn);

    formEl.appendChild(formActionsEl);

    function showForm() {
      toggleBtn.classList.add("hidden");
      formEl.classList.remove("hidden");
      nameInput.focus();
    }

    function hideForm() {
      formEl.classList.add("hidden");
      toggleBtn.classList.remove("hidden");
      nameInput.value = "";
      targetInput.value = "";
    }

    toggleBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      showForm();
    });
    cancelBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      hideForm();
    });

    function submit() {
      var name = nameInput.value.trim();
      if (!name) return;
      var sshTarget = targetInput.value.trim();
      addBtn.disabled = true;
      apiAddMoon(planet.id, name, sshTarget).then(function (result) {
        planet.moons = result.moons;
        layoutPlanets(); // rebuilds moonSprites/decor from the new planet.moons, map updates immediately
        renderMoonsInto(planet, listEl, emptyEl, onCountChange);
        if (onCountChange) onCountChange();
        addBtn.disabled = false;
        hideForm();
        showToast("Moon " + name + " added to " + planet.name + ".");
      }).catch(function (err) {
        addBtn.disabled = false;
        showToast("Add moon failed: " + (err && err.message ? err.message : "network error"));
      });
    }

    addBtn.addEventListener("click", function (evt) {
      evt.stopPropagation();
      submit();
    });
    nameInput.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); submit(); }
    });
    targetInput.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); submit(); }
    });

    return wrap;
  }

  // Called on tree build and on every /events status change: keeps the dot current
  // always, and also refreshes the fuller gating (buttons/notices) if this row happens
  // to be the one currently expanded.
  function updateRowStatus(planet) {
    var row = state.treeRows[planet.id];
    if (!row) return;
    var status = planet.status || "unknown";
    row.dotEl.className = "tree-status-dot dot-" + status;
    if (state.selectedPlanetId === planet.id) {
      refreshRowGating(planet, row);
    }
  }

  function refreshRowGating(planet, row) {
    var status = planet.status || "unknown";
    row.statusPillEl.textContent = status;
    row.statusPillEl.className = "status-pill status-" + status;

    row.sleepWarningEl.classList.toggle("hidden", !planet.sleepWarning);
    row.asleepNoticeEl.classList.toggle("hidden", status !== "asleep");

    var asleep = status === "asleep";
    var offline = state.serverOffline || status === "offline" || asleep;
    var hasDesktopDoor = (planet.doors || []).indexOf("desktop") !== -1;

    var isLocal = planet.kind === "local";

    row.btnTravel.disabled = offline; // this is the relabeled "Deploy" button on local planets too
    row.btnDeploy.disabled = offline || !planet.deployAgents || planet.deployAgents.length === 0;

    if (hasDesktopDoor) {
      row.btnDesktop.disabled = offline;
      row.btnDesktop.title = offline ? "Planet unreachable, desktop unavailable until it answers." : "Open desktop (VNC)";
    } else {
      row.btnDesktop.disabled = true;
      row.btnDesktop.title = "coming in v2";
    }

    var actionNames = isLocal
      ? ("Local Control" + (hasDesktopDoor ? " and Desktop" : ""))
      : ("Remote Control, Local Control" + (hasDesktopDoor ? ", and Desktop" : ""));
    var actionVerb = (isLocal && !hasDesktopDoor) ? "is" : "are";
    if (asleep) {
      row.offlineReasonEl.textContent = "Planet is asleep. " + actionNames + " " + actionVerb + " disabled until it wakes and answers SSH.";
      row.offlineReasonEl.classList.remove("hidden");
    } else if (offline) {
      row.offlineReasonEl.textContent = "Planet is offline or unreachable. " + actionNames + " " + actionVerb + " disabled until contact is restored.";
      row.offlineReasonEl.classList.remove("hidden");
    } else {
      row.offlineReasonEl.classList.add("hidden");
    }
  }

  function closeAllDeployDropdowns() {
    Object.keys(state.treeRows).forEach(function (id) {
      state.treeRows[id].deployDropdownEl.classList.add("hidden");
    });
  }

  function updateTreeExpansionUI() {
    Object.keys(state.treeRows).forEach(function (id) {
      state.treeRows[id].rowEl.classList.toggle("expanded", id === state.selectedPlanetId);
    });
  }

  // Single shared selection: source "map" (click a planet on the canvas) always opens
  // and scrolls the tree to it; source "tree" (click a row) toggles closed on re-click
  // (accordion) and pulses the planet on the map so the two views stay in sync either way.
  function selectPlanet(planetId, source) {
    var planet = findPlanet(planetId);
    if (!planet) return;

    var alreadyOpen = (state.selectedPlanetId === planetId);
    closeAllDeployDropdowns();

    if (source === "tree" && alreadyOpen) {
      state.selectedPlanetId = null;
      updateTreeExpansionUI();
      applyTabFilter(); // no planet selected -- tab strip shows everything again
      return;
    }

    state.selectedPlanetId = planetId;
    updateTreeExpansionUI();
    applyTabFilter(); // strip narrows to (or stays on) this planet's tabs

    var row = state.treeRows[planetId];
    if (row) refreshRowGating(planet, row);

    if (state.sidebarCollapsed) {
      setSidebarCollapsed(false);
    }

    if (source === "map" && row) {
      row.rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    if (source === "tree") {
      state.pulsePlanetId = planetId;
      state.pulseStartTime = performance.now();
    }
  }

  function handleDeploy(planetId, agent) {
    var planet = findPlanet(planetId);
    if (!planet) return;
    apiDeploy(planetId, agent)
      .then(function (result) {
        openTerminalTab(planet, result.session, "garrison", nextAgentTabLabel(agent));
      })
      .catch(function (err) {
        showToast("Local Control failed: " + err.message);
      });
  }

  function setSidebarCollapsed(collapsed) {
    state.sidebarCollapsed = collapsed;
    els.galaxySidebar.classList.toggle("collapsed", collapsed);
    els.btnSidebarCollapse.textContent = collapsed ? ">" : "<";
    els.btnSidebarCollapse.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    applySidebarWidthVar();
    refitMapArea();
  }

  function toggleSidebarCollapse() {
    setSidebarCollapsed(!state.sidebarCollapsed);
  }

  function applySidebarWidthVar() {
    var px = state.sidebarCollapsed ? SIDEBAR_RAIL_PX : SIDEBAR_EXPANDED_PX;
    document.documentElement.style.setProperty("--sidebar-width", px + "px");
  }

  /* ======================================================================
   * TERMINALS
   * ==================================================================== */

  // Refresh-proof local terminals: persists which local pty tabs are open
  // (planetId + session -> server sessionId + display label) so a reload can
  // recreate the tabs and reattach to the SAME server-side session instead of
  // spawning a fresh shell. Remote/tmux tabs need none of this -- tmux itself
  // is the persistence layer there, and a plain Travel click already
  // re-attaches by session name. Entry shape: {planetId, session, sessionId, label}.
  var LOCAL_TERM_SESSIONS_KEY = "galaxyLocalTermSessions";

  function loadLocalTermSessions() {
    try {
      var raw = localStorage.getItem(LOCAL_TERM_SESSIONS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocalTermSessions(list) {
    try { localStorage.setItem(LOCAL_TERM_SESSIONS_KEY, JSON.stringify(list)); } catch (e) { /* private mode etc, non-fatal */ }
  }

  function localTermSessionKey(planetId, session) {
    return planetId + "::" + session;
  }

  function upsertLocalTermSession(planetId, session, sessionId, label) {
    var list = loadLocalTermSessions();
    var key = localTermSessionKey(planetId, session);
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (localTermSessionKey(list[i].planetId, list[i].session) === key) {
        list[i].sessionId = sessionId;
        list[i].label = label;
        found = true;
        break;
      }
    }
    if (!found) list.push({ planetId: planetId, session: session, sessionId: sessionId, label: label });
    saveLocalTermSessions(list);
  }

  function removeLocalTermSession(planetId, session) {
    var key = localTermSessionKey(planetId, session);
    var next = loadLocalTermSessions().filter(function (e) {
      return localTermSessionKey(e.planetId, e.session) !== key;
    });
    saveLocalTermSessions(next);
  }

  function findLocalTermSession(planetId, session) {
    var key = localTermSessionKey(planetId, session);
    var list = loadLocalTermSessions();
    for (var i = 0; i < list.length; i++) {
      if (localTermSessionKey(list[i].planetId, list[i].session) === key) return list[i];
    }
    return null;
  }

  // Filtering rule: a planet is selected AND "show all" is off. With no selection
  // (nothing expanded in the tree) every tab is shown regardless of the toggle.
  function isPlanetFilterActive() {
    return !!state.selectedPlanetId && !state.showAllTabs;
  }

  function isTabVisible(tab) {
    if (tab.type === "doc") return true; // sun's memory doc: always visible, excluded from the planet filter
    // A moon-travel tab's planetId is the synthetic "moon:<parentId>:<name>" id (see
    // moonTravelPlanetId), not the parent's real id, so it never matches state.selectedPlanetId
    // on its own. moonParentId (set right after openTerminalTab returns, in renderMoonsInto's
    // Travel handler) lets such a tab still count as visible when its PARENT planet is the
    // one selected -- otherwise the tab the user just opened would vanish immediately under
    // the default (filtered) view.
    return !isPlanetFilterActive() || tab.planetId === state.selectedPlanetId || tab.moonParentId === state.selectedPlanetId;
  }

  // Called on every selection change, filter toggle, tab open, and tab close so the
  // strip, the toggle label, and the active tab all stay in sync. Only reassigns the
  // active tab when the current one actually became hidden -- otherwise a terminal the
  // user is typing in never loses focus just because something elsewhere changed.
  function applyTabFilter() {
    var anyVisible = false;
    var activeStillVisible = false;

    state.terminalTabs.forEach(function (tab) {
      var visible = isTabVisible(tab);
      tab.tabEl.classList.toggle("hidden", !visible);
      if (visible) {
        anyVisible = true;
        if (tab.id === state.activeTabId) activeStillVisible = true;
      }
    });

    updateTabFilterToggleUI();
    updateDrawerEmptyNote(anyVisible);

    if (!activeStillVisible) {
      var firstVisible = state.terminalTabs.filter(isTabVisible)[0];
      if (firstVisible) {
        activateTab(firstVisible.id);
      } else {
        deactivateAllTabs();
      }
    }
  }

  function deactivateAllTabs() {
    state.activeTabId = null;
    state.terminalTabs.forEach(function (tab) {
      tab.tabEl.classList.remove("active");
      tab.paneEl.classList.remove("active");
    });
  }

  // The toggle only makes sense once a planet is selected (nothing to filter by
  // otherwise), so it hides itself rather than sitting there doing nothing.
  function updateTabFilterToggleUI() {
    var hasSelection = !!state.selectedPlanetId;
    els.btnTabFilterToggle.classList.toggle("hidden", !hasSelection);
    if (!hasSelection) return;

    if (state.showAllTabs) {
      els.btnTabFilterToggle.textContent = "This planet";
      els.btnTabFilterToggle.title = "Show only the selected planet's tabs";
      els.btnTabFilterToggle.classList.add("active");
    } else {
      var total = state.terminalTabs.length;
      els.btnTabFilterToggle.textContent = total > 0 ? ("Show all (" + total + ")") : "Show all";
      els.btnTabFilterToggle.title = "Show tabs from every planet";
      els.btnTabFilterToggle.classList.remove("active");
    }
  }

  function updateDrawerEmptyNote(anyVisible) {
    if (anyVisible) {
      els.drawerEmptyNote.classList.add("hidden");
      return;
    }
    els.drawerEmptyNote.textContent = isPlanetFilterActive()
      ? "No ships at this planet."
      : "No terminals open.";
    els.drawerEmptyNote.classList.remove("hidden");
  }

  // One ship per tab, created at tab-open and kept for the tab's whole lifetime: a
  // persistent color from the rotating palette, a small randomized orbit so several
  // ships at the same planet don't overlap, and a label for the hover tooltip.
  function createShip(planet, session, type) {
    return {
      planetId: planet.id,
      type: type,
      color: nextShipColor(),
      orbitRadius: 24 + Math.random() * 14,
      orbitSpeed: (0.0004 + Math.random() * 0.0003) * (Math.random() < 0.5 ? 1 : -1),
      orbitPhase: Math.random() * Math.PI * 2,
      bobPhase: Math.random() * Math.PI * 2,
      spawnTime: performance.now(),
      label: planet.name + " : " + session,
      trail: []
    };
  }

  // Auto-name for a freshly opened tab, before any manual rename. Local shell tabs are
  // always "PowerShell"; a garrison (deployed agent) tab supplies its own labelOverride
  // (agent name + counter, see nextAgentTabLabel); everything else (remote Travel, a
  // reattached base, desktop) is just named after its session/kind.
  function autoTabLabel(planet, session, type, labelOverride) {
    if (labelOverride) return labelOverride;
    if (type === "desktop") return "Desktop";
    if (planet.kind === "local") return "PowerShell";
    return session;
  }

  // Per-agent counter for deployed garrison tabs ("hermes 1", "hermes 2", ...), never
  // reused even if earlier tabs close, so labels stay unambiguous within the session.
  function nextAgentTabLabel(agent) {
    state.agentTabCounts[agent] = (state.agentTabCounts[agent] || 0) + 1;
    return agent + " " + state.agentTabCounts[agent];
  }

  // Tab dot status colors (v1.6, replaces the map-ship-color pairing on TABS ONLY --
  // the map ship glyph itself keeps its palette color and click-pairing unchanged):
  // green = local shell, yellow = tmux-backed and survives disconnect (both a remote
  // Travel/base-reattach and a garrison deploy), red = ephemeral, dies with the tab
  // (desktop/VNC, and any future non-tmux remote session). Filled = garrison-deployed or
  // a local shell; hollow = travel-attach or ephemeral -- an extra signal layered on top
  // of a shared color. Garrison alone also gets a ring, since a deployed agent is the one
  // state worth calling out beyond color+fill. Computed from the raw planet/kind/type
  // (not the tab object, which doesn't exist yet at the point openTab needs this).
  function tabDotStatus(planetKind, kind, type) {
    if (type === "desktop") return { colorVar: "--tab-status-ephemeral", filled: false, ring: false };
    if (planetKind === "local") return { colorVar: "--tab-status-local", filled: true, ring: false };
    if (kind === "garrison") return { colorVar: "--tab-status-tmux", filled: true, ring: true };
    return { colorVar: "--tab-status-tmux", filled: false, ring: false };
  }

  // Persistence is read from the dot's color+fill+ring; this is the hover tooltip that
  // spells it out in words. planetName/planetKind are snapshotted onto the tab at
  // creation (see openTab) so this works even if the planet is later renamed, archived,
  // or removed.
  function dotTooltipText(tab) {
    if (tab.type === "desktop") return "Desktop - VNC session on " + tab.planetName;
    if (tab.kind === "garrison") return "Garrison - survives disconnect on " + tab.planetName;
    if (tab.planetKind === "local") return "Local shell on " + tab.planetName;
    return "Visitor - lives while attached on " + tab.planetName;
  }

  // Double-click the tab name to rename it in place. Display-only (never touches the
  // underlying tmux session name) and doesn't persist across reload. Same reentrancy
  // guard as beginRenamePlanet/title edit: replacing a focused input fires a synchronous
  // blur, which would re-enter this teardown if not for the settled flag + detached
  // listener.
  function beginRenameTab(tab, labelEl) {
    if (tab.renaming) return;
    tab.renaming = true;
    // Cancel any focus-steal already in flight: a double-click's first constituent
    // click ran activateTab before this handler ever fired, which schedules
    // tab.term.focus() ~30ms out (see activateTab). Left alone, that stale timeout
    // fires after this rename's input is focused, blurs it, and silently reverts the
    // rename. Clearing it here closes the race outright, rather than just outrunning it.
    if (tab.focusTimeoutId) {
      clearTimeout(tab.focusTimeoutId);
      tab.focusTimeoutId = null;
    }
    var settled = false;

    var input = document.createElement("input");
    input.type = "text";
    input.className = "tab-name-input";
    input.value = tab.label;

    function finish() {
      if (settled) return;
      settled = true;
      tab.renaming = false;
      input.removeEventListener("blur", finish);
      if (input.parentNode) input.replaceWith(labelEl);
    }

    function commit() {
      if (settled) return;
      var value = input.value.trim();
      if (value) {
        tab.label = value;
        labelEl.textContent = value;
        if (tab.type === "xterm" && tab.planetKind === "local" && tab.localSessionId) {
          upsertLocalTermSession(tab.planetId, tab.session, tab.localSessionId, value);
        }
      }
      settled = true;
      tab.renaming = false;
      input.removeEventListener("blur", finish);
      if (input.parentNode) input.replaceWith(labelEl);
    }

    input.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); commit(); }
      else if (evt.key === "Escape") { evt.preventDefault(); finish(); }
    });
    input.addEventListener("blur", finish);

    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  // Measured live during a real codex "Working... esc to interrupt" spinner: the pty output
  // hides and re-shows the terminal cursor (ESC[?25l / ESC[?25h) about 196 times per second,
  // one toggle every ~5ms -- far faster than a human can perceive as anything but a strobe.
  // Output is already batched into one paint per animation frame (see flushWriteQueue in
  // openTab below), so a hide that is later followed by a show WITHIN THE SAME FRAME never
  // needs to visibly register at all: the user never sees the intermediate hidden state
  // regardless of whether we keep or drop the pair. Stripping both halves (leaving whatever
  // was drawn in between untouched) makes the cursor read as steady instead of flickering,
  // without disabling real cursor-hide behavior: a hide with no matching show in the current
  // frame's content is left exactly as-is and still takes effect.
  var CURSOR_HIDE_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c]; // ESC [ ? 2 5 l
  var CURSOR_SHOW_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68]; // ESC [ ? 2 5 h
  var textEncoderForCoalesce = new TextEncoder();

  function bytesMatchAt(bytes, pos, pattern) {
    if (pos + pattern.length > bytes.length) return false;
    for (var k = 0; k < pattern.length; k++) {
      if (bytes[pos + k] !== pattern[k]) return false;
    }
    return true;
  }

  // Two-pass: first find which hide/show byte RANGES form a complete pair (a hide, and the
  // next show after it, however much real content sits between them), then copy everything
  // through except those paired ranges. This keeps content between a hide and its show
  // intact -- an earlier single-pass version wrongly rewound past that content instead of
  // just the toggle bytes, which would have silently dropped real terminal output.
  function coalesceCursorToggles(bytes) {
    var removeRanges = []; // committed [start, end) ranges to skip in the final copy
    var pendingRanges = []; // tentative ranges since the current hide-episode started
    var episodeOpen = false;
    var i = 0;
    while (i < bytes.length) {
      if (bytesMatchAt(bytes, i, CURSOR_HIDE_BYTES)) {
        pendingRanges.push([i, i + CURSOR_HIDE_BYTES.length]);
        episodeOpen = true;
        i += CURSOR_HIDE_BYTES.length;
        continue;
      }
      if (bytesMatchAt(bytes, i, CURSOR_SHOW_BYTES)) {
        if (episodeOpen) {
          pendingRanges.push([i, i + CURSOR_SHOW_BYTES.length]);
          removeRanges = removeRanges.concat(pendingRanges);
          pendingRanges = [];
          episodeOpen = false;
        }
        // else: no open hide to pair with -- leave this show untouched.
        i += CURSOR_SHOW_BYTES.length;
        continue;
      }
      i++;
    }
    if (!removeRanges.length) return bytes; // nothing paired -- return unchanged, no copy needed
    var keep = new Uint8Array(bytes.length);
    var outLen = 0;
    var rangeIdx = 0;
    var pos = 0;
    while (pos < bytes.length) {
      if (rangeIdx < removeRanges.length && pos === removeRanges[rangeIdx][0]) {
        pos = removeRanges[rangeIdx][1];
        rangeIdx++;
        continue;
      }
      keep[outLen++] = bytes[pos++];
    }
    return keep.subarray(0, outLen);
  }

  // Workspace direction change: the disappear/reappear itself is what reads as blink, not just a
  // fast one, so cursor-hide sequences are now stripped unconditionally -- matched with a show
  // or not -- instead of only in matched hide/show pairs (coalesceCursorToggles above is kept
  // in place, just no longer called from the write path, in case this approach needs reverting).
  // Cursor-show sequences are stripped too since they become pure no-ops once no hide can ever
  // reach term.write; nothing else in the stream is touched.
  function stripAllCursorHides(bytes) {
    var found = false;
    for (var scan = 0; scan < bytes.length; scan++) {
      if (bytesMatchAt(bytes, scan, CURSOR_HIDE_BYTES) || bytesMatchAt(bytes, scan, CURSOR_SHOW_BYTES)) {
        found = true;
        break;
      }
    }
    if (!found) return bytes; // nothing to strip -- return unchanged, no copy needed
    var keep = new Uint8Array(bytes.length);
    var outLen = 0;
    var i = 0;
    while (i < bytes.length) {
      if (bytesMatchAt(bytes, i, CURSOR_HIDE_BYTES)) { i += CURSOR_HIDE_BYTES.length; continue; }
      if (bytesMatchAt(bytes, i, CURSOR_SHOW_BYTES)) { i += CURSOR_SHOW_BYTES.length; continue; }
      keep[outLen++] = bytes[i++];
    }
    return keep.subarray(0, outLen);
  }

  function concatByteChunks(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  // Generic tab host: type "xterm" (pty over WS) or "desktop" (iframe body, VNC over the
  // backend's own /vnc bridge, opened via openDesktopTab below).
  function openTab(opts) {
    var planet = opts.planet;
    var session = opts.session;
    var kind = opts.kind;
    var type = opts.type || "xterm";
    var tabId = "tab-" + (++state.tabCounter);
    var ship = createShip(planet, session, type);
    var tab; // assigned below; referenced by closures created before it (fine, only fire later)

    var tabEl = document.createElement("div");
    tabEl.className = "drawer-tab";
    tabEl.dataset.tabId = tabId;

    var dotWrapEl = document.createElement("span");
    dotWrapEl.className = "tab-dot-wrap";
    var shipDotEl = document.createElement("span");
    var dotStatus = tabDotStatus(planet.kind, kind, type);
    shipDotEl.className = "tab-ship-dot"
      + (dotStatus.filled ? " filled" : "")
      + (dotStatus.ring ? " garrison-ring" : "");
    shipDotEl.style.setProperty("--dot-color", "var(" + dotStatus.colorVar + ")");
    dotWrapEl.appendChild(shipDotEl);
    dotWrapEl.addEventListener("mouseenter", function (evt) {
      showTooltipText(dotTooltipText(tab), evt.clientX, evt.clientY);
    });
    dotWrapEl.addEventListener("mousemove", function (evt) {
      showTooltipText(dotTooltipText(tab), evt.clientX, evt.clientY);
    });
    dotWrapEl.addEventListener("mouseleave", function () {
      hideShipTooltip();
    });
    tabEl.appendChild(dotWrapEl);

    var labelEl = document.createElement("span");
    labelEl.className = "tab-name";
    labelEl.textContent = autoTabLabel(planet, session, type, opts.labelOverride);
    labelEl.addEventListener("dblclick", function (evt) {
      evt.stopPropagation();
      beginRenameTab(tab, labelEl);
    });
    tabEl.appendChild(labelEl);

    var closeEl = document.createElement("span");
    closeEl.className = "tab-close";
    closeEl.textContent = "x";
    closeEl.addEventListener("click", function (evt) {
      evt.stopPropagation();
      requestTabClose(tab); // tab is assigned below, before this listener can ever fire
    });
    tabEl.appendChild(closeEl);

    tabEl.addEventListener("click", function () {
      activateTab(tabId);
    });

    els.drawerTabs.appendChild(tabEl);

    var paneEl = document.createElement("div");
    paneEl.className = "drawer-pane";
    els.drawerPanes.appendChild(paneEl);

    tab = {
      id: tabId,
      planetId: planet.id,
      planetName: planet.name,
      planetKind: planet.kind,
      session: session,
      kind: kind,
      type: type,
      label: labelEl.textContent,
      renaming: false,
      focusTimeoutId: null,
      quietCursorTimeoutId: null,
      ship: ship,
      term: null,
      fitAddon: null,
      lastSentCols: null,
      lastSentRows: null,
      lastMouseUpSelection: "", // see the mouseup-capture comment near attachCustomKeyEventHandler below
      ws: null,
      localSessionId: null, // local xterm tabs only -- server-assigned id, see handleLocalHello below
      iframeEl: null,
      tabEl: tabEl,
      paneEl: paneEl
    };
    state.terminalTabs.push(tab);

    if (type === "desktop") {
      var iframe = document.createElement("iframe");
      iframe.className = "tab-iframe";
      iframe.src = opts.desktopUrl || "about:blank";
      paneEl.appendChild(iframe);
      tab.iframeEl = iframe;

      expandDrawer();
      activateTab(tabId);
      applyTabFilter();
      return tab;
    }

    var wrapEl = document.createElement("div");
    wrapEl.className = "xterm-wrap";
    paneEl.appendChild(wrapEl);

    var term = new Terminal({
      // Measured live during a real codex "Working... esc to interrupt" spinner: the pty
      // output itself sends cursor hide/show (ESC[?25l / ESC[?25h) about 196 times per
      // second -- xterm has to honor those regardless of this cursorBlink setting, since
      // DECTCEM visibility and xterm's own decorative blink CSS animation are two separate
      // mechanisms. So this does not remove the app-driven toggling (that would need a
      // client-side debounce of rapid hide/show pairs, or the WebGL renderer). It does
      // remove xterm's OWN blink cycle (~1-2Hz) from ever compounding on top of that churn,
      // which is the safe, minimal change Use tried first.
      cursorBlink: false,
      fontSize: 13,
      fontFamily: "Cascadia Code, Consolas, Courier New, monospace",
      theme: {
        background: "#0b0f1a",
        foreground: "#d8e0f0",
        cursor: "#6ea8ff"
      }
    });
    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(wrapEl);
    tab.term = term;
    tab.fitAddon = fitAddon;

    // Keyboard copy/paste. Why this exists: tmux sessions now run with mouse mode on (see
    // the mouse-storm fix elsewhere in this file), so an ordinary mouse-drag selection is
    // consumed by tmux's own copy-mode buffer instead of becoming a browser selection -- the
    // keyboard is the only reliable path to the OS clipboard while mouse mode is active.
    // Shift+drag is the manual escape hatch: xterm.js's own selection handling takes over
    // whenever Shift is held during a drag, regardless of the app's requested mouse-reporting
    // mode (confirmed live against a real tmux session with htop actively requesting mouse
    // events: mousedown/mousemove correctly build the selection even with mouse-tracking on).
    //
    // BUT: measured live, xterm.js 5.3.0 has its own bug here. Whenever the terminal has an
    // active mouse-tracking app (coreMouseService.areMouseEventsActive), xterm's internal
    // Terminal.ts unconditionally forwards the mouseup event to that app the instant mouseup
    // fires (it only guards mouseDOWN against a forced selection, not mouseup) -- and sending
    // that fake "click" counts as user input, which triggers xterm's own onUserInput hook that
    // clears whatever selection was just made, a few lines before its OWN mouseup handler would
    // have finalized it. Traced with instrumented reads of the internal selection model: right
    // after mousemove, selectionStart/selectionEnd are correct; by the time our own keydown
    // handler runs afterward, term.getSelection() is back to "". This is a real upstream gap in
    // xterm, not something to patch in node_modules -- worked around here instead: a mouseup
    // listener on wrapEl registered with capture:true fires in the CAPTURE phase, strictly
    // before any of xterm's own listeners (which only run in the bubble phase further down at
    // the target element and at document), so it reads the selection while it's still intact
    // and caches it. Cleared on any other real keystroke (see attachCustomKeyEventHandler
    // below) so a long-past selection can never masquerade as a live one for a later,
    // unrelated Ctrl+C.
    wrapEl.addEventListener("mouseup", function () {
      var sel = term.getSelection();
      if (sel) tab.lastMouseUpSelection = sel;
    }, true);

    function currentSelection() {
      return term.getSelection() || tab.lastMouseUpSelection;
    }

    function copySelectionToClipboard() {
      var sel = currentSelection();
      if (!sel) return false;
      tab.lastMouseUpSelection = "";
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        showToast("Clipboard not available in this browser context");
        return true; // selection existed -- still swallow the key, just skip the copy itself
      }
      navigator.clipboard.writeText(sel).catch(function () {
        showToast("Copy to clipboard failed");
      });
      return true;
    }

    function pasteFromClipboard() {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast("Clipboard not available in this browser context");
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        if (text) term.paste(text); // bracketed paste mode, handled correctly by tmux/TUIs
      }).catch(function () {
        showToast("Paste from clipboard failed (browser permission?)");
      });
    }

    term.attachCustomKeyEventHandler(function (evt) {
      if (evt.type !== "keydown") return true;
      var code = evt.code; // physical key, so Shift flipping case of evt.key can't matter here
      // A modifier pressed alone (Control goes down before the letter that completes a chord
      // like Ctrl+Shift+C) is its own keydown and never reaches the pty by itself -- excluded
      // from the catch-all cache-invalidation below, otherwise it wipes the cache before the
      // letter key even arrives.
      var isBareModifier = code === "ControlLeft" || code === "ControlRight" ||
        code === "ShiftLeft" || code === "ShiftRight" ||
        code === "AltLeft" || code === "AltRight" ||
        code === "MetaLeft" || code === "MetaRight";

      if (evt.ctrlKey && code === "KeyC" && evt.shiftKey) {
        // Ctrl+Shift+C: copy if there's a selection; otherwise there is nothing this
        // combination does in a terminal, so let it fall through untouched.
        return !copySelectionToClipboard();
      }
      if (evt.ctrlKey && code === "KeyC" && !evt.shiftKey) {
        // Plain Ctrl+C: VS Code convention -- copy an existing selection instead of sending
        // the interrupt; with no selection, pass through so it still interrupts a running
        // command exactly as before.
        var hadSelection = currentSelection().length > 0;
        if (hadSelection) { copySelectionToClipboard(); return false; }
        tab.lastMouseUpSelection = ""; // real interrupt about to fire -- any stale cache is stale
        return true;
      }
      if (evt.ctrlKey && code === "KeyV") {
        // Ctrl+V and Ctrl+Shift+V both paste -- shift has no separate meaning here.
        pasteFromClipboard();
        return false;
      }

      // Any other real keystroke about to reach the pty invalidates a cached mouseup
      // selection -- a selection from several actions ago must never masquerade as live for
      // a later, unrelated Ctrl+C. (This can't live in term.onData: xterm's own synthetic
      // mouse-forwarding data -- not just literal typing -- also flows through onData, and
      // would wipe the cache in the very same event cycle that sets it; see the wrapEl
      // mouseup-capture comment above.)
      if (!isBareModifier) tab.lastMouseUpSelection = "";
      return true;
    });

    // Confirmed live (Playwright + real codex resume TUI): a single hard wheel notch
    // (deltaY=120, a standard browser "one click" value) gets turned by xterm's own
    // alternate-scroll handling into EIGHT stacked ESC[B (down-arrow) sequences sent
    // straight to the pty, because the alt-screen buffer has no real scrollback of its own
    // -- xterm falls back to feeding the app synthetic arrow keys instead. A real mouse or
    // trackpad firing a fast burst of wheel events (momentum scroll, a free-spinning wheel)
    // turns into dozens of arrow-key presses in under a second, which is exactly what read
    // as "the picker scrolls up and down without end" -- this fires on ANY full-screen app
    // that has switched to the alt buffer, matching both codex resume and python-in-codex.
    // Mouse reporting itself stays on (TUIs legitimately depend on it) -- this only clamps
    // and throttles the ALT-BUFFER wheel-to-arrow-key conversion specifically; normal
    // scrollback wheel behavior in the primary buffer (a plain shell) is untouched.
    var ALT_WHEEL_MAX_DELTA = 40;       // caps a single event to roughly 2-3 arrow keys, not 8+
    var ALT_WHEEL_MIN_INTERVAL_MS = 70; // swallows anything faster than this while alt-buffer is active
    var lastAltWheelTime = 0;
    wrapEl.addEventListener("wheel", function (evt) {
      if (evt.__altWheelClamped) return; // our own re-dispatched, already-clamped copy -- let it through untouched
      if (term.buffer.active.type !== "alternate") return; // primary buffer: leave real scrollback alone
      var now = performance.now();
      var tooSoon = now - lastAltWheelTime < ALT_WHEEL_MIN_INTERVAL_MS;
      var over = Math.abs(evt.deltaY) > ALT_WHEEL_MAX_DELTA;
      if (!tooSoon && !over) return; // small, well-spaced tick -- pass through as-is
      evt.preventDefault();
      evt.stopImmediatePropagation();
      if (tooSoon) return; // too soon after the last one; drop it entirely
      lastAltWheelTime = now;
      var clamped = new WheelEvent("wheel", {
        deltaX: evt.deltaX,
        deltaY: Math.sign(evt.deltaY) * Math.min(Math.abs(evt.deltaY), ALT_WHEEL_MAX_DELTA),
        deltaZ: evt.deltaZ, deltaMode: evt.deltaMode,
        clientX: evt.clientX, clientY: evt.clientY,
        bubbles: true, cancelable: true
      });
      clamped.__altWheelClamped = true;
      evt.target.dispatchEvent(clamped);
    }, { capture: true, passive: false });

    expandDrawer();
    activateTab(tabId);

    // backend-2's fix (pty-bridge.js now spawns at whatever cols/rows the connect URL
    // provides, falling back to 80x24 only if absent) needs the client to know its real
    // size BEFORE opening the socket. fitAddon.fit() has to run after expandDrawer()/
    // activateTab() above, not right after term.open(wrapEl): the drawer pane is
    // display:none until activateTab adds the "active" class, and fitting an invisible,
    // zero-size element measures garbage. sendResize()'s own fit() call in ws.onopen still
    // runs as before and is a no-op if this measurement already matches (lastSentCols/Rows).
    fitAddon.fit();

    // Local xterm tabs: if this planetId+session already has a live server
    // sessionId from a previous load (see restoreLocalTerminalTabs / a plain
    // in-page reopen), send it as sid so pty-bridge.js reattaches to the SAME
    // detached pty instead of spawning a fresh shell. Remote/tmux tabs never
    // set this -- session name alone is already the reattach key there.
    var isLocalXterm = type === "xterm" && planet.kind === "local";
    var persistedLocalSession = isLocalXterm ? findLocalTermSession(planet.id, session) : null;
    if (persistedLocalSession) tab.localSessionId = persistedLocalSession.sessionId;

    var wsPath = "/term?planet=" + encodeURIComponent(planet.id) + "&session=" + encodeURIComponent(session) + "&cols=" + term.cols + "&rows=" + term.rows;
    if (isLocalXterm && tab.localSessionId) {
      wsPath += "&sid=" + encodeURIComponent(tab.localSessionId);
    }
    var ws = new WebSocket(wsUrl(wsPath));
    ws.binaryType = "arraybuffer";
    tab.ws = ws;

    // Local-only control message from pty-bridge.js's attachLocal: confirms the
    // (possibly new) server sessionId for this tab, so it survives a reload.
    // Persisted under planetId+session, same key used to look it up above.
    function handleLocalHello(ctrl) {
      tab.localSessionId = ctrl.sessionId;
      upsertLocalTermSession(planet.id, session, ctrl.sessionId, tab.label);
    }

    ws.onopen = function () {
      sendResize(tab);
    };
    // A busy TUI (codex streaming a response) pushes many small WS messages in quick
    // succession; writing each one to xterm the instant it arrives means the DOM renderer's
    // cursor-blink state can get perturbed mid-cycle by a write that lands between two blink
    // toggles, which reads as the cursor-line flashing. Queue chunks and flush once per
    // animation frame instead of one write() per WS message -- this caps redraws to once per
    // paint regardless of how many messages arrived in between.
    //
    // On a real codex session resume (large transcript replay), measured live: a single
    // unthrottled flush can gather up to 88 separate chunks / ~65KB and write all of it in
    // one animation frame. term.write() is effectively synchronous, so the browser paints
    // nothing in between -- the screen jumps straight from the pre-flush state to the fully
    // caught-up state, which is very likely what reads as "scrolling wildly" even though the
    // measured scroll position itself never actually oscillates. WRITE_BYTE_BUDGET_PER_FRAME
    // caps how much a single frame is allowed to apply; anything past the budget (including
    // splitting a single oversized chunk) carries over to the next animation frame instead of
    // landing all at once.
    //
    // Before that budget split, the whole frame's assembled bytes go through
    // stripAllCursorHides (see above openTab), which now removes every cursor-hide sequence
    // outright (matched with a show or not) so the cursor never disappears at all -- this is
    // what actually kills the flicker itself, not just the resume-load jump.
    var WRITE_BYTE_BUDGET_PER_FRAME = 65536;
    var writeQueue = [];
    var writeFlushScheduled = false;

    // Quiet-cursor: the coalescer above removes redundant hide/show pairs, but it can't do
    // anything about a cursor that is legitimately visible and being relocated by the app
    // itself many times a second (codex's spinner moves it between the status line and the
    // input line ~200x/sec per the escape tally). A rectangle jumping between two spots every
    // animation frame reads as flicker on its own, no hide/show required. So: fade the cursor
    // out via CSS while real output bursts are landing, and let it fade back in ~300ms after
    // things go quiet.
    //
    // A per-write BYTE threshold turned out not to separate the two cases: measured live,
    // single-keystroke echo at a plain PowerShell prompt (PSReadLine redraws the whole line
    // per keystroke) runs up to ~200 bytes on a long line, while individual writes during a
    // real codex spinner burst average only ~94 bytes and are mostly under 200 -- the size
    // ranges overlap completely, so no fixed cutoff reliably tells "one keystroke" from "one
    // tick of the burst." What actually differs is FREQUENCY: a keystroke produces one write
    // and then goes quiet; a burst produces many writes per second, sustained. So arming is
    // gated on a rolling count of real writes in the trailing window, not on any single
    // write's size.
    //
    // First calibration (300ms window / 4 writes) was measured against the codex burst only
    // and shipped without checking ordinary typing -- live re-test at a plain prompt found it
    // false-positived on completely normal human typing: PSReadLine's one-write-per-keystroke
    // echo lands close enough to its own animation frame that 90ms/key (a brisk ~130 WPM)
    // already crosses 4 writes in 300ms, hiding the cursor while someone is just typing.
    // Re-measured with instrumented write timestamps: a real codex spinner burst sustains
    // ~32ms between writes (pinned near the 16.6ms rAF frame rate), while even fast human
    // typing (50ms/key, ~240 WPM) sits at ~85ms+ between writes -- a real gap, but not a huge
    // one, since both are ultimately bounded above by the same per-frame flush. 600ms/14
    // (requires ~43ms sustained average spacing) was verified to stay fully clear through
    // 240 WPM typing while still reliably arming within the first ~450ms of a real burst;
    // only a sustained 300+ WPM typing burst (no human types this) still crosses it, and even
    // then briefly. Widening further to chase that edge case risks missing short codex bursts
    // (e.g. brief tool-call output) instead, so this is the deliberate trade-off point.
    //
    // Workspace direction change: he identified the disappear/reappear itself (not just a fast one)
    // as the perceived blink, so the fix moved to stripAllCursorHides above -- the cursor now
    // never hides at all, which makes fading it out here redundant. Disabled via the flag below
    // rather than deleted, in case that approach needs to be reverted; CSS and all the framing
    // above stay in place either way.
    var QUIET_CURSOR_ENABLED = false;
    var QUIET_CURSOR_WINDOW_MS = 600;
    var QUIET_CURSOR_BURST_FLUSHES = 14; // real writes within the window before we call it a burst
    var QUIET_CURSOR_QUIET_MS = 300;
    var quietCursorFlushTimes = [];
    function noteWriteForQuietCursor() {
      if (!QUIET_CURSOR_ENABLED) return;
      var now = performance.now();
      quietCursorFlushTimes.push(now);
      while (quietCursorFlushTimes.length && now - quietCursorFlushTimes[0] > QUIET_CURSOR_WINDOW_MS) {
        quietCursorFlushTimes.shift();
      }
      if (quietCursorFlushTimes.length >= QUIET_CURSOR_BURST_FLUSHES) {
        armQuietCursor();
      }
    }
    function armQuietCursor() {
      wrapEl.classList.add("quiet-cursor");
      if (tab.quietCursorTimeoutId) {
        clearTimeout(tab.quietCursorTimeoutId);
      }
      tab.quietCursorTimeoutId = setTimeout(function () {
        tab.quietCursorTimeoutId = null;
        wrapEl.classList.remove("quiet-cursor");
      }, QUIET_CURSOR_QUIET_MS);
    }

    function flushWriteQueue() {
      writeFlushScheduled = false;
      if (!writeQueue.length) return;
      var raw = writeQueue.map(function (chunk) {
        return typeof chunk === "string" ? textEncoderForCoalesce.encode(chunk) : chunk;
      });
      var combined = stripAllCursorHides(concatByteChunks(raw));
      writeQueue = [];
      if (!combined.length) return;
      noteWriteForQuietCursor();
      if (combined.length <= WRITE_BYTE_BUDGET_PER_FRAME) {
        term.write(combined);
      } else {
        term.write(combined.subarray(0, WRITE_BYTE_BUDGET_PER_FRAME));
        // Already coalesced -- carries over untouched, no need to re-run the coalescer on it.
        writeQueue.push(combined.subarray(WRITE_BYTE_BUDGET_PER_FRAME));
        writeFlushScheduled = true;
        requestAnimationFrame(flushWriteQueue);
      }
    }
    ws.onmessage = function (evt) {
      // pty-bridge.js's local path (attachLocal) sends control messages as JSON
      // text frames ('hello' on (re)attach) and all pty output as binary frames,
      // so a text frame there is ALWAYS control, never terminal data. The remote
      // path is untouched and still sends pty output as plain text frames, so a
      // text frame there is real output almost always -- only reinterpreted as
      // control if it happens to parse as a JSON object carrying a "type" field,
      // which real shell output essentially never does. Either way: recognized
      // control frames are consumed here and never reach the terminal write path.
      if (typeof evt.data === "string") {
        var ctrl = null;
        try { ctrl = JSON.parse(evt.data); } catch (e) { ctrl = null; }
        if (ctrl && typeof ctrl === "object" && typeof ctrl.type === "string") {
          if (ctrl.type === "hello") handleLocalHello(ctrl);
          return;
        }
      }
      writeQueue.push(typeof evt.data === "string" ? evt.data : new Uint8Array(evt.data));
      if (!writeFlushScheduled) {
        writeFlushScheduled = true;
        requestAnimationFrame(flushWriteQueue);
      }
    };
    ws.onclose = function () {
      term.write("\r\n[connection closed]\r\n");
    };
    ws.onerror = function () {
      term.write("\r\n[connection error]\r\n");
    };

    term.onData(function (data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    applyTabFilter();
    return tab;
  }

  function openTerminalTab(planet, session, kind, labelOverride) {
    var existing = findTerminalTab(planet.id, session);
    if (existing) {
      activateTab(existing.id);
      expandDrawer();
      return existing;
    }
    return openTab({ planet: planet, session: session, kind: kind, type: "xterm", labelOverride: labelOverride });
  }

  // Desktop button (enabled only when planet.doors includes "desktop") opens a VNC
  // session in an iframe tab, served by the backend's own /vnc bridge + desktop.html.
  function openDesktopTab(planet, desktopUrl) {
    var existing = findTerminalTab(planet.id, "desktop");
    if (existing) {
      activateTab(existing.id);
      expandDrawer();
      return existing;
    }
    return openTab({ planet: planet, session: "desktop", kind: "visitor", type: "desktop", desktopUrl: desktopUrl });
  }

  // The sun isn't a planet, so this bypasses openTab()'s ship creation entirely: a plain
  // drawer tab with a read-only <pre> pane fed by GET /api/sun/doc. Re-clicking the sun
  // while the tab is already open just focuses it instead of opening a second copy.
  function openSunDocTab() {
    if (state.sunDocTabId) {
      var existing = findTabById(state.sunDocTabId);
      if (existing) {
        activateTab(state.sunDocTabId);
        expandDrawer();
        return existing;
      }
      state.sunDocTabId = null;
    }

    var sunName = state.config.sunName || "Workspace";
    var tabId = "tab-" + (++state.tabCounter);

    var tabEl = document.createElement("div");
    tabEl.className = "drawer-tab";
    tabEl.dataset.tabId = tabId;

    var labelEl = document.createElement("span");
    labelEl.textContent = sunName;
    tabEl.appendChild(labelEl);

    var closeEl = document.createElement("span");
    closeEl.className = "tab-close";
    closeEl.textContent = "x";
    closeEl.addEventListener("click", function (evt) {
      evt.stopPropagation();
      closeTerminalTab(tabId);
    });
    tabEl.appendChild(closeEl);

    tabEl.addEventListener("click", function () {
      activateTab(tabId);
    });
    els.drawerTabs.appendChild(tabEl);

    var paneEl = document.createElement("div");
    paneEl.className = "drawer-pane";
    var preEl = document.createElement("pre");
    preEl.className = "sun-doc-content";
    preEl.textContent = "Loading...";
    paneEl.appendChild(preEl);
    els.drawerPanes.appendChild(paneEl);

    var tab = {
      id: tabId,
      planetId: null,
      session: "doc",
      kind: "visitor",
      type: "doc",
      ship: null,
      term: null,
      fitAddon: null,
      ws: null,
      iframeEl: null,
      tabEl: tabEl,
      paneEl: paneEl
    };
    state.terminalTabs.push(tab);
    state.sunDocTabId = tabId;

    expandDrawer();
    activateTab(tabId);
    applyTabFilter();

    apiGetSunDoc().then(function (doc) {
      preEl.textContent = doc.content || "(empty)";
    }).catch(function (err) {
      preEl.textContent = "Could not load document: " + err.message;
    });

    return tab;
  }

  function sendResize(tab) {
    if (tab.type !== "xterm" || !tab.term || !tab.fitAddon) return;
    tab.fitAddon.fit();
    // Every call site here (ws.onopen, activateTab's tab-switch timer, the drawer-toggle
    // timer) fires on its own schedule and none of them know whether the layout actually
    // changed since the last send. Re-sending the SAME cols/rows is not a no-op on the far
    // side: pty-bridge.js applies it to the real pty (node-pty/ConPTY) every time, and a
    // full-screen TUI (confirmed live with codex's "resume" picker) reacts to each redundant
    // resize with another incremental repaint that does not fully clear the row first --
    // repeated identical resizes visibly corrupted rows (old and new text overlapping) and
    // the corruption did not self-heal, which is what read as "scrolling like crazy" to Workspace.
    // Skipping the send when nothing changed removes the redundant repaints at the source.
    if (tab.term.cols === tab.lastSentCols && tab.term.rows === tab.lastSentRows) return;
    if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
      tab.ws.send(JSON.stringify({ type: "resize", cols: tab.term.cols, rows: tab.term.rows }));
      tab.lastSentCols = tab.term.cols;
      tab.lastSentRows = tab.term.rows;
    }
  }

  function activateTab(tabId) {
    state.activeTabId = tabId;
    state.terminalTabs.forEach(function (tab) {
      var active = (tab.id === tabId);
      tab.tabEl.classList.toggle("active", active);
      tab.paneEl.classList.toggle("active", active);
      if (active && tab.type === "xterm" && tab.term) {
        // A double-click's two constituent native clicks both land here (each schedules
        // this same 30ms callback) before the dblclick handler ever runs, so this handle
        // is stashed on the tab; beginRenameTab clearTimeouts it the moment a rename
        // starts, so a stale callback can never fire and steal focus back from the rename
        // input. The tab.renaming check below is belt-and-braces for any other path that
        // might schedule a focus this way in the future.
        if (tab.focusTimeoutId) clearTimeout(tab.focusTimeoutId);
        tab.focusTimeoutId = setTimeout(function () {
          tab.focusTimeoutId = null;
          if (tab.renaming) return;
          tab.fitAddon.fit();
          sendResize(tab);
          tab.term.focus();
        }, 30);
      }
    });
  }

  // Frontend-only teardown (dot/pane/ws/term), always safe to call regardless of whether
  // the planet's own tmux session lives or dies -- that decision is made by the caller
  // (see requestTabClose/the close-tab popup below) and communicated here via opts.toast:
  // undefined keeps this function's own default per-tab-type message (only still reachable
  // for desktop/local/doc tabs, and as a fallback if something calls this directly), a
  // string overrides it, null suppresses it entirely (caller is showing its own toast).
  function closeTerminalTab(tabId, opts) {
    opts = opts || {};
    var idx = -1;
    var tab = null;
    for (var i = 0; i < state.terminalTabs.length; i++) {
      if (state.terminalTabs[i].id === tabId) {
        idx = i;
        tab = state.terminalTabs[i];
        break;
      }
    }
    if (!tab) return;

    if (tab.ship) {
      state.closingShips.push({ ship: tab.ship, closingSince: performance.now() });
    }
    if (state.hoveredShipTabId === tabId) {
      state.hoveredShipTabId = null;
      hideShipTooltip();
    }
    if (state.sunDocTabId === tabId) {
      state.sunDocTabId = null;
    }

    if (tab.focusTimeoutId) {
      clearTimeout(tab.focusTimeoutId);
      tab.focusTimeoutId = null;
    }
    if (tab.quietCursorTimeoutId) {
      clearTimeout(tab.quietCursorTimeoutId);
      tab.quietCursorTimeoutId = null;
    }
    var isLocalXterm = tab.type === "xterm" && tab.planetKind === "local";
    if (tab.ws) {
      if (isLocalXterm) {
        // Explicit tab-close ("x") is the one path that still really kills a
        // local shell -- everything else (refresh, network drop) now only
        // detaches server-side (see pty-bridge.js's attachLocal). ws.close()
        // alone no longer implies a kill, so send it explicitly first.
        if (tab.ws.readyState === WebSocket.OPEN) {
          try { tab.ws.send(JSON.stringify({ type: "kill" })); } catch (e) { /* ws.close() below still runs */ }
        }
        removeLocalTermSession(tab.planetId, tab.session);
      }
      tab.ws.close();
    }
    if (tab.term) {
      tab.term.dispose();
    }
    tab.tabEl.remove();
    tab.paneEl.remove();
    state.terminalTabs.splice(idx, 1);

    var message;
    if ("toast" in opts) {
      message = opts.toast;
    } else if (tab.type === "doc") {
      message = null; // closing the memory doc needs no toast, nothing on the planet is affected
    } else if (tab.type === "desktop") {
      message = "Desktop view closed. The VNC session on the planet is untouched.";
    } else if (tab.kind === "garrison") {
      message = "Tab closed. Session " + tab.session + " keeps running on the planet, disconnected only.";
    } else if (isLocalXterm) {
      message = "Tab closed. Local shell ended.";
    } else {
      message = "Tab closed. Session " + tab.session + " stays alive on the planet until the planet says otherwise.";
    }
    if (message) showToast(message);

    if (state.activeTabId === tabId) {
      state.activeTabId = null;
    }
    applyTabFilter(); // picks the next visible tab under the current filter, if any
  }

  // Tmux-backed remote tabs (garrison, or a non-local visitor xterm session) have a real
  // session on the planet that outlives the tab by default -- desktop (VNC) and local-shell
  // tabs have nothing tmux-backed to keep alive, so they skip the close-tab popup entirely.
  function isTmuxBackedTab(tab) {
    if (tab.type !== "xterm") return false;
    if (tab.planetKind === "local") return false;
    return true;
  }

  var CLOSE_TAB_KEEP_ALIVE_KEY = "galaxyCloseTabKeepAliveDefault";

  function loadCloseTabKeepAliveDefault() {
    try { return localStorage.getItem(CLOSE_TAB_KEEP_ALIVE_KEY) === "1"; } catch (e) { return false; }
  }

  function persistCloseTabKeepAliveDefault() {
    try { localStorage.setItem(CLOSE_TAB_KEEP_ALIVE_KEY, "1"); } catch (e) { /* private mode etc, non-fatal */ }
  }

  var KEEP_ALIVE_TOAST = "The tmux is active, click the base in the left panel to return here.";

  // Entry point for every tab-close click. Desktop/local tabs close immediately, exactly as
  // before. Tmux-backed tabs either close silently as a keep-alive (once the user has ticked
  // "do not show me this again") or show the popup so the choice is explicit every time.
  function requestTabClose(tab) {
    if (!isTmuxBackedTab(tab)) {
      closeTerminalTab(tab.id);
      return;
    }
    if (loadCloseTabKeepAliveDefault()) {
      closeTerminalTab(tab.id, { toast: KEEP_ALIVE_TOAST });
      return;
    }
    showCloseTabPopup(tab);
  }

  function showCloseTabPopup(tab) {
    state.pendingCloseTabId = tab.id;
    els.closeTabPopupCheckbox.checked = false;
    els.closeTabPopup.classList.remove("hidden");
  }

  function hideCloseTabPopup() {
    els.closeTabPopup.classList.add("hidden");
    state.pendingCloseTabId = null;
  }

  function resolveCloseTabPopup(keepAlive) {
    var tabId = state.pendingCloseTabId;
    if (!tabId) { hideCloseTabPopup(); return; }
    var tab = null;
    for (var i = 0; i < state.terminalTabs.length; i++) {
      if (state.terminalTabs[i].id === tabId) { tab = state.terminalTabs[i]; break; }
    }
    var rememberChoice = els.closeTabPopupCheckbox.checked;
    hideCloseTabPopup();
    if (!tab) return;

    if (rememberChoice) persistCloseTabKeepAliveDefault();

    if (keepAlive) {
      closeTerminalTab(tab.id, { toast: KEEP_ALIVE_TOAST });
      return;
    }

    var planetName = tab.planetName;
    var sessionName = tab.session;
    apiRemoveBase(tab.planetId, sessionName).then(function (result) {
      if (result && result.ok) {
        closeTerminalTab(tab.id, { toast: "Base " + sessionName + " removed." });
        refreshPlanetsFromServer(); // picks up the now-gone base in the BASES list too
      } else {
        var reason = (result && result.error) || "unknown error";
        closeTerminalTab(tab.id, { toast: "Remove failed: " + reason + ". Tab closed, session may still be running on " + planetName + "." });
      }
    }).catch(function (err) {
      var reason = (err && err.notImplemented) ? "Remove not available yet." : "Remove failed: " + (err && err.message ? err.message : "network error") + ".";
      closeTerminalTab(tab.id, { toast: reason + " Tab closed, session may still be running on " + planetName + "." });
    });
  }

  function wireCloseTabPopup() {
    els.closeTabPopupYes.addEventListener("click", function (evt) {
      evt.stopPropagation();
      resolveCloseTabPopup(true);
    });
    els.closeTabPopupNo.addEventListener("click", function (evt) {
      evt.stopPropagation();
      resolveCloseTabPopup(false);
    });
  }

  function expandDrawer() {
    els.terminalDrawer.classList.remove("collapsed");
    state.drawerCollapsed = false;
    refitMapArea(); // opening the drawer shrinks the visible map strip -- refit orbits now
  }

  function toggleDrawer() {
    if (state.drawerFullscreen) return; // collapse/expand only applies to split view; use Show Map / Exit Fullscreen instead
    if (state.drawerExpanded) return; // in tall mode, only the dedicated "^"/"v" toggle applies -- avoids stacking "collapsed" on top of "expanded"
    state.drawerCollapsed = !state.drawerCollapsed;
    els.terminalDrawer.classList.toggle("collapsed", state.drawerCollapsed);
    refitMapArea(); // drawer height just changed either way -- refit the map to the new strip
    if (!state.drawerCollapsed && state.activeTabId) {
      var tab = state.terminalTabs.filter(function (t) { return t.id === state.activeTabId; })[0];
      if (tab) {
        setTimeout(function () { sendResize(tab); }, 250);
      }
    }
  }

  function activeTerminalTab() {
    return state.terminalTabs.filter(function (t) { return t.id === state.activeTabId; })[0] || null;
  }

  function resizeActiveTabSoon() {
    setTimeout(function () {
      var tab = activeTerminalTab();
      if (tab) sendResize(tab);
    }, 60);
  }

  function enterFullscreen() {
    if (state.drawerFullscreen) return;
    if (state.drawerExpanded) exitDrawerExpanded(); // fullscreen fully supersedes tall mode
    state.drawerFullscreen = true;
    state.drawerCollapsed = false;
    els.terminalDrawer.classList.remove("collapsed");
    els.terminalDrawer.classList.add("fullscreen");
    state.canvas.style.display = "none";
    els.galaxySidebar.style.display = "none";
    els.btnMapFit.style.display = "none";
    els.btnDrawerFullscreen.textContent = "Exit Fullscreen";
    pauseRender();
    resizeActiveTabSoon();
  }

  function exitFullscreen() {
    if (!state.drawerFullscreen) return;
    state.drawerFullscreen = false;
    els.terminalDrawer.classList.remove("fullscreen");
    state.canvas.style.display = "";
    els.galaxySidebar.style.display = "";
    els.btnMapFit.style.display = "";
    els.btnDrawerFullscreen.textContent = "Fullscreen";
    refitMapArea(); // the map was hidden the whole time; refit before it's shown again
    resumeRender();
    resizeActiveTabSoon();
  }

  function toggleDrawerFullscreen() {
    if (state.drawerFullscreen) exitFullscreen(); else enterFullscreen();
  }

  // "^" tall mode: the terminal fills the whole right-side height (map area collapses to
  // nothing, same idea as Fullscreen) but, unlike Fullscreen, the left sidebar is left
  // completely alone -- no display toggling, no width change, it stays visible and
  // functional, only via its own existing "<" collapse button. Purely a CSS height swap on
  // .terminal-drawer (left/right are unchanged, so it never reaches under the sidebar) plus
  // the same pauseRender()/resumeRender() "stop advancing while hidden" pattern Fullscreen
  // already uses, since the map is just as invisible here (fully covered) even though the
  // canvas element itself is never hidden.
  function enterDrawerExpanded() {
    if (state.drawerFullscreen || state.drawerExpanded) return;
    state.drawerExpanded = true;
    state.drawerCollapsed = false;
    els.terminalDrawer.classList.remove("collapsed");
    els.terminalDrawer.classList.add("expanded");
    els.drawerToggle.textContent = "v";
    els.drawerToggle.title = "Restore split view";
    refitMapArea(); // map area is now fully covered -- keep it consistent for when it reopens
    pauseRender();
    resizeActiveTabSoon(); // fit() has to run after the drawer is actually taller, not before
  }

  function exitDrawerExpanded() {
    if (!state.drawerExpanded) return;
    state.drawerExpanded = false;
    els.terminalDrawer.classList.remove("expanded");
    els.drawerToggle.textContent = "^";
    els.drawerToggle.title = "Expand terminal";
    refitMapArea(); // map was fully covered the whole time -- refit before it's visible again
    resumeRender();
    resizeActiveTabSoon(); // fit() has to run after the drawer is back to split height, not before
  }

  function toggleDrawerExpanded() {
    if (state.drawerFullscreen) return; // tall mode only applies to split view, same guard as toggleDrawer
    if (state.drawerExpanded) exitDrawerExpanded(); else enterDrawerExpanded();
  }

  function showToast(text) {
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    els.toastStack.appendChild(toast);
    requestAnimationFrame(function () {
      toast.classList.add("visible");
    });
    setTimeout(function () {
      toast.classList.remove("visible");
      setTimeout(function () { toast.remove(); }, 250);
    }, 3800);
  }

  /* ======================================================================
   * WS EVENTS (status updates)
   * ==================================================================== */

  function connectEventsWs() {
    var ws;
    try {
      ws = new WebSocket(wsUrl("/events"));
    } catch (e) {
      scheduleEventsReconnect();
      return;
    }
    state.eventsWs = ws;

    ws.onopen = function () {
      state.eventsReconnectDelay = 1000;
    };

    ws.onmessage = function (evt) {
      var msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      if (msg.type === "status" && Array.isArray(msg.planets)) {
        applyStatusUpdate(msg.planets);
      }
    };

    ws.onclose = function () {
      scheduleEventsReconnect();
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  function scheduleEventsReconnect() {
    setTimeout(function () {
      connectEventsWs();
    }, state.eventsReconnectDelay);
    state.eventsReconnectDelay = Math.min(state.eventsReconnectDelay * 2, 30000);
  }

  function applyStatusUpdate(updates) {
    updates.forEach(function (update) {
      var planet = findPlanet(update.id);
      if (planet) {
        planet.status = update.status;
        updateRowStatus(planet);
      }
    });
  }

  /* ======================================================================
   * INIT
   * ==================================================================== */

  function cacheEls() {
    els.offlineBanner = document.getElementById("offline-banner");
    els.galaxySidebar = document.getElementById("galaxy-sidebar");
    els.btnSidebarCollapse = document.getElementById("btn-sidebar-collapse");
    els.sidebarOfflineNote = document.getElementById("sidebar-offline-note");
    els.treeList = document.getElementById("tree-list");
    els.terminalDrawer = document.getElementById("terminal-drawer");
    els.drawerHandle = document.getElementById("drawer-handle");
    els.drawerToggle = document.getElementById("drawer-toggle");
    els.drawerTabs = document.getElementById("drawer-tabs");
    els.drawerPanes = document.getElementById("drawer-panes");
    els.toastStack = document.getElementById("toast-stack");
    els.btnDrawerFullscreen = document.getElementById("btn-drawer-fullscreen");
    els.shipTooltip = document.getElementById("ship-tooltip");
    els.btnMapFit = document.getElementById("btn-map-fit");
    els.btnMapAlign = document.getElementById("btn-map-align");
    els.btnMapFreeze = document.getElementById("btn-map-freeze");
    els.btnMapRenderer = document.getElementById("btn-map-renderer");
    els.canvas3d = document.getElementById("galaxy-canvas-3d");
    els.btnTabFilterToggle = document.getElementById("btn-tab-filter-toggle");
    els.drawerEmptyNote = document.getElementById("drawer-empty-note");
    els.sidebarTitle = document.getElementById("sidebar-title");
    els.sidebarTitleInput = document.getElementById("sidebar-title-input");
    els.btnAddWorld = document.getElementById("btn-add-world");
    els.addWorldForm = document.getElementById("add-world-form");
    els.addWorldName = document.getElementById("add-world-name");
    els.addWorldSsh = document.getElementById("add-world-ssh");
    els.btnAddWorldCreate = document.getElementById("btn-add-world-create");
    els.btnAddWorldCancel = document.getElementById("btn-add-world-cancel");
    els.archivedSection = document.getElementById("archived-section");
    els.archivedHeader = document.getElementById("archived-header");
    els.archivedList = document.getElementById("archived-list");
    els.closeTabPopup = document.getElementById("close-tab-popup");
    els.closeTabPopupCheckbox = document.getElementById("close-tab-popup-checkbox");
    els.closeTabPopupYes = document.getElementById("close-tab-popup-yes");
    els.closeTabPopupNo = document.getElementById("close-tab-popup-no");
  }

  function wireStaticEvents() {
    els.drawerHandle.addEventListener("click", toggleDrawer);
    els.drawerToggle.addEventListener("click", function (evt) {
      evt.stopPropagation(); // otherwise this also bubbles into drawerHandle's own toggleDrawer
      toggleDrawerExpanded();
    });
    els.btnDrawerFullscreen.addEventListener("click", function (evt) {
      evt.stopPropagation();
      toggleDrawerFullscreen();
    });
    els.btnSidebarCollapse.addEventListener("click", function (evt) {
      evt.stopPropagation();
      toggleSidebarCollapse();
    });
    els.btnMapFit.addEventListener("click", function () {
      resetView(); // 2D fit always runs so switching back to 2D still lands on a sane view
      if (state.render3d) state.render3d.resetCamera();
    });
    els.btnMapAlign.addEventListener("click", triggerAlign);
    els.btnMapFreeze.addEventListener("click", toggleFreeze);
    els.btnMapRenderer.addEventListener("click", toggleRender3D);
    els.btnTabFilterToggle.addEventListener("click", function (evt) {
      evt.stopPropagation();
      state.showAllTabs = !state.showAllTabs;
      applyTabFilter();
    });
    els.archivedHeader.addEventListener("click", function () {
      els.archivedList.classList.toggle("hidden");
    });
    document.addEventListener("keydown", function (evt) {
      if (evt.key === "Escape") closeManifestPin();
    });
    wireSidebarTitleEdit();
    wireAddWorldForm();
    wireCloseTabPopup();
  }

  /* ---- Tree header: editable title (config.treeTitle) + add-world form ---- */

  // Hiding a focused input (classList.add("hidden")) fires a synchronous blur on it, same
  // as beginRenamePlanet's node removal below -- here that just re-enters cancelTitleEdit
  // via the blur listener rather than throwing (classList toggling is idempotent, unlike
  // replaceWith), but titleEditSettled still short-circuits the redundant second call.
  var titleEditSettled = true;

  function wireSidebarTitleEdit() {
    els.sidebarTitle.addEventListener("click", function () {
      titleEditSettled = false;
      els.sidebarTitleInput.value = els.sidebarTitle.textContent;
      els.sidebarTitle.classList.add("hidden");
      els.sidebarTitleInput.classList.remove("hidden");
      els.sidebarTitleInput.focus();
      els.sidebarTitleInput.select();
    });
    els.sidebarTitleInput.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); commitTitleEdit(); }
      else if (evt.key === "Escape") { evt.preventDefault(); cancelTitleEdit(); }
    });
    els.sidebarTitleInput.addEventListener("blur", cancelTitleEdit);
  }

  function exitTitleEditUI() {
    if (titleEditSettled) return;
    titleEditSettled = true;
    els.sidebarTitleInput.classList.add("hidden");
    els.sidebarTitle.classList.remove("hidden");
  }

  function cancelTitleEdit() {
    exitTitleEditUI();
  }

  function commitTitleEdit() {
    if (titleEditSettled) return;
    var newTitle = els.sidebarTitleInput.value.trim();
    if (!newTitle) { cancelTitleEdit(); return; }
    els.sidebarTitle.textContent = newTitle;
    exitTitleEditUI();
    apiPatchConfig({ treeTitle: newTitle }).then(function (cfg) {
      state.config = cfg;
    }).catch(function (err) {
      showToast("Could not save title: " + err.message);
    });
  }

  // v2.6: the + button now opens the same modal pattern as Add moon (see
  // openAddWorldModal). The listeners below for the old inline #add-world-form are left
  // wired but unreachable -- toggleAddWorldForm/hideAddWorldForm/submitAddWorldForm and
  // their DOM elements all still exist, per the no-deletion rule, they're just never
  // shown by anything anymore.
  function wireAddWorldForm() {
    els.btnAddWorld.addEventListener("click", function (evt) {
      evt.stopPropagation();
      openAddWorldModal();
    });
    els.btnAddWorldCancel.addEventListener("click", function (evt) {
      evt.stopPropagation();
      hideAddWorldForm();
    });
    els.btnAddWorldCreate.addEventListener("click", function (evt) {
      evt.stopPropagation();
      submitAddWorldForm();
    });
    els.addWorldName.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") { evt.preventDefault(); submitAddWorldForm(); }
      else if (evt.key === "Escape") { evt.preventDefault(); hideAddWorldForm(); }
    });
  }

  function toggleAddWorldForm() {
    var willShow = els.addWorldForm.classList.contains("hidden");
    els.addWorldForm.classList.toggle("hidden", !willShow);
    if (willShow) {
      els.addWorldName.value = "";
      els.addWorldSsh.value = "";
      els.addWorldName.focus();
    }
  }

  function hideAddWorldForm() {
    els.addWorldForm.classList.add("hidden");
  }

  function submitAddWorldForm() {
    var name = els.addWorldName.value.trim();
    if (!name) {
      showToast("World name is required.");
      return;
    }
    var sshTarget = els.addWorldSsh.value.trim();
    var payload = { name: name };
    if (sshTarget) payload.sshTarget = sshTarget;

    apiCreatePlanet(payload).then(function () {
      hideAddWorldForm();
      return refreshPlanetsFromServer();
    }).catch(function (err) {
      showToast("Could not create world: " + err.message);
    });
  }

  function applyConfigToUI(config) {
    state.config = config;
    els.sidebarTitle.textContent = config.treeTitle || "Galaxy";
  }

  // Refresh-proof local terminals, load side: cross-checks localStorage's tab
  // list against the server's alive-session list (GET /api/terminals, local
  // sessions only) BEFORE recreating anything, so a session that already hit
  // its idle TTL or died in a server restart doesn't leave a phantom tab
  // trying to reattach to nothing -- that entry is just dropped instead.
  // Survivors are reopened through the normal openTab() path: it already
  // looks up the persisted sessionId for this planetId+session (see
  // persistedLocalSession above) and sends it as sid, so pty-bridge.js
  // reattaches to the SAME detached pty and replays its ring buffer.
  function restoreLocalTerminalTabs() {
    var persisted = loadLocalTermSessions();
    if (!persisted.length) return;

    apiGetTerminals().then(function (result) {
      var alive = {};
      (result.sessions || []).forEach(function (s) { alive[s.sessionId] = true; });

      var survivors = [];
      persisted.forEach(function (entry) {
        if (!alive[entry.sessionId]) return; // gone server-side -- drop it, don't resurrect as a fresh shell
        var planet = state.allPlanets.filter(function (p) { return p.id === entry.planetId && p.kind === "local"; })[0];
        if (!planet) return; // planet renamed away from "local" or removed since
        if (findTerminalTab(planet.id, entry.session)) return; // already open (shouldn't happen this early, defensive)
        survivors.push(entry);
        openTab({ planet: planet, session: entry.session, kind: "visitor", type: "xterm", labelOverride: entry.label });
      });
      saveLocalTermSessions(survivors);
    }).catch(function () {
      // Server unreachable or route not deployed yet -- leave localStorage untouched so a
      // later successful load can still try the restore instead of silently forgetting it.
    });
  }

  function init() {
    cacheEls();
    wireStaticEvents();
    setupCanvas();
    applySidebarWidthVar();

    var configPromise = apiGetConfig().catch(function () {
      return { treeTitle: "Galaxy", sunName: "Workspace" };
    });

    var planetsPromise = apiGetPlanets()
      .then(function (planets) {
        state.serverOffline = false;
        return planets;
      })
      .catch(function () {
        state.serverOffline = true;
        els.offlineBanner.classList.remove("hidden");
        els.sidebarOfflineNote.classList.remove("hidden");
        return FALLBACK_PLANETS.map(function (p) {
          return JSON.parse(JSON.stringify(p));
        });
      });

    Promise.all([configPromise, planetsPromise]).then(function (results) {
      applyConfigToUI(results[0]);
      applyPlanetsData(results[1]);
      restoreFrozenArrangement(); // reload while still frozen: bring back the frozen/aligned arrangement
      restoreLocalTerminalTabs(); // reload after a local shell was open: reattach it, don't lose it
      applyTabFilter();
      requestAnimationFrame(drawFrame);
      connectEventsWs();
      initRender3DPreference(); // restores last 2D/3D choice; real planet data is ready by now
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
