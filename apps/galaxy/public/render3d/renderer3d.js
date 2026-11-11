/* Galaxy control map -- Three.js render layer (v2.0).
 *
 * This module owns ONLY the WebGL scene: it never fetches data, never touches
 * app.js's DOM, and never mutates anything it's given. It polls a small
 * read-only "dataProvider" object once per animation frame and mirrors what
 * it sees onto meshes it manages itself. That keeps the 2D canvas renderer
 * (public/app.js) as the single source of truth for planet/ship/orbit state,
 * exactly like the migration plan in todo_galaxy_map.md calls for ("map
 * render layer only... no rewrite").
 *
 * ---------------------------------------------------------------------------
 * DATA CONTRACT (what the host page must hand to initRenderer3D)
 * ---------------------------------------------------------------------------
 * dataProvider = {
 *   getPlanets(): Planet[]
 *   getShips(): Ship[]
 *   getSunName(): string
 *   getOrbitClock(): number        // ms, same accumulator app.js's state.orbitClock holds
 *                                  // (frozen while Freeze/Align hold it still -- this
 *                                  // module never advances its own orbit clock)
 *   getViewport?(): { offsetX, width, height }   // optional, mirrors app.js's
 *                                  // getMapArea() so the 3D content can dodge the
 *                                  // sidebar/drawer the same way the 2D map does.
 *                                  // Defaults to the full canvas if omitted.
 * }
 *
 * Planet = {
 *   id, name, status: 'online'|'offline'|'asleep'|'unknown',
 *   color: '#rrggbb',              // already harmonized, same field app.js computes
 *   orbitRadius, orbitSpeed, orbitPhase,   // same units/meaning as app.js (px, rad/ms, rad)
 *   visualRadius,                  // px, same meaning as app.js's planet.visualRadius
 *   _align?: { startAngle, targetAngle, startTime, duration },  // optional, transient
 *   _alignAngle?: number,          // present exactly when _align is, same as app.js
 *   freighter: null | { label, manifest: string[], hullColor, orbitRadius, orbitPhase, orbitSpeed },
 *   moonSprites: [{ label, radius, orbitRadius, orbitPhase, orbitSpeed }]
 * }
 *
 * Ship = {
 *   tabId, planetId, type: 'desktop'|'bridge'|..., color: '#rrggbb', label,
 *   orbitRadius, orbitSpeed, orbitPhase, bobPhase, spawnTime,   // performance.now()-scale
 *   fadeAlpha?: number             // 0..1, present only for a departing/closing ship
 *                                  // (mirrors app.js's state.closingShips fade-out)
 * }
 *
 * Angle formula for planets/freighters/moons (identical to app.js):
 *   angle = planet._align ? planet._alignAngle : (orbitPhase + orbitClock * orbitSpeed)
 * Ships intentionally read the wall clock (performance.now()), never orbitClock,
 * so they keep moving through Freeze/Align -- same rule app.js documents inline.
 *
 * ---------------------------------------------------------------------------
 * CALLBACKS (host page supplies these; this module owns no tooltip/selection UI)
 * ---------------------------------------------------------------------------
 * callbacks = {
 *   onClick?(hit: Hit),             // hit = { kind: 'ship'|'freighter'|'moon'|'sun'|'planet', id }
 *   onEmptyClick?(),                 // click landed on nothing
 *   onHover?(hit: Hit, clientX, clientY),
 *   onHoverEnd?(),
 * }
 * Hit-test priority mirrors app.js's onCanvasClick exactly: ship > decor
 * (freighter/moon) > sun > planet.
 *
 * ---------------------------------------------------------------------------
 * RETURNED HANDLE
 * ---------------------------------------------------------------------------
 * { resize(), resetCamera(), setFrozenHint(bool), dispose(), renderer, scene, camera }
 * resize() re-reads window size + getViewport() and is also wired to a window
 * resize listener internally, so callers don't have to re-plumb that.
 */

import * as THREE from './vendor/three.module.min.js';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';

/* ============================================================================
 * TUNABLES -- these translate app.js's 2D pixel-space geometry into a 3D
 * world. There is no literal pixel parity across dimensions; the goal is the
 * same RELATIVE spacing/size relationships, viewed from a 3/4 perspective.
 * ========================================================================== */
// One shared scale factor for every 2D-px-space distance (system orbit radius,
// visualRadius, freighter/moon/ship orbit radius) -- deliberately the SAME
// constant for all of them, mirroring how app.js's 2D canvas already puts
// them all in one shared pixel space. Using two different scales here was an
// earlier bug: it shrank planet spheres less than their own moon/ship orbits,
// so moons rendered INSIDE the planet mesh instead of around it.
const WORLD_SCALE = 1 / 15;
const DECOR_Y_TILT = 0.16;          // small vertical bob for freighter/moon orbits so they
                                     // read as real 3D orbits, not a flat ring (2D used a
                                     // 0.55/0.7 y-flatten for the same visual purpose)
const MIN_CAM_RADIUS = 3;
const MAX_CAM_RADIUS = 60;
const DEFAULT_POLAR = 1.05;         // radians from +Y axis; ~60deg down = "3/4" look
const ZOOM_STEP = 1.12;
const SHIP_SIZE = 0.16;
const SHIP_TRAIL_MAX = 10;
const FREIGHTER_HIT_PAD = 0.22;
const MOON_HIT_PAD = 0.12;
const PIXEL_RATIO_CAP = 1.75;       // perf: never render at more than this DPR

/* ============================================================================
 * SMALL SHARED HELPERS
 * ========================================================================== */

