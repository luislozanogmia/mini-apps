'use strict';

const localProcs = require('./local-procs');
const status = require('./status');

// Builds the apps[] array for a planet: one entry per craft item, in order,
// {name, running: true|false|null}. null = cannot determine (offline, no
// matcher configured for that craft entry, or the process check failed).
function computeApps(planet) {
  const craft = planet.craft || [];
  if (craft.length === 0) {
    return [];
  }

  const craftProcs = planet.craftProcs || {};
  const procNames = planet.kind === 'local'
    ? localProcs.getNames()
    : (status.getState(planet.id).procs || null);

  return craft.map((name) => {
    const patterns = craftProcs[name];
    if (!patterns || patterns.length === 0 || procNames === null) {
      return { name, running: null };
    }
    const lowerPatterns = patterns.map((p) => String(p).toLowerCase());
    const running = procNames.some((proc) => {
      const lowerProc = String(proc).toLowerCase();
      return lowerPatterns.some((pat) => lowerProc.includes(pat));
    });
    return { name, running };
  });
}

module.exports = { computeApps };
