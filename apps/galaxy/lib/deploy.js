'use strict';

const { execFile } = require('child_process');
const { getPlanet } = require('./planets');
const { sshTargetFor, SSH_BIN } = require('./status');
const { SESSION_RE } = require('./pty-bridge');

const DEPLOY_TIMEOUT_MS = 15000;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      SSH_BIN,
      args,
      { timeout: DEPLOY_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function deploy(planetId, agent) {
  const planet = getPlanet(planetId);
  if (!planet) {
    const err = new Error('unknown planet');
    err.statusCode = 404;
    throw err;
  }
  if (planet.kind === 'local') {
    const err = new Error('cannot deploy to a local planet');
    err.statusCode = 400;
    throw err;
  }

  const deployAgents = planet.deployAgents || {};
  const agentCmd = deployAgents[agent];
  if (!agentCmd) {
    const err = new Error('agent not available on this planet');
    err.statusCode = 400;
    throw err;
  }

  const session = `garrison_${agent}_${Math.floor(Date.now() / 1000)}`;
  if (!SESSION_RE.test(session)) {
    const err = new Error('generated session name invalid');
    err.statusCode = 500;
    throw err;
  }

  const target = sshTargetFor(planet);
  const timestamp = new Date().toISOString();

  await run([target, 'tmux', 'new-session', '-d', '-s', session]);
  // Per-session tmux behavior (-t, never -g): mouse on (see pty-bridge.js
  // comment for the full rationale), plus two cheap/safe display tweaks
  // Use -- steady block cursor instead of tmux's own blink, and no
  // full-screen flash on BEL. Chained into one ssh round trip via tmux's own
  // `\;` operator (same mechanism as the interactive attach path below).
  // Server-wide default and the original own sessions are untouched.
  await run([
    target, 'tmux', 'set-option', '-t', session, 'mouse', 'on',
    '\\;', 'set-option', '-t', session, 'cursor-style', 'block',
    '\\;', 'set-option', '-t', session, 'visual-bell', 'off',
    '\\;', 'set-option', '-t', session, 'bell-action', 'none',
  ]);
  await run([target, 'tmux', 'send-keys', '-t', session, agentCmd, 'Enter']);

  console.log(`[deploy] OK planet=${planetId} session=${session} agent=${agent} at=${timestamp}`);

  return { session };
}

module.exports = { deploy };
