/* Shared by the isolated content world, settings, and Node tests. No network. */
(function (root) {
  'use strict';
  function choppyProse(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 3 || /```|~~~/.test(text)) return false;
    const listLines = lines.filter(line => /^(?:[-*•▪◦]|\d+[.)]|[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?)\s/u.test(line));
    if (listLines.length >= lines.length / 2 || lines.some(line => /^(?:https?:\/\/|\||\s*(?:const |let |function |def |import |class ))/.test(line))) return false;
    const short = lines.filter(line => line.length <= 90).length;
    const average = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
    return short / lines.length >= .8 && average <= 65 && lines.join('').length >= 30 && (/\n[ \t]*\n/.test(text) || lines.length >= 5);
  }
  function closingLine(text) {
    const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    while (lines.length && /^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(lines.at(-1))) lines.pop();
    return lines.at(-1) || '';
  }
  function hookQuestion(text) {
    const ending = closingLine(text);
    return /\?[\s"'‘’“”)\]!.\p{Extended_Pictographic}\uFE0F\u200D]*$/u.test(ending) || /(?:^|[.!?]\s+)what\s+(?:do\s+)?you(?:\s+(?:guys|all))?\s+(?:think|things?)(?:\s+(?:of|about)\s+(?:this|that|it))?\s*[.!?]*$/i.test(ending);
  }
  function jobPost(text, context) {
    return context.hasJobCard === true || /\b(?:we(?:'re| are)|i(?:'m| am)|our team is)\s+#?hiring\b/i.test(text) || /\b(?:estamos contratando|tenemos (?:una |nuevas |varias )?vacantes?)\b/i.test(text);
  }
  function doomMatches(text) {
    const hits = [];
    for (const pattern of [
      /\byou(?:'re| are) next\b/i,
      /\badapt or die\b/i,
      /\b(?:you(?:'ll| will) be|(?:don't|do not) get|(?:you(?:'re| are)) being) left behind\b/i,
      /\b(?:adapt|evolve|innovate|change) or (?:get |be )?left behind\b/i
    ]) { const match = text.match(pattern); if (match) hits.push(match[0]); }
    // Short declarative headlines: X is dead. Exclude literal death/failure subjects.
    for (const match of text.matchAll(/(?:^|[.!?\n]\s*)["“']?([^.!?\n]{1,70}?\s+is\s+dead)(?=\s*(?:$|[.!\n"”'—–:;]|-(?:\s|$)))/gim)) {
      const subject = match[1].replace(/\s+is\s+dead$/i, '').trim();
      if (subject.split(/\s+/).length > 6 || /\b(?:he|she|someone|anyone|person|people|patient|father|mother|dad|mom|friend|brother|sister|child|dog|cat|pet|battery|phone|laptop|computer|server|process|connection|device|plant|tree|mouse|keyboard)\b/i.test(subject)) continue;
      hits.push(match[1].trim());
    }
    return [...new Set(hits)].slice(0, 5);
  }
  function sloganMatch(text) {
    const fragments = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i <= fragments.length - 3; i++) {
      const group = fragments.slice(i, i + 3);
      if (group.every(s => s.length <= 55 && s.split(/\s+/).length <= 5) && group.filter(s => /^no\s+\S/i.test(s)).length >= 2) return group.join('. ') + '.';
    }
    return '';
  }
  function indentedLine(text) { return text.match(/^[ \t]+\S[^\r\n]*/m)?.[0] || ''; }
  const RULES = [
    { id: 'job', name: 'Job', detail: 'Hiring announcements and LinkedIn job cards.', examples: '“We’re hiring. Apply today.”', test: jobPost },
    { id: 'engagement', name: 'Engagement bait', detail: 'Comment a keyword, agree?, repost this.', examples: '“Comment GUIDE and I’ll send it.”', patterns: [/\bcomment\s+["“'‘]?[\w-]+["”'’]?\s+(?:below\b|and\b|to\s+(?:get|receive|unlock)\b)/i, /\b(?:agree\s*\?|thoughts\s*\?)/i, /\b(?:repost|share)\s+(?:this|if you)\b/i] },
    { id: 'doom', name: 'Doom bait', detail: 'Fear hooks: you’re next, adapt or die, and “X is dead” declarations.', examples: '“SEO is dead. Adapt or die.”', test: text => doomMatches(text).length > 0, evidence: text => doomMatches(text).join(' · ').slice(0, 220) },
    { id: 'hooks', name: 'Manufactured suspense', detail: 'Big reveals and “read that again” hooks.', examples: '“What happened next shocked me.”', patterns: [/\bwhat happened next\b/i, /\b(?:read|let that sink in|read that)\s*(?:that\s+)?again\b/i, /\blet that sink in\b/i, /\b(?:nobody|no one)\s+(?:is talking|talks|tells you)\b/i, /\b(?:here'?s|here is)\s+(?:the (?:hard )?truth|what nobody)\b/i] },
    { id: 'contrast', name: 'Formulaic contrasts', detail: '“It’s not about X. It’s about Y.”', examples: '“It’s not about tools. It’s about people.”', patterns: [/\b(?:it['’]?s|it is|this is|that['’]?s)\s+not\s+(?:just\s+)?about\b[^.!?\n]{1,180}[.!?\n]+\s*(?:it['’]?s|it is|this is|that['’]?s)\s+about\b/i, /\b(?:stop|quit)\s+[^.!?\n]{2,90}[.!?\n]+\s*start\s+/i] },
    { id: 'hustle', name: 'Hustle sermons', detail: 'The grind, comfort zones, and 10x everything.', examples: '“Your network is your net worth.”', patterns: [/\byour network is your net worth\b/i, /\b(?:escape|leave|outside|out of)\s+(?:of\s+)?(?:your|the)\s+comfort zone\b/i, /\b(?:rise and grind|hustle harder|10x your|winners never quit|while you were sleeping)\b/i] },
    { id: 'story', name: 'Canned life lessons', detail: 'Ordinary moments turned into business parables.', examples: '“Here’s what it taught me about leadership.”', patterns: [/\b(?:what|everything)\s+(?:it|that|\w+)\s+taught me about\b/i, /\b(?:here are|here'?s)\s+(?:my\s+)?\d+\s+(?:lessons|learnings|takeaways)\b/i, /\bi (?:was rejected|got rejected)\s+(?:by\s+)?\d+\b/i] },
    { id: 'buzzwords', name: 'Buzzword soup', detail: 'Several vague corporate phrases in one post.', examples: '“Leverage synergies to unlock game-changing value.”', min: 2, patterns: [/\bleverage\b/i, /\bsynerg(?:y|ies|istic)\b/i, /\bgame[- ]chang(?:ing|er)\b/i, /\bunlock (?:your |the |our )?(?:potential|value|power)\b/i, /\bparadigm shift\b/i, /\bever[- ]evolving landscape\b/i, /\bseamlessly\b/i] },
    { id: 'lists', name: 'Emoji list overload', detail: 'At least four lines starting with emoji bullets.', examples: '“🚀 … / 🔥 … / 💡 … / ✅ …”', test: text => (text.match(/^\s*(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?)[ \t]+\S/gmu) || []).length >= 4 },
    { id: 'prose', name: 'Choppy prose', detail: 'Short lines and tiny paragraphs, broken up for dramatic effect.', examples: '“A short thought. ↵ Another short thought. ↵ A big pause.”', test: choppyProse, evidence: text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).join(' ↵ ').slice(0, 220) },
    { id: 'slogans', name: 'Stacked slogans', detail: 'Three punchy fragments, with repeated “No…” openings.', examples: '“No equity. No fees. Fully virtual.”', test: text => !!sloganMatch(text), evidence: sloganMatch },
    { id: 'leadingSpaces', name: 'Leading spaces', detail: 'A written line starts with a space or tab.', examples: '“First line ↵ ␠Next line”', test: text => !!indentedLine(text), evidence: text => indentedLine(text).replace(/^[ \t]+/, spaces => spaces.slice(0, 8).replace(/ /g, '␠').replace(/\t/g, '⇥')).slice(0, 200) },
    { id: 'imageOnly', name: 'Image-only posts', detail: 'A post image with no written caption.', examples: 'A picture doing all the talking.', test: (text, context) => context.hasPostImage === true && !text.trim() },
    { id: 'questionEnding', name: 'Hook question ending', detail: 'Ends with a question or asks what you guys think.', examples: '“What do you guys think?”', test: hookQuestion, evidence: text => closingLine(text).slice(-200) },
    { id: 'hashtags', name: 'Hashtag carpets', detail: 'Six or more hashtags in a post.', examples: '“#growth #mindset #hustle #success #leader #winning”', test: text => (text.match(/#[\p{L}\p{N}_]+/gu) || []).length >= 6 }
  ];
  const DEFAULTS = { version: 1, enabled: true, mode: 'filter', threshold: 1, tells: ['engagement', 'hooks', 'contrast', 'story', 'buzzwords'], phrases: [] };
  const PRESETS = {
    gentle: { ...DEFAULTS, threshold: 1, tells: ['engagement', 'hooks', 'story'] },
    balanced: DEFAULTS,
    spicy: { ...DEFAULTS, threshold: 1, tells: RULES.map(r => r.id) }
  };
  function canonical(text) { return text.normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase(); }
  function uniquePhrases(phrases) {
    const seen = new Set();
    return phrases.filter(p => { const key = canonical(p); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function normalize(value) {
    const v = value && typeof value === 'object' ? value : {};
    return { version: 1, enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
      mode: v.mode === 'magnet' ? 'magnet' : 'filter',
      threshold: 1,
      tells: Array.isArray(v.tells) ? [...new Set(v.tells.filter(id => RULES.some(r => r.id === id)))] : [...DEFAULTS.tells],
      phrases: Array.isArray(v.phrases) ? uniquePhrases(v.phrases.filter(p => typeof p === 'string').map(p => p.trim()).filter(p => p.length >= 2 && p.length <= 100)).slice(0, 30) : [] };
  }
  function analyze(raw, config, context = {}) {
    const settings = normalize(config);
    const text = String(raw || '').slice(0, 30000).normalize('NFKC').replace(/[‘’]/g, "'").replace(/\u00a0/g, ' ');
    const matches = [];
    const isJob = jobPost(text, context);
    for (const rule of RULES) {
      if (!settings.tells.includes(rule.id)) continue;
      let hits = (rule.patterns || []).map(p => text.match(p)).filter(Boolean);
      // Sharing an actual vacancy is expected, not generic engagement bait.
      // Still honor other selected tells and literal custom phrases.
      if (isJob && rule.id === 'engagement') hits = hits.filter(hit => !/^(?:repost|share)\s/i.test(hit[0]));
      if (rule.test ? rule.test(text, context) : hits.length >= (rule.min || 1)) {
        matches.push({ id: rule.id, name: rule.name, evidence: rule.evidence ? rule.evidence(text) : hits.length ? hits.map(m => m[0]).join(' · ').slice(0, 220) : rule.detail });
      }
    }
    for (const phrase of settings.phrases) {
      if (canonical(text).includes(canonical(phrase))) {
        matches.push({ id: 'custom:' + phrase, name: 'Your phrase', evidence: phrase });
      }
    }
    return { matches, count: matches.length, flagged: matches.length >= settings.threshold };
  }
  function exportPreset(config, name = 'My slop filter') {
    const s = normalize(config);
    return JSON.stringify({ format: 'slop-filter-preset', version: 1, name: String(name).slice(0, 80), settings: { tells: s.tells, phrases: s.phrases, threshold: s.threshold } }, null, 2);
  }
  function importPreset(raw) {
    if (typeof raw !== 'string' || raw.length > 16000) throw new Error('Choose a Slop Filter preset smaller than 16 KB.');
    let v; try { v = JSON.parse(raw); } catch { throw new Error('That file is not valid JSON.'); }
    const s = v?.settings;
    if (v?.format !== 'slop-filter-preset' || v.version !== 1 || !s || !Array.isArray(s.tells) || !Array.isArray(s.phrases) || !Number.isInteger(s.threshold) || s.threshold < 1 || s.threshold > 5 || s.tells.length > RULES.length || s.tells.some(id => !RULES.some(r => r.id === id)) || s.phrases.length > 30 || s.phrases.some(p => typeof p !== 'string' || p.trim().length < 2 || p.length > 100)) throw new Error('Unsupported preset. Use version 1 with known tells, up to 30 phrases, and a threshold from 1 to 5.');
    return { name: typeof v.name === 'string' ? v.name.slice(0, 80) : 'Shared preset', settings: normalize(s) };
  }
  const AUTHOR_PREFIX = 'lovedAuthor:';
  function authorIdentity(raw) {
    try {
      const url = new URL(raw, 'https://www.linkedin.com');
      if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || !/^\/(?:in|company)\/[^/]+\/?$/.test(url.pathname)) return '';
      return url.pathname.replace(/\/$/, '').toLowerCase();
    } catch { return ''; }
  }
  function normalizeLayout(value) { return { hideLeft: value?.hideLeft === true, hideRight: value?.hideRight === true }; }
  const api = { normalizeLayout, AUTHOR_PREFIX, authorIdentity, RULES, DEFAULTS, PRESETS, normalize, analyze, exportPreset, importPreset };
  root.SlopFilter = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
