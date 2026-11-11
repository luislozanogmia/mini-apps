'use strict';

const pty = require('node-pty');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { getPlanet } = require('./planets');
const { sshTargetFor, SSH_BIN } = require('./status');

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TASKLIST_BIN = process.env.GALAXY_TASKLIST_BIN || 'tasklist.exe';
const TASKKILL_BIN = process.env.GALAXY_TASKKILL_BIN || 'taskkill.exe';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Kills the FULL process tree rooted at pid (the pty child we spawned) —
// this is what actually reaps orphaned local shells / ssh helper processes
// that a plain ptyProcess.kill() leaves behind on Windows. Never touches
// remote hosts: killing the local ssh.exe client is exactly what detaches
// from a remote tmux session, the tmux session itself keeps running there
// by design (that's the whole garrison model).
//
// Guards against PID reuse: before killing, confirms the PID still belongs
// to one of the image names we actually spawned (pwsh.exe/powershell.exe
// locally, ssh.exe remotely). If the PID no longer exists, or now belongs
// to some other process, we skip the kill rather than risk terminating an
// unrelated process that happened to reuse the PID.
async function killProcessTree(pid, expectedImageNames) {
  if (!pid) {
    return { killed: false, reason: 'no pid' };
  }

  const check = await run(TASKLIST_BIN, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const line = check.stdout.trim();
  if (check.err || !line || line.toUpperCase().startsWith('INFO:')) {
    return { killed: false, reason: 'process already gone' };
  }
  const m = line.match(/^"([^"]+)"/);
  const imageName = (m ? m[1] : '').toLowerCase();
  const matches = expectedImageNames.some((n) => imageName === n.toLowerCase());
  if (!matches) {
    return { killed: false, reason: `pid reused by ${imageName || 'unknown process'}, skipped` };
  }

  const kill = await run(TASKKILL_BIN, ['/PID', String(pid), '/T', '/F']);
  if (kill.err) {
    return { killed: false, reason: kill.stderr || kill.err.message };
  }
  return { killed: true, reason: 'ok' };
}

// Default fallback only — callers should pass the client's real initial size
// (see parseSize below) so the pty never has to reprint its first frame at
// the wrong dimensions and again a moment later at the right one.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function spawnLocalShell(cols, rows) {
  try {
    return pty.spawn('pwsh.exe', [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.env.USERPROFILE || process.cwd(),
      env: process.env,
    });
  } catch (err) {
    return pty.spawn('powershell.exe', [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.env.USERPROFILE || process.cwd(),
      env: process.env,
    });
  }
}

// Session names that pre-date galaxy and belong to Workspace directly. "main" is
// remote-workspace's defaultSession — a plain Travel click attaches there by
// default, so this is NOT a hypothetical: without this guard, every ordinary
// Travel to remote-workspace would silently flip mouse mode on the original own session.
const SACRED_SESSIONS = new Set(['main']);

function spawnRemoteShell(planet, session, cols, rows) {
  const target = sshTargetFor(planet);
  // This ssh+tmux invocation IS the live interactive pty (create-or-attach),
  // so there is no separate round trip available to flip these options before
  // the client attaches. Instead we chain them onto the SAME invocation using
  // tmux's own `\;` operator (escaped so the remote shell hands it to tmux
  // literally, not its own command separator) — tmux processes all commands
  // server-side, in order, before the attach fully takes over the terminal.
  // mouse on (see SACRED_SESSIONS above for the "never main" rationale), plus
  // steady block cursor instead of tmux's blink and no full-screen flash on
  // BEL. Runs on every connect (new or re-attach) to a non-sacred session,
  // which is deliberate: it self-heals these on any pre-existing galaxy
  // session created before this fix landed. Per-session (-t <session>), never -g.
  const args = SACRED_SESSIONS.has(session)
    ? ['-t', target, 'tmux', 'new', '-A', '-s', session]
    : [
        '-t', target, 'tmux', 'new', '-A', '-s', session,
        '\\;', 'set-option', '-t', session, 'mouse', 'on',
        '\\;', 'set-option', '-t', session, 'cursor-style', 'block',
        '\\;', 'set-option', '-t', session, 'visual-bell', 'off',
        '\\;', 'set-option', '-t', session, 'bell-action', 'none',
      ];
  return pty.spawn(
    SSH_BIN,
    args,
    {
      name: 'xterm-color',
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env,
    }
  );
}

// Clamp to sane terminal bounds so a malformed/absent query param can't spawn
// a 0-column or absurdly large pty. Falls back to the old hardcoded 80x24
// when the client didn't send a size (older cached frontend, direct WS test).
function parseSize(rawValue, fallback) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(Math.floor(n), 1000);
}

