# Slop Filter

Filter LinkedIn posts by the writing patterns you personally dislike. All matching and preferences stay in your browser. No model, API key, account, or backend is required.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this project's `extension/` folder.
4. Pin Slop Filter, then refresh LinkedIn. Open the extension to choose your tells.

## Use

One selected tell or custom phrase folds a matching post. Fifteen tells include Doom bait, Job, Stacked slogans, Hashtag carpets, Choppy prose, Leading spaces, and Hook question ending. Custom phrases use literal, case-insensitive matching.

Each folded card explains why it matched. Eye/eye-off shows or folds a post; the checkmark keeps it visible for this visit; the heart exempts that author from filtering. Slop Magnet reverses which posts are shown. Desktop feed-edge buttons collapse the left and right sidebars. Unknown layouts stay visible.

Export/import a preset to share tells and custom phrases. Favorite authors and layout preferences are not exported. Review your custom phrases before sharing a preset.

These are writing preferences, not proof of AI authorship. Image-only matching checks image presence and caption absence; it does not read text inside an image.

LinkedIn's [published policy](https://www.linkedin.com/help/linkedin/answer/a1341387/) prohibits extensions that modify its appearance and says prohibited-tool use can lead to account restriction. This extension changes the feed's appearance. Use are your own risk.

## Development

```sh
npm test
npm run package
```

No npm dependencies or build step. Edit `extension/`, reload the extension, then refresh the feed. Packaging produces runtime and friend ZIPs plus SHA-256 checksums under ignored `output/`. The friend ZIP includes `START-HERE.html`.

The fictional HTML fixture and browser assertions are in `tests/`. Browser integration requires an extension-enabled Chromium context; the unit suite runs directly with Node.js. This imported beta has no cross-platform live LinkedIn certification. See [PRIVACY.md](PRIVACY.md) and [LICENSE](LICENSE).
