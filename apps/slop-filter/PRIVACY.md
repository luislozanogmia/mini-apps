# Slop Filter privacy

Version 0.1.15. Slop Filter processes recognized LinkedIn post text locally in the user's browser to match the user's chosen writing patterns. It does not collect, transmit, sell, or share post text, personal information, analytics, or browsing history. There is no server, telemetry, remote model, or account.

The extension requests storage permission and content-script access to www.linkedin.com. It stores filter preferences and explicitly favorited author identities on the device using chrome.storage.local. Post text is held temporarily in the active tab's memory to recognize updates and is not written to storage. Data is not synchronized with Chrome Sync.

Preset export is an explicit download containing the preset name, selected categories, threshold, and custom phrases. Users choose whether to share that file; custom phrases are included in it. Import is validated locally and previewed before applying.

Disabling the filter restores collapsed posts. Uninstalling removes extension settings. Exported preset files remain until the user removes them. The extension does not make LinkedIn account changes, click LinkedIn action buttons, or send network requests.

Favorite authors store only the selected author’s LinkedIn profile/company path and displayed name in extension-local storage. They are not included in preset exports. Remove them in Authors you ❤️.

Feed layout preferences (hide left/right sidebar) are also saved locally. They are not included in tell preset exports.