// Same string->[0,1) hash app.js uses (hashStringToUnit), duplicated here only
// because it's a generic utility, not business logic -- keeps this module
// fetch-free and app.js-free.
function hashStringToUnit(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function currentAngle(entity, orbitClock) {
  if (entity._align) return entity._alignAngle;
  return entity.orbitPhase + orbitClock * entity.orbitSpeed;
}

/* ============================================================================
 * PROCEDURAL TEXTURES (cached by key, built once, never per-frame -- same
 * discipline app.js's sprite caches use for the 2D canvas)
 * ========================================================================== */

var planetTextureCache = {};   // "color|status" -> THREE.CanvasTexture
var sunCoronaTexture = null;   // THREE.CanvasTexture, built once
var glowTextureCache = {};     // hex color -> THREE.CanvasTexture (ship/freighter glow)

// Cheap seamless (horizontally-wrapping) fractal wave noise: sums a handful of sine waves
// whose X frequency is always an integer multiple of the full wrap, so the texture's left
// and right edges always match exactly -- no visible seam as the sphere (wrapS =
// RepeatWrapping) rotates. Y has no wrap constraint (poles aren't tiled), so its frequency
// can be any real value. This gives soft continent-like blobs without a full Perlin/value-
// noise implementation, and all the randomness is drawn once per octave (not per pixel), so
// it's cheap even at higher texture resolution.
function continentNoise(octaveParams, xFrac, yFrac) {
  var total = 0, maxAmp = 0;
  for (var i = 0; i < octaveParams.length; i++) {
    var o = octaveParams[i];
    total += Math.sin(o.kx * Math.PI * 2 * xFrac + o.skew * o.ky * yFrac * Math.PI + o.phase) * o.amp;
    maxAmp += o.amp;
  }
  return total / maxAmp; // ~[-1, 1]
}

function buildContinentOctaves(seed, octaves) {
  var params = [];
  var amp = 1;
  for (var i = 0; i < octaves; i++) {
    params.push({
      kx: 1 + Math.floor(hashStringToUnit(seed + '|kx' + i) * 5),
      ky: 0.5 + hashStringToUnit(seed + '|ky' + i) * 2.5,
      phase: hashStringToUnit(seed + '|ph' + i) * Math.PI * 2,
      skew: hashStringToUnit(seed + '|sk' + i) > 0.5 ? 1 : -1,
      amp: amp
    });
    amp *= 0.55;
  }
  return params;
}

// Richer procedural planet surface: smooth noise-based continents (instead of flat discrete
// stripe bands, which read as a striped/segmented ball rather than a natural world) plus soft
// storm blotches on top, tinted from the planet's own identity color. Deterministic per
// color+status so the cache key is small and stable across reloads. Higher resolution than
// the original pass (512x256 vs 256x128) since the noise detail needs the extra pixels to
// read as texture rather than blur once mapped onto the sphere.
function buildPlanetTexture(colorHex, status) {
  var key = colorHex + '|' + status;
  var cached = planetTextureCache[key];
  if (cached) return cached;

  var w = 512, h = 256;
  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');

  var base = new THREE.Color(colorHex);
  if (status === 'offline') base = new THREE.Color('#3a4258');
  else if (status === 'asleep') base = new THREE.Color('#9b6bdb');
  else if (status === 'unknown') base = new THREE.Color('#e0b652');

  var hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  var seed = colorHex + '|' + status;
  var octaves = buildContinentOctaves(seed, 4);

  var imgData = ctx.createImageData(w, h);
  var data = imgData.data;
  var px = new THREE.Color();
  for (var y = 0; y < h; y++) {
    var yFrac = y / h;
    for (var x = 0; x < w; x++) {
      var n = continentNoise(octaves, x / w, yFrac);
      var l = clamp(hsl.l + n * 0.17, 0.05, 0.95);
      px.setHSL(hsl.h, hsl.s, l);
      var idx = (y * w + x) * 4;
      data[idx] = Math.round(px.r * 255);
      data[idx + 1] = Math.round(px.g * 255);
      data[idx + 2] = Math.round(px.b * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Soft blotches (storms/surface detail) layered on top of the continent noise.
  var blotchCount = 16 + Math.floor(hashStringToUnit(seed + '|blotch') * 14);
  for (var i = 0; i < blotchCount; i++) {
    var bx = hashStringToUnit(seed + '|bx' + i) * w;
    var by = hashStringToUnit(seed + '|by' + i) * h;
    var br = 12 + hashStringToUnit(seed + '|br' + i) * 40;
    var lighter = hashStringToUnit(seed + '|bl' + i) > 0.5;
    var blotchL = clamp(hsl.l + (lighter ? 0.16 : -0.16), 0.04, 0.96);
    var blotchColor = new THREE.Color().setHSL(hsl.h, hsl.s, blotchL);
    var grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    grad.addColorStop(0, 'rgba(' + Math.round(blotchColor.r * 255) + ',' + Math.round(blotchColor.g * 255) + ',' + Math.round(blotchColor.b * 255) + ', 0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  var tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  planetTextureCache[key] = tex;
  return tex;
}

// Layered radial-gradient corona, same visual idea as app.js's buildSunSprite,
// built once and reused for every frame (the pulse is a scale animation, not
// a texture rebuild, matching the 2D approach).
function buildSunCoronaTexture() {
  if (sunCoronaTexture) return sunCoronaTexture;
  var size = 512;
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  var cx = size / 2, cy = size / 2;

  var outer = ctx.createRadialGradient(cx, cy, size * 0.12, cx, cy, size * 0.5);
  outer.addColorStop(0, 'rgba(255, 226, 150, 0.55)');
  outer.addColorStop(0.5, 'rgba(255, 200, 120, 0.22)');
  outer.addColorStop(1, 'rgba(255, 160, 80, 0)');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
  ctx.fill();

  var tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  sunCoronaTexture = tex;
  return tex;
}

function buildGlowTexture(colorHex) {
  var cached = glowTextureCache[colorHex];
  if (cached) return cached;
  var size = 128;
  var canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  var c = new THREE.Color(colorHex);
  var grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ', 0.6)');
  grad.addColorStop(1, 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ', 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  var tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  glowTextureCache[colorHex] = tex;
  return tex;
}

// Fresnel-style rim glow: view-dependent, additive, no texture -- cheap and
// gives the "atmosphere" read the parity checklist asks for. Beauty pass:
// widened the rim (lower pow exponent) and raised intensity so it reads as a
// real atmospheric glow instead of a thin outline -- this is what sells
// "planet" over "lit sphere" at a glance, per the original beauty-pass ask.
function buildAtmosphereMaterial(colorHex, power, intensity) {
  return new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color(colorHex) }, rimPower: { value: power }, rimIntensity: { value: intensity } },
    vertexShader: [
      'varying vec3 vNormalW;',
      'varying vec3 vViewDir;',
      'void main() {',
      '  vNormalW = normalize(mat3(modelMatrix) * normal);',
      '  vec4 worldPos = modelMatrix * vec4(position, 1.0);',
      '  vViewDir = normalize(cameraPosition - worldPos.xyz);',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 glowColor;',
      'uniform float rimPower;',
      'uniform float rimIntensity;',
      'varying vec3 vNormalW;',
      'varying vec3 vViewDir;',
      'void main() {',
      '  float rim = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0);',
      '  float intensity = pow(rim, rimPower);',
      '  gl_FragColor = vec4(glowColor, intensity * rimIntensity);',
      '}'
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide
  });
}

/* ============================================================================
 * LABEL OVERLAY -- plain DOM divs positioned every frame via camera
 * projection, instead of vendoring three's CSS2DRenderer addon (keeps the
 * dependency surface to just the core "three" package). Same visual role as
 * app.js's drawWorldLabels/drawDecorLabels, just DOM instead of canvas text.
 * ========================================================================== */
function createLabelLayer(hostEl) {
  var root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.inset = '0';
  root.style.pointerEvents = 'none';
  root.style.overflow = 'hidden';
  hostEl.appendChild(root);

  var pool = {}; // key -> element

  function set(key, text, x, y, visible, opts) {
    opts = opts || {};
    var el = pool[key];
    if (!el) {
      el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.transform = 'translate(-50%, 0)';
      el.style.fontFamily = '-apple-system, "Segoe UI", sans-serif';
      el.style.color = 'rgba(216, 224, 240, 0.85)';
      el.style.whiteSpace = 'nowrap';
      el.style.textShadow = '0 1px 3px rgba(0,0,0,0.8)';
      root.appendChild(el);
      pool[key] = el;
    }
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.fontSize = (opts.fontSize || 12) + 'px';
    el.style.fontWeight = opts.weight || '500';
    el.style.opacity = opts.opacity !== undefined ? opts.opacity : (visible ? '1' : '0');
    el.style.display = visible ? 'block' : 'none';
  }

  function sweep(validKeys) {
    Object.keys(pool).forEach(function (key) {
      if (validKeys.indexOf(key) === -1) {
        pool[key].remove();
        delete pool[key];
      }
    });
  }

  function dispose() {
    root.remove();
    pool = {};
  }

  return { set: set, sweep: sweep, dispose: dispose };
}

/* ============================================================================
 * CAMERA CONTROLLER -- hand-rolled orbit/zoom/reset, not the OrbitControls
 * addon. We need Freeze/Align-aware click priority (never orbit-drag over an
 * interactive hit, mirroring app.js's onCanvasMouseDown) and a Fit-equivalent
 * reset, so a small purpose-built controller is less surface than adapting
 * a generic addon.
 * ========================================================================== */
function createCameraController(camera, canvas, opts) {
  var target = new THREE.Vector3(0, 0, 0);
  var radius = opts.initialRadius;
  var theta = Math.PI * 0.32;   // azimuth
  var phi = DEFAULT_POLAR;      // polar (from +Y)
  var dragging = false;
  var last = { x: 0, y: 0 };
  var moved = false;

  function apply() {
    var sinPhi = Math.sin(phi);
    camera.position.set(
      target.x + radius * sinPhi * Math.cos(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sinPhi * Math.sin(theta)
    );
    camera.lookAt(target);
  }

  function reset() {
    radius = opts.initialRadius;
    theta = Math.PI * 0.32;
    phi = DEFAULT_POLAR;
    apply();
  }

  function onPointerDown(evt) {
    if (opts.isOverInteractive && opts.isOverInteractive(evt.clientX, evt.clientY)) return;
    dragging = true;
    moved = false;
    last.x = evt.clientX;
    last.y = evt.clientY;
    canvas.style.cursor = 'grabbing';
  }
  function onPointerMove(evt) {
    if (!dragging) return;
    var dx = evt.clientX - last.x;
    var dy = evt.clientY - last.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    last.x = evt.clientX;
    last.y = evt.clientY;
    theta -= dx * 0.006;
    phi = clamp(phi - dy * 0.006, 0.15, Math.PI - 0.15);
    apply();
  }
  function onPointerUp() {
    dragging = false;
    canvas.style.cursor = 'default';
  }
  function onWheel(evt) {
    evt.preventDefault();
    var factor = evt.deltaY < 0 ? (1 / ZOOM_STEP) : ZOOM_STEP;
    radius = clamp(radius * factor, MIN_CAM_RADIUS, MAX_CAM_RADIUS);
    apply();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  apply();

  return {
    reset: reset,
    wasDragged: function () { return moved; },
    clearDragFlag: function () { moved = false; },
    dispose: function () {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    }
  };
}

/* ============================================================================
 * MAIN ENTRY POINT
 * ========================================================================== */
export function initRenderer3D(canvas, dataProvider, callbacks, options) {
  callbacks = callbacks || {};
  options = options || {};

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(new THREE.Color('#05070d'), 1);

  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070d, 0.012);

  var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);

  var hostEl = canvas.parentElement || document.body;
  var labels = createLabelLayer(hostEl);

  /* ---- real sun bloom (beauty pass) ----
   * The old sun glow was a single additive corona sprite -- a flat, shaped blob with a hard
   * edge past its texture, not actual light bleeding into the surrounding scene. UnrealBloomPass
   * gives genuine camera-bloom: bright pixels smear into their neighbors. EffectComposer's render
   * targets default to HalfFloatType (HDR), so pushing the sun material's color above 1.0 (see
   * sunMat below) makes it clear the bloom's luminance threshold while everything else in the
   * 0..1 range does not -- so planets/ships/stars stay crisp and only the sun (and anything else
   * intentionally pushed HDR-bright) blooms. bloomPass's own "resolution" param is deliberately
   * half the window size: that's its internal mip-chain working resolution (not the final output
   * size), which is what keeps this cheap enough to hold 60fps per the perf bar. */
  var composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  var bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5), 1.35, 0.55, 0.72);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  /* ---- lighting ----
   * Beauty-pass fix (Design: "planets look like futbol balls"): a single point
   * light + a flat AmbientLight meant every planet's night hemisphere was one
   * uniform navy-gray with zero shading variation, while the day side got a
   * proper Lambertian falloff from the point light -- that stark two-tone
   * split (gradient vs flat color, unrelated to the planet's own hue) is
   * exactly what reads as a cheap painted ball instead of a lit world.
   * HemisphereLight gives a top/bottom gradient fill (still no shadows, still
   * cheap) so the unlit side has some natural-looking variation instead of a
   * single flat value; a small residual AmbientLight guarantees nothing is
   * ever fully black. Each planet also gets its own low emissive tint (see
   * buildPlanetEntry) so its night side keeps a hint of its own identity
   * color instead of reading as generic gray. */
  scene.add(new THREE.HemisphereLight(0x8fa4d8, 0x0d1120, 0.85));
  scene.add(new THREE.AmbientLight(0x30364a, 0.35));
  var sunLight = new THREE.PointLight(0xfff2d0, 9, 0, 2);
  sunLight.position.set(0, 0, 0);
  scene.add(sunLight);

  /* ---- starfield: multi-size Points cloud with per-star twinkle, two depth layers like the
   * 2D far/near stars. PointsMaterial can't vary size or opacity per-point or animate them, so
   * this is a small custom ShaderMaterial instead: each star carries its own random size and
   * twinkle phase/speed as vertex attributes, and the fragment shader draws a soft round dot
   * (plain WebGL points are hard-edged squares otherwise) faded by the twinkle sine. */
  var starMaterials = []; // { material } list so twinkleStars() can push a fresh uTime each frame
  function buildStarField(count, radius, baseSize, opacity) {
    var positions = new Float32Array(count * 3);
    var sizes = new Float32Array(count);
    var phases = new Float32Array(count);
    var speeds = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      var r = radius * (0.6 + Math.random() * 0.4);
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.5;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = baseSize * (0.5 + Math.random() * 1.3); // multi-size, not uniform dots
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 0.0006 + Math.random() * 0.0014;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

    var mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xd8e0f0) }, uOpacity: { value: opacity } },
      vertexShader: [
        'attribute float aSize;',
        'attribute float aPhase;',
        'attribute float aSpeed;',
        'uniform float uTime;',
        'varying float vTwinkle;',
        'void main() {',
        '  vTwinkle = 0.55 + 0.45 * sin(uTime * aSpeed + aPhase);',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = aSize * (220.0 / -mv.z);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uOpacity;',
        'varying float vTwinkle;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float fall = 1.0 - smoothstep(0.2, 0.5, length(d));',
        '  if (fall <= 0.0) discard;',
        '  gl_FragColor = vec4(uColor, fall * uOpacity * vTwinkle);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false
    });
    starMaterials.push(mat);
    return new THREE.Points(geo, mat);
  }
  var starsFar = buildStarField(1400, 90, 1.1, 0.55);
  var starsNear = buildStarField(260, 55, 1.9, 0.8);
  scene.add(starsFar);
  scene.add(starsNear);

  function twinkleStars(timestamp) {
    for (var i = 0; i < starMaterials.length; i++) starMaterials[i].uniforms.uTime.value = timestamp;
  }

  /* ---- nebula: a handful of large additive sprites, echoing the 2D nebula blobs ---- */
  var nebulaGroup = new THREE.Group();
  var nebulaColors = ['#6b4d9b', '#2a3d6b'];
  for (var n = 0; n < 10; n++) {
    var seedKey = 'nebula' + n;
    var col = nebulaColors[n % 2];
    var tex = buildGlowTexture(col);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending });
    var sprite = new THREE.Sprite(mat);
    var ang = hashStringToUnit(seedKey + 'a') * Math.PI * 2;
    var dist = 40 + hashStringToUnit(seedKey + 'd') * 45;
    sprite.position.set(Math.cos(ang) * dist, (hashStringToUnit(seedKey + 'y') - 0.5) * 20, Math.sin(ang) * dist);
    var s = 30 + hashStringToUnit(seedKey + 's') * 40;
    sprite.scale.set(s, s, 1);
    nebulaGroup.add(sprite);
  }
  scene.add(nebulaGroup);

  /* ---- sun ----
   * Color pushed above 1.0 (an HDR value, not a display-clipped one, since the composer's
   * render targets are HalfFloatType) so UnrealBloomPass's luminance threshold picks it up
   * and it actually blooms -- everything else in the scene stays in normal 0..1 range and
   * doesn't. The corona sprite is kept (toned down slightly) for a defined bright core at
   * the source; the bloom pass adds the actual light-bleed into the surrounding scene that
   * a flat sprite alone can't fake convincingly. */
  var sunGroup = new THREE.Group();
  var sunGeo = new THREE.SphereGeometry(1.1, 32, 24);
  var sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe296).multiplyScalar(2.6) });
  var sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunGroup.add(sunMesh);
  var coronaSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: buildSunCoronaTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8
  }));
  coronaSprite.scale.set(5.5, 5.5, 1);
  sunGroup.add(coronaSprite);
  scene.add(sunGroup);

  /* ---- per-entity caches (rebuilt only on add/remove, updated every frame) ---- */
  var planetEntries = {};   // id -> { group, mesh, atmoMesh, orbitLine, freighter:{...}|null, moons:[...] }
  var shipEntries = {};     // tabId -> { group, mesh, glow, trail:[Vector3], trailSprites:[] }

  function disposeObject(obj) {
    obj.traverse(function (child) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(function (m) { m.dispose(); });
        else child.material.dispose();
      }
    });
  }

  function buildOrbitLine(orbitRadiusWorld) {
    var segments = 96;
    var points = [];
    for (var i = 0; i <= segments; i++) {
      var a = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * orbitRadiusWorld, 0, Math.sin(a) * orbitRadiusWorld));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(points);
    var mat = new THREE.LineBasicMaterial({ color: 0x788cb4, transparent: true, opacity: 0.12 });
    return new THREE.Line(geo, mat);
  }

  function buildPlanetEntry(planet) {
    var group = new THREE.Group();
    var r = Math.max(0.08, planet.visualRadius * WORLD_SCALE);

    var geo = new THREE.SphereGeometry(r, 24, 18);
    var tex = buildPlanetTexture(planet.color, planet.status);
    // Low emissive tint in the planet's own identity color, darkened and cooled toward
    // blue -- keeps the shadow side reading as "this planet, in the dark" instead of a
    // generic flat gray (see the lighting comment above for why that mattered).
    var idColor = new THREE.Color(planet.color);
    var idHsl = { h: 0, s: 0, l: 0 };
    idColor.getHSL(idHsl);
    var emissive = new THREE.Color().setHSL(idHsl.h, idHsl.s * 0.7, 0.09).lerp(new THREE.Color('#0a1128'), 0.35);
    var mat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.78, metalness: 0.04,
      emissive: emissive, emissiveIntensity: 0.55
    });
    var mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);

    // Two rim layers: a tighter/brighter inner one for a crisp atmosphere edge, a wider/
    // softer outer one for the ambient halo -- one flat layer read as a thin outline, this
    // reads as actual atmospheric depth (this is the biggest single "is it a world or a
    // ball" cue, per the original beauty-pass ask).
    var atmoGeo = new THREE.SphereGeometry(r * 1.1, 24, 18);
    var atmoMat = buildAtmosphereMaterial(planet.color, 2.0, 1.1);
    var atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    group.add(atmoMesh);

    var haloGeo = new THREE.SphereGeometry(r * 1.35, 24, 18);
    var haloMat = buildAtmosphereMaterial(planet.color, 1.1, 0.45);
    var haloMesh = new THREE.Mesh(haloGeo, haloMat);
    group.add(haloMesh);

    var orbitLine = buildOrbitLine(planet.orbitRadius * WORLD_SCALE);
    scene.add(orbitLine);
    scene.add(group);

    // Gentle self-rotation (a free depth cue 2D can't show at all): fixed per-tick increment,
    // same simple style the sun's own idle spin already uses below, just slower and randomized
    // per planet so they don't all turn in lockstep.
    var spinSpeed = (0.0009 + hashStringToUnit(planet.id + '|spin') * 0.0009) *
      (hashStringToUnit(planet.id + '|spindir') < 0.5 ? 1 : -1);

    return { group: group, mesh: mesh, atmoMesh: atmoMesh, haloMesh: haloMesh, orbitLine: orbitLine, radius: r, spinSpeed: spinSpeed, freighter: null, moons: [] };
  }

  function buildMoonMesh(radiusWorld) {
    var geo = new THREE.SphereGeometry(radiusWorld, 12, 10);
    var mat = new THREE.MeshStandardMaterial({ color: 0xd6deef, roughness: 0.9 });
    return new THREE.Mesh(geo, mat);
  }

  function buildFreighterMesh(hullColor) {
    var len = 0.5, rad = 0.09;
    var geo = new THREE.CapsuleGeometry(rad, Math.max(0.01, len - rad * 2), 4, 8);
    geo.rotateZ(Math.PI / 2); // capsule's long axis defaults to +Y; align to +X (travel axis)
    var mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(hullColor), roughness: 0.6, metalness: 0.2 });
    return new THREE.Mesh(geo, mat);
  }

  function buildShipMesh(type, colorHex) {
    var mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) });
    var mesh;
    if (type === 'desktop') {
      var geo = new THREE.SphereGeometry(SHIP_SIZE * 0.9, 12, 10);
      geo.scale(1, 0.55, 1);
      mesh = new THREE.Mesh(geo, mat);
    } else {
      var coneGeo = new THREE.ConeGeometry(SHIP_SIZE * 0.55, SHIP_SIZE * 2, 8);
      coneGeo.rotateZ(-Math.PI / 2); // point along +X (travel axis)
      mesh = new THREE.Mesh(coneGeo, mat);
    }
    return mesh;
  }

  // Ship trail: entry.trail already collected a rolling window of past positions, but nothing
  // ever rendered it -- a real gap (the original beauty-pass ask explicitly wants trails visible).
  // Fixed-capacity line geometry (SHIP_TRAIL_MAX vertices) with per-vertex color fading from
  // the ship's own color at the newest point down toward black at the oldest -- additive
  // blending turns that fade into a soft glowing streak instead of a flat colored line.
  // setDrawRange each frame so only the currently-populated prefix actually renders.
  function buildTrailLine(colorHex) {
    var positions = new Float32Array(SHIP_TRAIL_MAX * 3);
    var colors = new Float32Array(SHIP_TRAIL_MAX * 3);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, 0);
    var mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var line = new THREE.Line(geo, mat);
    line._baseColor = new THREE.Color(colorHex);
    return line;
  }

  function updateTrailLine(line, trail) {
    var n = trail.length;
    var posAttr = line.geometry.attributes.position;
    var colAttr = line.geometry.attributes.color;
    var base = line._baseColor;
    for (var i = 0; i < n; i++) {
      var p = trail[i];
      posAttr.setXYZ(i, p.x, p.y, p.z);
      var fade = n > 1 ? i / (n - 1) : 1; // 0 = oldest (fades to black), 1 = newest (full color)
      colAttr.setXYZ(i, base.r * fade, base.g * fade, base.b * fade);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    line.geometry.setDrawRange(0, n);
  }

  /* ---- sync: diff dataProvider planets/ships against cached entries ---- */
  function syncPlanets(planets) {
    var seen = {};
    planets.forEach(function (planet) {
      seen[planet.id] = true;
      var entry = planetEntries[planet.id];
      if (!entry) {
        entry = buildPlanetEntry(planet);
        planetEntries[planet.id] = entry;
      }

      // 2D dropped the freighter hull glyph entirely (the original call, only the "Apps (N)" label
      // survives there) -- mirrored here by never adding the mesh to the scene, so 2D/3D
      // agree. The mesh itself is still built and kept off-scene purely as a position/rotation
      // holder (placePlanets below writes to entry.freighter.mesh.position/.rotation, then
      // reads entry.freighter._pos for the label), so the label keeps tracking the same
      // orbital point it always did.
      var freighterNames = planet.freighter ? planet.freighter.manifest.join('|') : '';
      if (entry._freighterKey !== freighterNames) {
        if (entry.freighter) { disposeObject(entry.freighter.mesh); entry.freighter = null; }
        if (planet.freighter) {
          var fMesh = buildFreighterMesh(planet.freighter.hullColor);
          entry.freighter = { mesh: fMesh, glow: buildGlowTexture(planet.freighter.hullColor) };
        }
        entry._freighterKey = freighterNames;
      }

      var moonKey = (planet.moonSprites || []).map(function (m) { return m.label; }).join('|');
      if (entry._moonKey !== moonKey) {
        entry.moons.forEach(function (m) { scene.remove(m.mesh); disposeObject(m.mesh); });
        entry.moons = (planet.moonSprites || []).map(function (moon) {
          var mesh = buildMoonMesh(Math.max(0.03, moon.radius * WORLD_SCALE * 0.8));
          scene.add(mesh);
          return { mesh: mesh, data: moon };
        });
        entry._moonKey = moonKey;
      }
    });

    Object.keys(planetEntries).forEach(function (id) {
      if (!seen[id]) {
        var entry = planetEntries[id];
        scene.remove(entry.group);
        disposeObject(entry.group);
        scene.remove(entry.orbitLine);
        entry.orbitLine.geometry.dispose();
        entry.orbitLine.material.dispose();
        if (entry.freighter) { scene.remove(entry.freighter.mesh); disposeObject(entry.freighter.mesh); }
        entry.moons.forEach(function (m) { scene.remove(m.mesh); disposeObject(m.mesh); });
        delete planetEntries[id];
      }
    });
  }

  function syncShips(ships) {
    var seen = {};
    ships.forEach(function (ship) {
      seen[ship.tabId] = true;
      var entry = shipEntries[ship.tabId];
      if (!entry) {
        var mesh = buildShipMesh(ship.type, ship.color);
        var glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: buildGlowTexture(ship.color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        }));
        glow.scale.set(SHIP_SIZE * 5, SHIP_SIZE * 5, 1);
        var trailLine = buildTrailLine(ship.color);
        scene.add(mesh);
        scene.add(glow);
        scene.add(trailLine);
        entry = { mesh: mesh, glow: glow, trail: [], trailLine: trailLine };
        shipEntries[ship.tabId] = entry;
      }
    });
    Object.keys(shipEntries).forEach(function (tabId) {
      if (!seen[tabId]) {
        var entry = shipEntries[tabId];
        scene.remove(entry.mesh); disposeObject(entry.mesh);
        scene.remove(entry.glow); entry.glow.material.dispose();
        scene.remove(entry.trailLine); entry.trailLine.geometry.dispose(); entry.trailLine.material.dispose();
        delete shipEntries[tabId];
      }
    });
  }

  /* ---- per-frame placement ---- */
  var planetWorldPos = {}; // id -> Vector3 (for ship/freighter/moon anchoring + hit-test)

  function placePlanets(planets, orbitClock) {
    planets.forEach(function (planet) {
      var entry = planetEntries[planet.id];
      if (!entry) return;
      var angle = currentAngle(planet, orbitClock);
      var wr = planet.orbitRadius * WORLD_SCALE;
      var x = Math.cos(angle) * wr;
      var z = Math.sin(angle) * wr;
      entry.group.position.set(x, 0, z);
      planetWorldPos[planet.id] = entry.group.position;
      entry.mesh.rotation.y += entry.spinSpeed; // self-rotation always ticks, independent of orbitClock/Freeze

      if (entry.freighter && planet.freighter) {
        var fAngle = currentAngle(planet.freighter, orbitClock);
        var fr = planet.freighter.orbitRadius * WORLD_SCALE;
        var fx = x + Math.cos(fAngle) * fr;
        var fz = z + Math.sin(fAngle) * fr;
        var fy = Math.sin(fAngle * 1.3) * DECOR_Y_TILT;
        entry.freighter.mesh.position.set(fx, fy, fz);
        var travel = fAngle + (planet.freighter.orbitSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2);
        entry.freighter.mesh.rotation.set(0, -travel, 0);
        entry.freighter._pos = { x: fx, y: fy, z: fz };
      }

      entry.moons.forEach(function (moonEntry) {
        var moon = moonEntry.data;
        var mAngle = currentAngle(moon, orbitClock);
        var mr = moon.orbitRadius * WORLD_SCALE;
        var mx = x + Math.cos(mAngle) * mr;
        var mz = z + Math.sin(mAngle) * mr;
        var my = Math.sin(mAngle * 1.3) * DECOR_Y_TILT * 0.8;
        moonEntry.mesh.position.set(mx, my, mz);
        moonEntry._pos = { x: mx, y: my, z: mz };
      });
    });
  }

  function placeShips(ships, wallClock) {
    ships.forEach(function (ship) {
      var entry = shipEntries[ship.tabId];
      if (!entry) return;
      var anchor = planetWorldPos[ship.planetId];
      if (!anchor) { entry.mesh.visible = false; entry.glow.visible = false; entry.trailLine.visible = false; return; }
      entry.mesh.visible = true;
      entry.glow.visible = true;
      entry.trailLine.visible = true;

      var angle = ship.orbitPhase + wallClock * ship.orbitSpeed;
      var bob = Math.sin(wallClock * 0.002 + ship.bobPhase) * 0.06;
      var r = ship.orbitRadius * WORLD_SCALE;
      var x = anchor.x + Math.cos(angle) * r;
      var z = anchor.z + Math.sin(angle) * r;
      var y = bob;

      var spawnElapsed = wallClock - ship.spawnTime;
      var spawnAlpha = spawnElapsed < 350 ? Math.max(0, spawnElapsed / 350) : 1;
      var alpha = (ship.fadeAlpha !== undefined ? ship.fadeAlpha : 1) * spawnAlpha;

      entry.mesh.position.set(x, y, z);
      entry.glow.position.set(x, y, z);
      entry.mesh.material.opacity = alpha;
      entry.mesh.material.transparent = alpha < 1;
      entry.glow.material.opacity = 0.6 * alpha;
      entry.trailLine.material.opacity = 0.85 * alpha;

      if (ship.type !== 'desktop') {
        var travel = angle + (ship.orbitSpeed >= 0 ? Math.PI / 2 : -Math.PI / 2);
        entry.mesh.rotation.set(0, -travel, 0);
      }

      entry.trail.push(new THREE.Vector3(x, y, z));
      if (entry.trail.length > SHIP_TRAIL_MAX) entry.trail.shift();
      updateTrailLine(entry.trailLine, entry.trail);
      entry._pos = { x: x, y: y, z: z };
    });
  }

  /* ---- labels ---- */
  var projected = new THREE.Vector3();
  function worldToScreen(x, y, z, width, height) {
    projected.set(x, y, z).project(camera);
    return { x: (projected.x * 0.5 + 0.5) * width, y: (-projected.y * 0.5 + 0.5) * height, behind: projected.z > 1 };
  }

  function updateLabels(planets, width, height) {
    var validKeys = [];
    var sunS = worldToScreen(0, 0, 0, width, height);
    labels.set('sun', dataProvider.getSunName(), sunS.x, sunS.y + 40, !sunS.behind, { fontSize: 14, weight: '600' });
    validKeys.push('sun');

    planets.forEach(function (planet) {
      var entry = planetEntries[planet.id];
      if (!entry) return;
      var p = entry.group.position;
      var s = worldToScreen(p.x, p.y, p.z, width, height);
      var key = 'planet:' + planet.id;
      labels.set(key, planet.name, s.x, s.y + entry.radius * 40 + 14, !s.behind);
      validKeys.push(key);

      if (entry.freighter && entry.freighter._pos) {
        var fp = entry.freighter._pos;
        var fs = worldToScreen(fp.x, fp.y, fp.z, width, height);
        var fkey = 'freighter:' + planet.id;
        labels.set(fkey, planet.freighter.label, fs.x, fs.y + 16, !fs.behind, { fontSize: 10 });
        validKeys.push(fkey);
      }
      entry.moons.forEach(function (moonEntry, idx) {
        if (!moonEntry._pos) return;
        var mp = moonEntry._pos;
        var ms = worldToScreen(mp.x, mp.y, mp.z, width, height);
        var mkey = 'moon:' + planet.id + ':' + idx;
        labels.set(mkey, moonEntry.data.label, ms.x, ms.y + 12, !ms.behind, { fontSize: 9 });
        validKeys.push(mkey);
      });
    });
    labels.sweep(validKeys);
  }

  /* ---- camera + viewport (mirrors app.js's getMapArea offset via setViewOffset) ---- */
  function computeInitialRadius() {
    var planets = dataProvider.getPlanets();
    var maxR = 0;
    planets.forEach(function (p) { maxR = Math.max(maxR, p.orbitRadius * WORLD_SCALE); });
    return clamp((maxR || 6) * 1.9 + 3, MIN_CAM_RADIUS, MAX_CAM_RADIUS);
  }

  var camController = createCameraController(camera, canvas, {
    initialRadius: computeInitialRadius(),
    isOverInteractive: function (clientX, clientY) {
      return !!resolveHit(clientX, clientY);
    }
  });

  function applyViewport() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var viewport = dataProvider.getViewport ? dataProvider.getViewport() : { offsetX: 0, width: vw, height: vh };
    var dpr = Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP);

    renderer.setPixelRatio(dpr);
    renderer.setSize(vw, vh, true);
    composer.setPixelRatio(dpr);
    composer.setSize(vw, vh); // cascades to bloomPass.setSize, which halves again for its own mip chain
    camera.aspect = viewport.width / viewport.height;
    // camera.setViewOffset crops a (width x height) rectangle out of the full (vw x vh)
    // frustum and stretches that crop to fill the whole canvas. The camera always looks
    // dead-center at the origin, so its untouched natural position is (vw/2, vh/2) -- a
    // crop anchored at y=0 only keeps that point in frame while height > vh/2. The
    // terminal drawer takes half the window height when open, so viewport.height lands
    // at (or just under) vh/2 and the crop's bottom edge cuts the origin out entirely:
    // that's the drawer-open bug (planet appears to vanish/slide off, not just dim).
    // The x offset (sidebar) never hit this because sidebar width stays well under vw/2.
    // Fix: anchor the crop on the frustum's own natural center on both axes, so the
    // origin is always inside it (and centered within the visible strip after the
    // stretch). This does not byte-match 2D's own anchor formula (2D centers within the
    // strip measured from its own top/left corner), but it guarantees the scene never
    // goes off-frame regardless of how large the drawer/sidebar grow.
    var offsetX = vw / 2 - viewport.width / 2;
    var offsetY = vh / 2 - viewport.height / 2;
    camera.setViewOffset(vw, vh, offsetX, offsetY, viewport.width, viewport.height);
    camera.updateProjectionMatrix();
  }

  function resize() {
    applyViewport();
  }
  window.addEventListener('resize', resize);
  applyViewport();

  /* ---- raycasting hit-test, priority: ship > freighter/moon > sun > planet ---- */
  var raycaster = new THREE.Raycaster();
  var pointerNdc = new THREE.Vector2();

  function ndcFromClient(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  function resolveHit(clientX, clientY) {
    ndcFromClient(clientX, clientY);
    raycaster.setFromCamera(pointerNdc, camera);

    var shipMeshes = Object.keys(shipEntries).map(function (id) { return shipEntries[id].mesh; });
    var shipHit = raycaster.intersectObjects(shipMeshes, false)[0];
    if (shipHit) {
      var hitTabId = Object.keys(shipEntries).filter(function (id) { return shipEntries[id].mesh === shipHit.object; })[0];
      return { kind: 'ship', id: hitTabId };
    }

    var decorMeshes = [];
    var decorLookup = [];
    Object.keys(planetEntries).forEach(function (id) {
      var entry = planetEntries[id];
      // Freighter mesh is off-scene now (see syncPlanets) -- not included here either, so
      // there is no invisible hit target floating where the hull used to be. Its label
      // still renders (see placePlanets/label draw) but isn't a click/hover target in 3D yet.
      entry.moons.forEach(function (m, idx) { decorMeshes.push(m.mesh); decorLookup.push({ kind: 'moon', id: id + ':' + idx }); });
    });
    if (decorMeshes.length) {
      var decorHit = raycaster.intersectObjects(decorMeshes, false)[0];
      if (decorHit) {
        var idx2 = decorMeshes.indexOf(decorHit.object);
        return decorLookup[idx2];
      }
    }

    var sunHit = raycaster.intersectObject(sunMesh, false)[0];
    if (sunHit) return { kind: 'sun', id: 'sun' };

    var planetMeshes = Object.keys(planetEntries).map(function (id) { return planetEntries[id].mesh; });
    var planetHit = raycaster.intersectObjects(planetMeshes, false)[0];
    if (planetHit) {
      var pid = Object.keys(planetEntries).filter(function (id) { return planetEntries[id].mesh === planetHit.object; })[0];
      return { kind: 'planet', id: pid };
    }
    return null;
  }

  function onClick(evt) {
    if (camController.wasDragged()) { camController.clearDragFlag(); return; }
    var hit = resolveHit(evt.clientX, evt.clientY);
    if (hit && callbacks.onClick) callbacks.onClick(hit);
    else if (!hit && callbacks.onEmptyClick) callbacks.onEmptyClick();
  }
  function onDblClick(evt) {
    var hit = resolveHit(evt.clientX, evt.clientY);
    if (!hit) camController.reset();
  }
  function onMouseMove(evt) {
    var hit = resolveHit(evt.clientX, evt.clientY);
    if (hit && callbacks.onHover) callbacks.onHover(hit, evt.clientX, evt.clientY);
    else if (!hit && callbacks.onHoverEnd) callbacks.onHoverEnd();
  }
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('mousemove', onMouseMove);

  /* ---- animation loop ---- */
  var rafId = null;
  function frame(timestamp) {
    rafId = requestAnimationFrame(frame);

    var planets = dataProvider.getPlanets();
    var ships = dataProvider.getShips();
    var orbitClock = dataProvider.getOrbitClock();

    syncPlanets(planets);
    syncShips(ships);
    placePlanets(planets, orbitClock);
    placeShips(ships, timestamp);

    var pulse = 0.95 + 0.05 * Math.sin(timestamp * 0.0009);
    coronaSprite.scale.set(5.5 * pulse, 5.5 * pulse, 1);
    sunMesh.rotation.y += 0.0006;

    twinkleStars(timestamp);

    var viewport = dataProvider.getViewport ? dataProvider.getViewport() : { width: window.innerWidth, height: window.innerHeight };
    updateLabels(planets, viewport.width, viewport.height);

    composer.render();
  }
  rafId = requestAnimationFrame(frame);

  return {
    resize: resize,
    // Also reapplies the viewport (aspect + setViewOffset), not just orbit angle/zoom, so
    // Fit is a real recovery path even if some future caller forgets to invoke resize()
    // after a layout change (the drawer/sidebar mis-frame bug was exactly that: nothing
    // told this module its viewport had changed, and resetCamera alone couldn't recover it).
    resetCamera: function () {
      camController.reset();
      applyViewport();
    },
    renderer: renderer,
    scene: scene,
    camera: camera,
    dispose: function () {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('mousemove', onMouseMove);
      camController.dispose();
      labels.dispose();
      Object.keys(planetEntries).forEach(function (id) {
        var entry = planetEntries[id];
        disposeObject(entry.group);
        entry.orbitLine.geometry.dispose();
        entry.orbitLine.material.dispose();
        if (entry.freighter) disposeObject(entry.freighter.mesh);
        entry.moons.forEach(function (m) { disposeObject(m.mesh); });
      });
      Object.keys(shipEntries).forEach(function (id) {
        disposeObject(shipEntries[id].mesh);
        shipEntries[id].glow.material.dispose();
        shipEntries[id].trailLine.geometry.dispose();
        shipEntries[id].trailLine.material.dispose();
      });
      composer.dispose();
      renderer.dispose();
    }
  };
}