// ---------------------------------------------------------------------------
// Local pty session registry (refresh-proof local terminals, "Option B":
// the server keeps a detached local shell alive across a ws close instead of
// killing it, so a browser refresh doesn't murder the process tree. Remote
// planets need none of this — tmux on the remote host already owns session
// lifetime, and spawnRemoteShell's ws.close()-kills-ssh.exe behavior below
// (in attach()) is exactly what "detach from tmux" is supposed to do. This
// registry and everything below it is LOCAL-ONLY.
// ---------------------------------------------------------------------------

const RING_BUFFER_CAP_BYTES = 200 * 1024;

const DEFAULT_DETACH_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DETACH_TTL_MS = (() => {
  const n = Number(process.env.GALAXY_DETACH_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DETACH_TTL_MS;
})();

// sessionId (uuid) -> entry. sessionId is server-generated and globally
// unique, so this stays a flat map rather than nesting under planetId.
const localSessions = new Map();

function createRingBuffer() {
  return { chunks: [], totalBytes: 0 };
}

// Drops from the oldest end once the buffer exceeds the cap. Also caps a
// single oversized chunk on its own (defensive — real pty chunks are never
// anywhere near 200KB, but this keeps the invariant airtight either way).
function ringBufferPush(rb, buf) {
  rb.chunks.push(buf);
  rb.totalBytes += buf.length;
  while (rb.totalBytes > RING_BUFFER_CAP_BYTES && rb.chunks.length > 1) {
    const removed = rb.chunks.shift();
    rb.totalBytes -= removed.length;
  }
  if (rb.totalBytes > RING_BUFFER_CAP_BYTES && rb.chunks.length === 1) {
    const only = rb.chunks[0];
    const excess = rb.totalBytes - RING_BUFFER_CAP_BYTES;
    rb.chunks[0] = only.subarray(excess);
    rb.totalBytes = rb.chunks[0].length;
  }
}

function ringBufferConcat(rb) {
  return rb.chunks.length ? Buffer.concat(rb.chunks, rb.totalBytes) : Buffer.alloc(0);
}

function sendControl(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendData(ws, buf) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(buf);
  }
}

// Full teardown of a local session: best-effort kill of the pty's process
// tree (PID-reuse guarded, see killProcessTree), clears any pending detach
// timer, and removes it from the registry. Idempotent — safe to call more
// than once for the same sessionId (e.g. both onExit and a racing explicit
// kill message).
async function destroyLocalSession(sessionId, reason) {
  const entry = localSessions.get(sessionId);
  if (!entry) return;
  localSessions.delete(sessionId);
  if (entry.detachTimer) {
    clearTimeout(entry.detachTimer);
    entry.detachTimer = null;
  }
  if (entry.exited) {
    console.log(`[pty-bridge] local session destroyed sid=${sessionId} reason=${reason} (process already exited)`);
    return;
  }
  entry.exited = true;
  try {
    entry.ptyProcess.kill();
  } catch (err) {
    // already dead — fall through to the tree check below anyway
  }
  const result = await killProcessTree(entry.pid, entry.expectedImageNames);
  console.log(`[pty-bridge] local session destroyed sid=${sessionId} reason=${reason} killed=${result.killed} (${result.reason})`);
}

function armDetachTimer(entry) {
  if (entry.detachTimer) {
    clearTimeout(entry.detachTimer);
  }
  entry.detachTimer = setTimeout(() => {
    destroyLocalSession(entry.id, `idle timeout (${DETACH_TTL_MS}ms with no client attached)`);
  }, DETACH_TTL_MS);
  // Never let a detached terminal's timer keep the process alive on its own.
  if (typeof entry.detachTimer.unref === 'function') {
    entry.detachTimer.unref();
  }
}

// Lets the client rebuild its tab strip after a reload: cross-check whatever
// it has in localStorage against this list before recreating a tab, so a
// session that already hit its idle TTL doesn't leave a phantom reattach.
function listLocalSessions() {
  const out = [];
  for (const entry of localSessions.values()) {
    out.push({
      sessionId: entry.id,
      planetId: entry.planetId,
      attached: entry.attached,
      cols: entry.ptyProcess.cols,
      rows: entry.ptyProcess.rows,
      createdAt: entry.createdAt,
    });
  }
  return out;
}

const LOCAL_EXPECTED_IMAGE_NAMES = ['pwsh.exe', 'powershell.exe'];

