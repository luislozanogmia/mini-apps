# Import verification

This collection imports six independent projects into a fresh source-only history. Existing source repositories are retained.

| Criterion | Evidence |
| --- | --- |
| Apps, utilities, and ContextRAG in the requested folders | Source inventory reviewed; ContextRAG is under `harness/contextrag/`. |
| No personal operational configuration | Working config, machine inventories, backups, browser profiles, captures, and private notes excluded; source snapshot passed targeted path/infrastructure checks and Gitleaks. |
| Clean Galaxy defaults | Isolated server first run returned empty planets, generic labels, and a disabled document endpoint. |
| Local service access boundaries | Two Node tests plus real HTTP/WebSocket smoke checks: local access accepted; hostile Host, Origin, and Fetch-Site rejected. |
| Slop Filter rules and package | 30 Node tests passed; allowlisted runtime/friend ZIPs built with checksums. |
| ContextRAG | Offline HTML extraction → snippets → evidence composition preserved a numeric fact and source URL. The imported citation regex emits a Python FutureWarning. |
| Source syntax | Python AST, Node JavaScript syntax, and JSON parsing passed. |
| Independent review | Source/privacy/request-boundary review completed; missing upstream Three.js license and stale Electron documentation corrected. |

Not revalidated during consolidation: live LinkedIn DOM behavior, manual UI interactions, remote SSH/VNC, Windows local terminal lifecycle, CUDA hardware behavior, macOS Accessibility permissions/window movement, React type checking, and packaged Electron installs. These remain unverified for this import. Tests establish the stated local evidence only.

Imported MIT copyright notices are preserved. Local runtime files remain ignored; review personal settings before exporting or sharing them.
