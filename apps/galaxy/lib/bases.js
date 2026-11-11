'use strict';

const { execFile } = require('child_process');
const { getPlanet } = require('./planets');
const { sshTargetFor, SSH_BIN, refreshPlanet, events } = require('./status');
const { SESSION_RE } = require('./pty-bridge');

const KILL_TIMEOUT_MS = 10000;

function run(args) {
  return new Promise((resolve) => {
    execFile(SSH_BIN, args, { timeout: KILL_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Kills exactly one named tmux session on a remote planet. The session name
// is validated against SESSION_RE before it ever reaches the ssh command
// line, and is passed as a single execFile argument (never shell-interpolated)
// — so there is no way to smuggle extra tmux commands or pattern-kill through
// this path, by construction, not just by convention.
async function killBase(planetId, sessionName) {
  const planet = getPlanet(planetId);
  if (!planet) {
    const err = new Error('unknown planet');
    err.statusCode = 404;
    throw err;
  }

  if (!SESSION_RE.test(sessionName)) {
    const err = new Error('invalid session name');
    err.statusCode = 400;
    throw err;
  }

  if (planet.kind === 'local') {
    const err = new Error('local planets have no tmux sessions');
    err.statusCode = 400;
    throw err;
  }

  const target = sshTargetFor(planet);
  if (!target) {
    const err = new Error('planet has no ssh target configured');
    err.statusCode = 400;
    throw err;
  }

  const timestamp = new Date().toISOString();
  const result = await run([target, 'tmux', 'kill-session', '-t', sessionName]);

  if (result.err) {
    if (/can't find session|session not found/i.test(result.stderr)) {
      console.log(`[bases] kill-session NOT_FOUND planet=${planetId} session=${sessionName} at=${timestamp}`);
      const err = new Error(`session not found: ${sessionName}`);
      err.statusCode = 404;
      throw err;
    }
    console.log(`[bases] kill-session FAILED planet=${planetId} session=${sessionName} at=${timestamp} stderr=${result.stderr.trim()}`);
    const err = new Error(result.stderr.trim() || 'ssh kill-session failed');
    err.statusCode = 502;
    throw err;
  }

  console.log(`[bases] kill-session OK planet=${planetId} session=${sessionName} at=${timestamp}`);

  // Refresh this planet's cached bases immediately (rather than waiting for
  // the next 30s poll) and nudge the existing poll-broadcast pipeline so
  // connected panels see the session disappear right away.
  await refreshPlanet(planet);
  events.emit('poll');

  return { ok: true };
}

module.exports = { killBase };
