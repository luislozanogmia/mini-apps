'use strict';

const fs = require('fs');
const path = require('path');
const { backupFile } = require('./backup');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DEFAULTS = { treeTitle: 'Galaxy', sunName: 'Workspace' };

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    treeTitle: parsed.treeTitle || DEFAULTS.treeTitle,
    sunName: parsed.sunName || DEFAULTS.sunName,
  };
}

function saveConfig(partial) {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  backupFile(CONFIG_PATH, 'config');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = { loadConfig, saveConfig };
