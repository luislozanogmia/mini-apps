(async () => {
  'use strict';
  const SF = globalThis.SlopFilter, $ = id => document.getElementById(id);
  let settings, pendingImport, noticeTimer, saving = Promise.resolve();
  let feedLayout = SF.normalizeLayout();
  function renderLayout() { $('hide-left').checked = feedLayout.hideLeft; $('hide-right').checked = feedLayout.hideRight; }
  const loved = new Map();
  function renderLoved() {
    const list = $('loved-authors'); list.replaceChildren();
    if (!loved.size) { const text = document.createElement('p'); text.className = 'muted'; text.textContent = 'Use “I ❤️ this author” on an expanded post to always show their posts.'; list.append(text); }
    for (const [id, name] of loved) {
      const row = document.createElement('div'); row.className = 'field-footer';
      const label = document.createElement('span'); label.textContent = name; label.title = id;
      const button = document.createElement('button'); button.className = 'small-button'; button.textContent = 'Remove'; button.setAttribute('aria-label', `Remove ${name} from favorite authors`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await chrome.storage.local.remove(SF.AUTHOR_PREFIX + id); }
        catch { button.disabled = false; notice('Could not remove author. Try again.'); }
      }); row.append(label, button); list.append(row);
    }
  }
  function updateLoved(data) {
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith(SF.AUTHOR_PREFIX)) continue;
      const id = key.slice(SF.AUTHOR_PREFIX.length);
      if (SF.authorIdentity(id) !== id) continue;
      if (typeof value === 'string' && value) loved.set(id, value.slice(0, 120)); else loved.delete(id);
    }
    renderLoved();
  }
  function notice(message) { $('status').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('status').textContent = ''; }, 5000); }
  function save() {
    const snapshot = SF.normalize(settings);
    // Serialize writes so rapid clicks cannot let an older write win.
    saving = saving.catch(() => {}).then(() => chrome.storage.local.set({ settings: snapshot }));
    saving.catch(() => notice('Could not save. Reopen the extension and try again.'));
    render();
    return saving;
  }
  function render() {
    $('enabled').checked = settings.enabled;
    $('state-label').textContent = !settings.enabled ? 'PAUSED · POSTS VISIBLE' : settings.mode === 'magnet' ? 'SLOP MAGNET IS ON' : 'LOCAL & PRIVATE';
    $('mode').checked = settings.mode === 'magnet';
    $('selected-count').textContent = `${settings.tells.length} of ${SF.RULES.length} selected`;
    document.querySelectorAll('[data-tell]').forEach(input => { input.checked = settings.tells.includes(input.dataset.tell); });
    sample();
  }
  function sample() {
    const node = $('sample-result'); node.replaceChildren();
    if (!$('sample').value.trim()) { node.textContent = 'Paste some text to see what matches.'; return; }
    const result = SF.analyze($('sample').value, settings);
    // The text tester has no image; image-only matching is checked on actual posts.
    const collapse = settings.mode === 'magnet' ? !result.flagged : result.flagged;
    node.textContent = `${result.count} selected tell${result.count === 1 ? '' : 's'} matched. ${!settings.enabled ? 'Filtering is paused.' : collapse ? 'This post would be folded.' : 'This post stays visible.'}`;
    const list = document.createElement('ul');
    result.matches.forEach(m => { const li = document.createElement('li'); li.textContent = `${m.name}: ${m.evidence}`; list.append(li); }); node.append(list);
  }
  // Disable controls while loading: never overwrite saved settings with defaults.
  const controls = [...document.querySelectorAll('input, button, select, textarea')]; controls.forEach(n => { n.disabled = true; });
  try { const data = await chrome.storage.local.get(null); settings = SF.normalize(data.settings); feedLayout = SF.normalizeLayout(data.feedLayout); renderLayout(); updateLoved(data); }
  catch { notice('Settings could not be loaded. Close and reopen the extension.'); return; }
  controls.forEach(n => { n.disabled = false; });
  for (const rule of SF.RULES) {
    const label = document.createElement('label'); label.className = 'tell';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.tell = rule.id;
    const text = document.createElement('span'), title = document.createElement('strong'), detail = document.createElement('small'), example = document.createElement('span');
    title.textContent = rule.name; detail.textContent = rule.detail; example.textContent = rule.examples; example.className = 'example';
    text.append(title, detail, example); label.append(input, text); $('tells').append(label);
    input.addEventListener('change', () => { settings.tells = [...document.querySelectorAll('[data-tell]:checked')].map(n => n.dataset.tell); save(); });
  }
  $('phrases').value = settings.phrases.join('\n'); render();
  for (const [id, key] of [['hide-left', 'hideLeft'], ['hide-right', 'hideRight']]) {
    $(id).addEventListener('change', () => {
      feedLayout[key] = $(id).checked;
      const snapshot = SF.normalizeLayout(feedLayout);
      saving = saving.catch(() => {}).then(() => chrome.storage.local.set({feedLayout:snapshot}));
      saving.catch(() => notice('Could not save the layout. Try again.'));
    });
  }

  $('enabled').addEventListener('change', () => { settings.enabled = $('enabled').checked; save(); });
  $('mode').addEventListener('change', () => { settings.mode = $('mode').checked ? 'magnet' : 'filter'; save(); });
  $('save-phrases').addEventListener('click', async () => {
    const phrases = $('phrases').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (phrases.length > 30 || phrases.some(s => s.length < 2 || s.length > 100)) { notice('Use up to 30 phrases, each 2–100 characters long.'); return; }
    settings.phrases = SF.normalize({ ...settings, phrases }).phrases;
    try { await save(); $('phrases').value = settings.phrases.join('\n'); notice('Your phrases are saved.'); } catch { /* save reports the failure */ }
  });
  $('sample').addEventListener('input', sample);
  $('export').addEventListener('click', () => {
    const blob = new Blob([SF.exportPreset(settings, $('preset-name').value || 'My slop filter')], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'my-slop-filter.preset.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice('Send the downloaded preset to a friend with Slop Filter.');
  });
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; $('import-file').value = '';
    pendingImport = null; $('import-preview').hidden = true;
    if (!file) return;
    try {
      if (file.size > 16000) throw new Error('Preset is too large. Maximum size is 16 KB.');
      pendingImport = SF.importPreset(await file.text());
      $('import-name').textContent = pendingImport.name;
      const s = pendingImport.settings;
      $('import-summary').textContent = `${s.tells.length} categories · ${s.phrases.length} custom phrases · folds on any match. This replaces your current tells and phrases.`;
      $('import-details').replaceChildren();
      [...s.tells.map(id => SF.RULES.find(r => r.id === id).name), ...s.phrases.map(p => `Phrase: ${p}`)].forEach(text => { const li = document.createElement('li'); li.textContent = text; $('import-details').append(li); });
      $('import-preview').hidden = false;
    } catch (error) { notice(error.message); }
  });
  $('apply-import').addEventListener('click', async () => {
    if (!pendingImport) return;
    const imported = pendingImport;
    $('apply-import').disabled = true; $('cancel-import').disabled = true; $('import').disabled = true;
    settings = SF.normalize({ ...imported.settings, enabled: settings.enabled, mode: settings.mode });
    try { await save(); $('phrases').value = settings.phrases.join('\n'); $('preset-name').value = imported.name; pendingImport = null; $('import-preview').hidden = true; notice('Preset applied. Your LinkedIn feed will update.'); }
    catch { /* save reports the failure */ }
    finally { $('apply-import').disabled = false; $('cancel-import').disabled = false; $('import').disabled = false; }
  });
  $('cancel-import').addEventListener('click', () => { pendingImport = null; $('import-preview').hidden = true; });
  // Keep the popup and a full settings tab consistent when both are open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.feedLayout) { feedLayout = SF.normalizeLayout(changes.feedLayout.newValue); renderLayout(); }
    updateLoved(Object.fromEntries(Object.entries(changes).map(([k,v]) => [k,v.newValue])));
    if (!changes.settings) return;
    const draftDirty = $('phrases').value !== settings.phrases.join('\n');
    settings = SF.normalize(changes.settings.newValue); if (!draftDirty) $('phrases').value = settings.phrases.join('\n'); render();
  });
})();
