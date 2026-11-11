'use strict';

const { spawn } = require('child_process');
const { getPlanet } = require('./planets');
const { sshTargetFor, SSH_BIN } = require('./status');

function attach(ws, req) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    ws.close(1008, 'bad request');
    return;
  }

  const planetId = url.searchParams.get('planet');
  const planet = planetId ? getPlanet(planetId) : null;

  if (!planet || !planet.desktop || !planet.desktop.vncHost || !planet.desktop.vncPort) {
    ws.close(1008, 'no desktop configured for this planet');
    return;
  }

  const target = sshTargetFor(planet);
  const forwardTo = `${planet.desktop.vncHost}:${planet.desktop.vncPort}`;

  // Plain byte-pipe tunnel (ssh -W), not a pty: RFB is a binary protocol, not a terminal.
  const child = spawn(SSH_BIN, ['-W', forwardTo, target], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(chunk, { binary: true });
    }
  });

  child.stderr.on('data', () => {
    // ssh diagnostics; tunnel has no separate channel for them, drop silently
  });

  child.on('exit', () => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close();
    }
  });

  child.on('error', () => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1011, 'failed to spawn tunnel');
    }
  });

  ws.on('message', (raw) => {
    if (child.stdin.writable) {
      child.stdin.write(raw);
    }
  });

  ws.on('close', () => {
    try {
      child.kill();
    } catch (err) {
      // already dead
    }
  });
}

module.exports = { attach };
