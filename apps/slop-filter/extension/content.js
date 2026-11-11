(() => {
  'use strict';
  const SF = globalThis.SlopFilter;
  const POST = '.feed-shared-update-v2[data-urn], .occludable-update[data-urn], [data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"], [role="listitem"][componentkey^="update-card-focus"]';
  const BODY = '.update-components-text, .feed-shared-update-v2__description, .feed-shared-text, [data-testid="expandable-text-box"]';
  const COMMENTS = '.comments-comments-list, .comments-comment-item, .comments-comment-entity, [componentkey^="CommentComponentReference_"]';
  const records = new Map();
  const pending = new Set();
  const loved = new Map();
  let config = SF.normalize(), feedLayout = SF.normalizeLayout(), timer, ready = false;
  const layouts = new Map();
  let layoutControl = null, layoutSaving = Promise.resolve(), layoutFrame = null;
  const uiStyle = `:host{display:block;color:#203b36;font:13px/1.5 system-ui,sans-serif}*{box-sizing:border-box}.bar{padding:10px 12px;background:#f4f6f0;border:1px solid #dce5dc;border-radius:9px;margin:8px 0}.top{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}.summary{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button{font:inherit;font-size:11px;line-height:16px;white-space:nowrap;flex-shrink:0;border:1px solid #bbcec3;background:white;color:#174c3e;border-radius:7px;padding:5px 7px;width:30px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}button:hover{background:#e9efe3}button:disabled{opacity:.45;cursor:default}svg{width:16px;height:16px;flex-shrink:0}button:focus-visible{outline:3px solid #dd7048;outline-offset:2px}.keep{font-size:11px;padding:5px 7px}`;
  function el(tag, text, cls) { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }
  function iconButton(label, icon) {
    const button = el('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.dataset.icon = icon;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key, value);
    const paths = {
      eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
      'eye-off': ['m3 3 18 18', 'M10.6 5.1A12 12 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 4.1', 'M6.1 6.1A21 21 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.9-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
      checkmark: ['m5 12 4 4L19 6'],
      'sidebar-left': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M9 3v18', 'm7 9-3 3 3 3'],
      'sidebar-left-open': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M9 3v18', 'm4 9 3 3-3 3'],
      'sidebar-right': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M15 3v18', 'm17 9 3 3-3 3'],
      'sidebar-right-open': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M15 3v18', 'm20 9-3 3 3 3'],
      heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z']
    };
    for (const d of paths[icon]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
    button.append(svg); return button;
  }
  // innerText changes when our CSS collapses a post. Read stable DOM text instead,
  // preserving block/BR boundaries so emoji lists and multi-line hooks still match.
  function bodyText(node) {
    if (!node) return '';
    const parts = [], blocks = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'SECTION', 'BLOCKQUOTE']);
    function visit(n) {
      if (n.nodeType === Node.TEXT_NODE) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== Node.ELEMENT_NODE || n.matches('button, script, style, svg, [aria-hidden="true"], .sf-filter-control, .comments-comments-list, .comments-comment-item, .comments-comment-entity, [componentkey^="CommentComponentReference_"]')) return;
      if (n.tagName === 'BR') { parts.push('\n'); return; }
      const block = blocks.has(n.tagName); if (block) parts.push('\n');
      n.childNodes.forEach(visit); if (block) parts.push('\n');
    }
    visit(node); return parts.join('').replace(/^\n+|\n+$/g, '');
  }
  function hasPostImage(post) {
    return [...post.querySelectorAll('img')].some(image => {
      if (image.closest(COMMENTS) || image.closest('a[href*="/in/"], a[href*="/company/"], [data-testid*="avatar"], .update-components-actor, .feed-shared-actor, video, [data-testid*="video"], .update-components-video')) return false;
      // Intrinsic/declared dimensions stay stable while the post is collapsed.
      const width = image.naturalWidth || Number(image.getAttribute('width'));
      const height = image.naturalHeight || Number(image.getAttribute('height'));
      return width >= 240 && height >= 120;
    });
  }
  function authorOf(post, body) {
    const boundary = body || [...post.querySelectorAll('img, video, a[href*="/jobs/view/"]')].find(n => {
      if (n.closest(COMMENTS) || n.closest('a[href*="/in/"], a[href*="/company/"]')) return false;
      return n.tagName !== 'IMG' || (Math.max(n.naturalWidth || 0, Number(n.getAttribute('width'))) >= 240 && Math.max(n.naturalHeight || 0, Number(n.getAttribute('height'))) >= 120);
    });
    const links = [...post.querySelectorAll('a[href]')].filter(a => {
      if (!SF.authorIdentity(a.href) || a.closest(COMMENTS) || a.closest(BODY) || (a.closest('[data-sdui-anchor-id^="feed-header-"]') || a.querySelector('[data-sdui-anchor-id^="feed-header-"]'))) return false;
      if (a.matches('.update-components-actor__meta-link, .feed-shared-actor__meta-link')) return true;
      if (!boundary || !(a.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return (a.hasAttribute('componentkey') && !!a.textContent.trim() && !!a.querySelector('p, [aria-label]'));
    });
    const link = links[0];
    if (!link) return null;
    const name = (link.querySelector('.update-components-actor__name, .feed-shared-actor__name, p')?.textContent || link.textContent).trim().replace(/\s+/g, ' ').slice(0, 120);
    return name ? { id: SF.authorIdentity(link.href), name } : null;
  }
  function updateLoved(changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (!key.startsWith(SF.AUTHOR_PREFIX)) continue;
      const id = key.slice(SF.AUTHOR_PREFIX.length);
      if (SF.authorIdentity(id) !== id) continue;
      if (typeof value === 'string' && value) loved.set(id, value.slice(0, 120)); else loved.delete(id);
    }
  }
  function remove(record, post) { post.classList.remove('sf-filter-collapsed', 'sf-filter-revealed'); record?.host?.remove(); }
  function render(post) {
    if (!post.isConnected) return;
    // Pick the outer post wrapper, never a nested wrapper inside the same post.
    if (post.parentElement?.closest(POST)) return;
    const body = [...post.querySelectorAll(BODY)].find(n => !n.closest(COMMENTS) && n.closest(POST) && post.contains(n));
    const text = bodyText(body);
    const author = authorOf(post, body);
    const isLoved = loved.has(author?.id);
    const hasImage = hasPostImage(post);
    const hasJobCard = [...post.querySelectorAll('a[href*="/jobs/view/"]')].some(link => !link.closest(COMMENTS));
    let r = records.get(post);
    if (!r) { r = { text: '', signature: '', revealed: false, kept: false, host: null }; records.set(post, r); }
    if (r.text !== text || r.hasImage !== hasImage || r.hasJobCard !== hasJobCard || r.authorId !== author?.id || r.isLoved !== isLoved) { r.isLoved = isLoved; r.authorId = author?.id; r.hasImage = hasImage; r.hasJobCard = hasJobCard; r.text = text; r.revealed = false; r.kept = false; r.signature = ''; }
    const result = SF.analyze(text, config, { hasPostImage: hasImage, hasJobCard });
    // Unknown layouts are deliberately left alone, including in Magnet mode.
    const hide = !isLoved && config.enabled && (!!text.trim() || hasImage || hasJobCard) && (config.mode === 'magnet' ? !result.flagged : result.flagged);
    const signature = JSON.stringify([hide, result.matches, config.mode, r.revealed, r.kept, author]);
    if (r.signature === signature && (!hide || r.host?.isConnected)) return;
    r.signature = signature;
    remove(r, post);
    if (!hide || r.kept) { r.host = null; return; }
    const host = el('div', '', 'sf-filter-control');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style', uiStyle); shadow.append(style);
    const bar = el('div', '', 'bar'); const top = el('div', '', 'top');
    const reason = config.mode === 'magnet' ? 'Hidden: no selected tells matched' : 'Flagged: ' + result.matches.map(m => {
      const rule = SF.RULES.find(rule => rule.id === m.id);
      const quote = !rule || rule.patterns || rule.evidence;
      return m.name + (quote ? ` — “${m.evidence}”` : '');
    }).join(' · ');
    const summary = el('span', reason, 'summary'); summary.title = reason; top.append(summary);
    const toggle = iconButton(r.revealed ? 'Collapse post' : 'Show post', r.revealed ? 'eye-off' : 'eye'); toggle.setAttribute('aria-expanded', String(r.revealed));
    toggle.addEventListener('click', () => { r.revealed = !r.revealed; r.signature = ''; render(post); }); top.append(toggle);
    if (r.revealed) {
      const keep = iconButton('Keep visible for this visit', 'checkmark');
      keep.addEventListener('click', () => { r.kept = true; r.signature = ''; render(post); }); top.append(keep);
      const love = iconButton('I ❤️ this author', 'heart'); love.disabled = !author;
      love.title = author ? `I ❤️ this author — always show ${author.name}` : 'I ❤️ this author — author could not be identified safely';
      love.addEventListener('click', async () => {
        love.disabled = true;
        try {
          await chrome.storage.local.set({ [SF.AUTHOR_PREFIX + author.id]: author.name });
          // storage.onChanged is authoritative, including concurrent removals.
        } catch { love.disabled = false; love.title = 'Could not save — click to retry'; }
      }); top.append(love);
    }
    bar.append(top);
    shadow.append(bar); post.prepend(host); r.host = host;
    post.classList.toggle('sf-filter-collapsed', !r.revealed);
    post.classList.toggle('sf-filter-revealed', r.revealed && config.mode === 'filter');
  }
  function positionLayoutControl() {
    layoutFrame = null;
    if (!layoutControl?.isConnected) return;
    const center = [...layouts.values()][0]?.[1];
    if (!center?.isConnected) { layoutControl.hidden = true; return; }
    const box = center.getBoundingClientRect();
    const headerBottom = Math.max(0, ...[...document.querySelectorAll('header, [role="banner"], #global-nav')].map(n => n.getBoundingClientRect()).filter(b => b.width > innerWidth / 2 && b.height > 0 && b.height < 160 && b.top <= 10 && b.bottom > 0).map(b => b.bottom));
    const top = Math.max(box.top + 8, headerBottom + 8);
    layoutControl.hidden = !box.width || box.bottom < top + 28 || box.top > innerHeight;
    layoutControl.style.left = `${box.left}px`;
    layoutControl.style.top = `${top}px`;
    layoutControl.style.width = `${box.width}px`;
  }
  function queueLayoutPosition() {
    if (layoutFrame === null && layoutControl?.isConnected) layoutFrame = requestAnimationFrame(positionLayoutControl);
  }
  function layoutToolbar(onFeed) {
    document.querySelectorAll('.sf-layout-control').forEach(n => { if (!onFeed || n !== layoutControl) n.remove(); });
    if (!onFeed) { layoutControl = null; return; }
    const center = [...layouts.values()][0]?.[1];
    if (!center?.isConnected) { layoutControl?.remove(); layoutControl = null; return; }
    if (!layoutControl?.isConnected) {
      layoutControl?.remove(); layoutControl = null;
      const host = el('div', '', 'sf-layout-control');
      const shadow = host.attachShadow({mode:'open'});
      shadow.append(el('style', uiStyle + ':host{display:block;height:28px;pointer-events:none}.controls{position:relative;width:100%;height:28px}button{position:absolute;top:0;pointer-events:auto;width:24px;height:28px;padding:2px;background:#f4f2ee;border-color:#d1d4cc;color:#666}button[data-side=hideLeft]{left:-24px}button[data-side=hideRight]{right:-24px}button:hover{background:#edf0e6;border-color:#bbcec3;color:#174c3e}button[aria-pressed="true"]{background:#e9efe3;color:#174c3e}svg{width:22px;height:22px}'));
      const group = el('div', '', 'controls'); group.setAttribute('role','group'); group.setAttribute('aria-label','Feed sidebars'); shadow.append(group);
      document.body.append(host); layoutControl = host;
    }
    positionLayoutControl();
    const group = layoutControl.shadowRoot.querySelector('.controls');
    const signature = JSON.stringify(feedLayout);
    if (layoutControl.dataset.state === signature) return;
    const focused = layoutControl.shadowRoot.activeElement?.dataset.side;
    layoutControl.dataset.state = signature; group.replaceChildren();
    for (const [key, side] of [['hideLeft','left'], ['hideRight','right']]) {
      const hidden = feedLayout[key], label = `${hidden ? 'Show' : 'Hide'} ${side} sidebar`;
      const button = iconButton(label, `sidebar-${side}${hidden ? '-open' : ''}`);
      button.setAttribute('aria-pressed', String(hidden)); button.dataset.side = key;
      button.addEventListener('click', () => {
        button.disabled = true;
        layoutSaving = layoutSaving.catch(() => {}).then(async () => {
          const current = SF.normalizeLayout((await chrome.storage.local.get('feedLayout')).feedLayout);
          current[key] = !current[key];
          await chrome.storage.local.set({feedLayout:current});
        });
        layoutSaving.catch(() => { button.disabled = false; button.title = 'Could not save — click to retry'; });
      }); group.append(button);
      if (focused === key) button.focus({preventScroll:true});
    }
  }
  function clearLayout(root, parts) {
    root.classList.remove('sf-feed-layout', 'sf-hide-left', 'sf-hide-right');
    for (const [i, part] of parts.entries()) part.classList.remove(['sf-feed-left', 'sf-feed-center', 'sf-feed-right'][i], 'sf-layout-anchor');
  }
  function applyLayout() {
    const onFeed = /^\/feed(?:\/|$)/.test(location.pathname);
    for (const [root, parts] of layouts) {
      if (!onFeed || !root.isConnected || parts.some(n => n.parentElement !== root)) { clearLayout(root, parts); layouts.delete(root); }
    }
    if (!onFeed) { layoutToolbar(false); return; }
    function mark(root, parts) {
      if (parts.some(n => !n) || parts.some(n => n.parentElement !== root)) return;
      layouts.set(root, parts);
    }
    // Classic LinkedIn layout: identify direct column siblings, never generic asides.
    document.querySelectorAll('.scaffold-layout__main').forEach(center => {
      const root = center.parentElement;
      const left = [...root.children].find(n => n.matches('.scaffold-layout__sidebar'));
      const right = [...root.children].find(n => n.matches('.scaffold-layout__aside'));
      if (left && right) mark(root, [left, center, right]);
    });
    // Modern layouts use generated class names. Recognize only an actual three-column
    // row around the feed, with no posts inside either side column.
    const first = [...document.querySelectorAll(POST)].find(p => !p.parentElement?.closest(POST));
    for (let root = first?.parentElement; root && root !== document.body; root = root.parentElement) {
      if (layouts.has(root)) break;
      const parts = [...root.children].filter(n => !n.matches('script, style, .sf-filter-control') && n.getBoundingClientRect().width > 0);
      if (parts.length !== 3 || !parts[1].contains(first) || parts[0].matches(POST) || parts[2].matches(POST) || parts[0].querySelector(POST) || parts[2].querySelector(POST)) continue;
      const style = getComputedStyle(root), boxes = parts.map(n => n.getBoundingClientRect());
      if (!['grid','flex'].includes(style.display) || root.getBoundingClientRect().width < 900 || boxes.some(b => b.width < 100 || b.height < 80) || !(boxes[0].right <= boxes[1].left + 2 && boxes[1].right <= boxes[2].left + 2)) continue;
      mark(root, parts); break;
    }
    for (const [root, parts] of layouts) {
      const active = feedLayout.hideLeft || feedLayout.hideRight;
      root.classList.toggle('sf-feed-layout', active);
      parts.forEach((n,i) => n.classList.toggle(['sf-feed-left', 'sf-feed-center', 'sf-feed-right'][i], active));
      root.classList.toggle('sf-hide-left', feedLayout.hideLeft);
      root.classList.toggle('sf-hide-right', feedLayout.hideRight);
    }
    layoutToolbar(true);
  }
  function flush() {
    timer = null;
    if (!ready) return;
    applyLayout();
    const batch = [...pending]; pending.clear();
    for (const post of batch) render(post);
    for (const [post, r] of records) if (!post.isConnected) { remove(r, post); records.delete(post); }
  }
  function queue(post) {
    if (post) {
      let parent; while ((parent = post.parentElement?.closest(POST))) post = parent;
      pending.add(post);
    }
    if (!timer && ready) timer = setTimeout(flush, 80);
  }
  function discover(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) { queue(node.parentElement?.closest(POST)); return; }
    if (node.closest('.sf-filter-control, .sf-layout-control')) return;
    queue(node.closest(POST));
    node.querySelectorAll(POST).forEach(queue);
  }
  const observer = new MutationObserver(changes => {
    for (const change of changes) {
      const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
      if (target?.closest('.sf-filter-control, .sf-layout-control')) continue;
      if (change.type === 'attributes') { discover(target); continue; }
      queue(target?.closest(POST));
      change.addedNodes.forEach(discover);
      // Removals also schedule cleanup, keeping the registry bounded on virtualized feeds.
      if (change.removedNodes.length && !timer && ready) timer = setTimeout(flush, 80);
    }
  });
  window.addEventListener('scroll', queueLayoutPosition, {passive:true,capture:true});
  window.addEventListener('resize', () => { queueLayoutPosition(); queue(null); });
  window.addEventListener('popstate', () => queue(null));
  document.addEventListener('load', event => { if (event.target instanceof HTMLImageElement) queue(event.target.closest(POST)); }, true);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-urn', 'data-id', 'componentkey', 'data-testid', 'role', 'src', 'srcset', 'width', 'height', 'href'] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.feedLayout) { feedLayout = SF.normalizeLayout(changes.feedLayout.newValue); applyLayout(); }
    updateLoved(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.newValue])));
    if (Object.keys(changes).some(k => k.startsWith(SF.AUTHOR_PREFIX))) document.querySelectorAll(POST).forEach(queue);
    if (changes.settings) { config = SF.normalize(changes.settings.newValue); document.querySelectorAll(POST).forEach(queue); }
  });
  chrome.storage.local.get(null).then(data => { updateLoved(data); feedLayout = SF.normalizeLayout(data.feedLayout); config = SF.normalize(data.settings); ready = true; discover(document.body); }).catch(() => { observer.disconnect(); });
})();