function attachLocal(ws, planet, requestedSid, initialCols, initialRows) {
  let entry = requestedSid ? localSessions.get(requestedSid) : null;
  if (entry && entry.planetId !== planet.id) {
    // sid belongs to a different planet — shouldn't normally happen (sids are
    // opaque per-tab), treat as not-found rather than trust a mismatched id.
    entry = null;
  }
  const isReattach = !!entry;

  if (!isReattach) {
    let ptyProcess;
    try {
      ptyProcess = spawnLocalShell(initialCols, initialRows);
    } catch (err) {
      ws.close(1011, 'failed to spawn shell');
      return;
    }

    const sessionId = crypto.randomUUID();
    entry = {
      id: sessionId,
      planetId: planet.id,
      ptyProcess,
      pid: ptyProcess.pid,
      expectedImageNames: LOCAL_EXPECTED_IMAGE_NAMES,
      ringBuffer: createRingBuffer(),
      ws: null,
      attached: false,
      detachTimer: null,
      exited: false,
      createdAt: Date.now(),
    };
    localSessions.set(sessionId, entry);

    // Registered ONCE per pty, independent of which ws (if any) is currently
    // attached — always buffers, and only forwards live when someone's
    // listening. This is what lets a detached session keep accumulating
    // scrollback for the next reattach instead of losing everything spawned
    // while nobody was connected.
    ptyProcess.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      ringBufferPush(entry.ringBuffer, buf);
      if (entry.attached) {
        sendData(entry.ws, buf);
      }
    });

    ptyProcess.onExit(() => {
      entry.exited = true;
      if (entry.attached && entry.ws) {
        try { entry.ws.close(); } catch (err) { /* ignore */ }
      }
      destroyLocalSession(sessionId, 'shell process exited on its own');
    });
  }

  // (Re)attach this ws as the session's owner. Cancel any pending idle-kill,
  // evict a stale previous owner if one is somehow still around (defensive —
  // normally the old ws already closed itself before a reconnect with the
  // same sid shows up), then replay the ring buffer BEFORE flipping
  // entry.attached/entry.ws. Node is single-threaded and neither of the two
  // sends below awaits anything, so no live onData chunk can land in between
  // "replay sent" and "now attached" — the ordering is guaranteed by the
  // event loop, not by luck.
  if (entry.detachTimer) {
    clearTimeout(entry.detachTimer);
    entry.detachTimer = null;
  }
  if (entry.ws && entry.ws !== ws && entry.ws.readyState === entry.ws.OPEN) {
    try { entry.ws.close(); } catch (err) { /* ignore */ }
  }

  sendControl(ws, { type: 'hello', sessionId: entry.id, reattached: isReattach });
  const replay = ringBufferConcat(entry.ringBuffer);
  if (replay.length) {
    sendData(ws, replay);
  }
  entry.ws = ws;
  entry.attached = true;

  console.log(`[pty-bridge] local session ${isReattach ? 'reattached' : 'created'} sid=${entry.id} planet=${planet.id} pid=${entry.pid} replayBytes=${replay.length}`);

  // Same resize-hardening shape as the remote path in attach() below: skip
  // no-op sizes, coalesce a burst to the last size within the window.
  const RESIZE_DEBOUNCE_MS = 120;
  let resizeTimer = null;
  let pendingResize = null;

  function applyResize(cols, rows) {
    if (cols === entry.ptyProcess.cols && rows === entry.ptyProcess.rows) {
      return;
    }
    try {
      entry.ptyProcess.resize(cols, rows);
      console.log(`[pty-bridge] resize applied planet=${planet.id} sid=${entry.id} cols=${cols} rows=${rows}`);
    } catch (err) {
      // ignore — pty may already be closing
    }
  }
  // Apply the client's current size right away on (re)attach too, not just
  // on the next explicit resize message — covers a reattach after the
  // browser window itself changed size while detached.
  applyResize(initialCols, initialRows);

  ws.on('message', (raw) => {
    if (entry.ws !== ws) return; // a newer connection already owns this session — ignore stale input
    const text = raw.toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object' && parsed.type === 'resize') {
      const cols = Number(parsed.cols) || DEFAULT_COLS;
      const rows = Number(parsed.rows) || DEFAULT_ROWS;
      pendingResize = { cols, rows };
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (pendingResize) {
          applyResize(pendingResize.cols, pendingResize.rows);
          pendingResize = null;
        }
      }, RESIZE_DEBOUNCE_MS);
      return;
    }

    if (parsed && typeof parsed === 'object' && parsed.type === 'kill') {
      // Explicit tab-close "x" — separate from ws close, which now only
      // detaches. This is the one path that actually ends the session.
      console.log(`[pty-bridge] explicit kill requested sid=${entry.id} planet=${planet.id}`);
      destroyLocalSession(entry.id, 'explicit kill from client');
      try { ws.close(); } catch (err) { /* ignore */ }
      return;
    }

    entry.ptyProcess.write(text);
  });

  ws.on('close', () => {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (entry.ws !== ws) return; // a newer connection already took ownership — nothing to detach
    entry.ws = null;
    entry.attached = false;
    if (entry.exited || !localSessions.has(entry.id)) return; // already torn down via exit/explicit kill
    console.log(`[pty-bridge] local session detached sid=${entry.id} planet=${planet.id}, buffering up to ${Math.round(RING_BUFFER_CAP_BYTES / 1024)}KB for reattach (idle TTL ${DETACH_TTL_MS}ms)`);
    armDetachTimer(entry);
  });
}

