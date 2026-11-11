# Electron Accessibility

Initialize accessibility trees for running Electron apps on macOS by reading their accessibility attributes. Apps must already be running, and the calling terminal needs Accessibility permission.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install pyobjc-framework-ApplicationServices pyobjc-framework-Cocoa
python macos_ax_initializer.py --apps slack
```

Use `--list` to list running applications or `--all-running` to inspect all running apps. This does not install or launch apps. Accessibility initialization may need repeating after an app restarts; success depends on that application's accessibility support.

This import has received syntax checks; permission-changing or other-app interactions were not exercised during consolidation.

MIT; see [LICENSE](LICENSE).
