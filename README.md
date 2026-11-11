# Mini apps

Small apps, practical utilities, and agent harnesses. Each project runs independently; there is no shared service or account.

| Project | What it does | Run it |
| --- | --- | --- |
| [Slop Filter](apps/slop-filter/) | Fold LinkedIn posts by writing patterns you dislike; choose tells, favorite authors, and collapse sidebars. | Load the Chrome extension folder. |
| [Galaxy](apps/galaxy/) | A local galaxy map for SSH machines, terminal sessions, and agent deployments. | Node.js; optional Electron shell. |
| [GPU Keepalive](tools/gpu-keepalive/) | Experimental NVIDIA GPU power-state helper. | Python + CUDA-enabled PyTorch. |
| [Electron Accessibility](tools/electron-accessibility/) | Initialize macOS accessibility trees for running Electron apps. | Python + PyObjC on macOS. |
| [Electron Window Protection](tools/electron-window-protection/) | Reserve a screen region by moving overlapping windows. | Integrate into an Electron app on macOS. |
| [ContextRAG](harness/contextrag/) | Fetch, extract, and rank web evidence for a model or agent. | Python standard library. |

Download this repository using **Code → Download ZIP**, or clone it. Follow the README inside the project you want. Dependencies are installed per project.

Galaxy starts without configured machines. Local configuration, connection targets, backups, browser profiles, and generated output are excluded from Git. Example files contain generic defaults only.

These are experimental tools, provided as-is. Platform-specific runtime limitations are documented in each project. Original MIT license notices are retained in each imported project; vendored dependencies retain their own notices.

Run portable source checks with `python3 scripts/check.py` (Node.js 22+ and Python 3.10+). These checks need no project dependency installation.