function attach(ws, req) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    ws.close(1008, 'bad request');
    return;
  }

  const planetId = url.searchParams.get('planet');
  const sessionParam = url.searchParams.get('session');
  const planet = planetId ? getPlanet(planetId) : null;

  if (!planet) {
    ws.close(1008, 'unknown planet');
    return;
  }

  const session = sessionParam || planet.defaultSession || 'bridge';
  if (!SESSION_RE.test(session)) {
    ws.close(1008, 'invalid session name');
    return;
  }

  // Spawn at the client's real initial size (xterm has already been fitted
  // to its container by the time it opens this connection) instead of a
  // hardcoded 80x24 — avoids the pty painting its first frame at the wrong
  // size and immediately reprinting at the resize.
  const initialCols = parseSize(url.searchParams.get('cols'), DEFAULT_COLS);
  const initialRows = parseSize(url.searchParams.get('rows'), DEFAULT_ROWS);

  // Local planets: refresh-proof detach/reattach registry (see attachLocal
  // above), entirely separate from the remote/tmux path below. sid is the
  // server-generated session id from a previous 'hello', reusing SESSION_RE
  // since a uuid's charset (hex + dashes) is already a subset of it.
  if (planet.kind === 'local') {
    const sid = url.searchParams.get('sid');
    if (sid && !SESSION_RE.test(sid)) {
      ws.close(1008, 'invalid session id');
      return;
    }
    attachLocal(ws, planet, sid, initialCols, initialRows);
    return;
  }

  let ptyProcess;
  try {
    ptyProcess = spawnRemoteShell(planet, session, initialCols, initialRows);
  } catch (err) {
    ws.close(1011, 'failed to spawn shell');
    return;
  }

  const expectedImageNames = ['ssh.exe'];
  let exited = false;

  // Resize hardening: a raw resize on every incoming message (even a no-op
  // repeat, even mid-burst) is what let rapid tab-switch resize storms
  // interrupt an alt-screen TUI's repaint and leave a corrupted row that
  // never self-heals. Two independent guards:
  //   1. Skip entirely if the requested size matches what the pty already is.
  //   2. Coalesce a burst into one applied resize — only the LAST size within
  //      a ~120ms window actually reaches ptyProcess.resize().
  const RESIZE_DEBOUNCE_MS = 120;
  let resizeTimer = null;
  let pendingResize = null;

  function applyResize(cols, rows) {
    if (cols === ptyProcess.cols && rows === ptyProcess.rows) {
      return; // already this size — no-op, don't touch the pty at all
    }
    try {
      ptyProcess.resize(cols, rows);
      console.log(`[pty-bridge] resize applied planet=${planet.id} cols=${cols} rows=${rows}`);
    } catch (err) {
      // ignore resize errors (pty may already be closing)
    }
  }

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(() => {
    exited = true;
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    const text = raw.toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object' && parsed.type === 'resize') {
      const cols = Number(parsed.cols) || 80;
      const rows = Number(parsed.rows) || 24;
      pendingResize = { cols, rows };
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (pendingResize) {
          applyResize(pendingResize.cols, pendingResize.rows);
          pendingResize = null;
        }
      }, RESIZE_DEBOUNCE_MS);
      return;
    }

    ptyProcess.write(text);
  });

  ws.on('close', async () => {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (exited) {
      // pty already exited on its own (onExit already fired) — nothing to reap.
      return;
    }
    const pid = ptyProcess.pid;
    try {
      ptyProcess.kill();
    } catch (err) {
      // already dead — fall through to the tree check below anyway,
      // in case a child survived the parent's own exit.
    }
    const result = await killProcessTree(pid, expectedImageNames);
    console.log(`[pty-bridge] tab closed, kill-tree pid=${pid} killed=${result.killed} (${result.reason})`);
  });
}

module.exports = { attach, SESSION_RE, killProcessTree, listLocalSessions };
