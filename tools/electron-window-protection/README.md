# Electron Window Protection

A macOS Electron integration that moves overlapping windows away from a configured screen rectangle. Requires Accessibility permission. This is source for integration, not a published npm package.

Copy `src/` into your Electron project. In the main process:

```js
const { app } = require('electron');
const ProtectionManager = require('./src/protection_manager');
const protection = new ProtectionManager({
  area: { x: 0, y: 0, width: 320, height: 1080 },
  excludeApps: ['MyApp', 'SystemUIServer', 'Dock', 'Finder'],
  autoStart: false,
});
app.whenReady().then(() => protection.init());
app.on('before-quit', () => protection.shutdown());
```

Keep `protect_area.applescript` beside the manager. The optional React component is `src/ProtectionControl.tsx`; its IPC methods require your Electron preload bridge. See the component and manager source for the available methods.

Windows/Linux are not implemented. Syntax checks do not validate movement of other apps' windows; this was not exercised during consolidation.

MIT; see [LICENSE](LICENSE).
