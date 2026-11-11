'use strict';

const fs = require('fs');
const path = require('path');

const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Copies srcPath into backups/<prefix>-<timestamp>.json before any write.
// Returns the backup path, or null if srcPath does not exist yet (nothing to back up).
function backupFile(srcPath, prefix) {
  if (!fs.existsSync(srcPath)) {
    return null;
  }
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
  const dest = path.join(BACKUPS_DIR, `${prefix}-${timestamp()}.json`);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

module.exports = { backupFile, BACKUPS_DIR };
