const { test } = require('node:test');
const assert = require('node:assert/strict');
const SF = require('../extension/engine.js');
const all = { ...SF.DEFAULTS, tells: SF.RULES.map(r => r.id), threshold: 1 };
test('a normal specific update stays visible', () => {
  assert.equal(SF.analyze('We shipped SQLite support today. Migration takes 30 seconds. The benchmark and limitations are in our docs.', all).flagged, false);
});
test('a repeated tell counts once and any selected match triggers', () => {
  const one = SF.analyze('Agree? Thoughts? Repost this.', SF.DEFAULTS);
  assert.equal(one.count, 1); assert.equal(one.flagged, true);
  const two = SF.analyze('What happened next shocked me. Comment GUIDE and I will send it.', SF.DEFAULTS);
  assert.equal(two.count, 2); assert.equal(two.flagged, true);
});
test('only selected tells count', () => {
  assert.equal(SF.analyze('What happened next? Agree?', { ...all, tells: ['hashtags'] }).count, 0);
});
test('every category has a positive and no generic empty match', () => {
  const cases = { slogans: 'No equity. No fees. Fully virtual.', leadingSpaces: 'First line\n Next line', doom: 'SEO is dead. Adapt or die.', job: "We're hiring. Apply today.", imageOnly: '', questionEnding: 'What do you guys think?', prose: 'A small thought on its own.\n\nAnother thought gets a new line.\n\nOne last dramatic pause.', engagement: 'Comment GUIDE and get a copy.', hooks: 'Let that sink in.', contrast: 'It’s not about tools. It’s about people.', hustle: 'Your network is your net worth.', story: 'Here’s what it taught me about leadership.', buzzwords: 'Leverage synergies for a paradigm shift.', lists: '🚀 One\n🔥 Two\n💡 Three\n✅ Four', hashtags: '#one #two #three #four #five #six' };
  for (const [id, text] of Object.entries(cases)) {
    assert.equal(SF.analyze(text, { ...all, tells: [id] }, { hasPostImage: true }).count, 1, id);
    assert.equal(SF.analyze('', { ...all, tells: [id] }).count, 0, id);
  }
});
test('buzzwords require two different patterns', () => {
  assert.equal(SF.analyze('Leverage leverage leverage.', { ...all, tells: ['buzzwords'] }).flagged, false);
});
test('emoji and hashtags require their documented counts', () => {
  assert.equal(SF.analyze('🚀 One\n🔥 Two\n💡 Three', all).flagged, false);
  assert.equal(SF.analyze('#one #two #three #four #five', all).flagged, false);
});
test('phrases are literal, case insensitive and normalized', () => {
  const s = { ...all, tells: [], phrases: ['[a-z]+', 'thrilled to announce', 'it’s wild'] };
  assert.equal(SF.analyze('THRILLED TO ANNOUNCE', s).count, 1);
  assert.equal(SF.analyze('abc', s).count, 0);
  assert.equal(SF.analyze("it's wild", s).count, 1);
});
test('corrupt saved settings normalize to bounded safe values', () => {
  const s = SF.normalize({ threshold: 999, tells: ['hooks', 'hooks', '__proto__'], phrases: ['x', null, 'okay'], mode: 'nonsense' });
  assert.equal(s.threshold, 1); assert.deepEqual(s.tells, ['hooks']); assert.deepEqual(s.phrases, ['okay']); assert.equal(s.mode, 'filter');
});
test('preset round trip shares preferences, not enabled or mode', () => {
  const json = SF.exportPreset({ ...all, enabled: false, mode: 'magnet', phrases: ['custom'] }, 'Friends');
  const result = SF.importPreset(json);
  assert.equal(result.name, 'Friends'); assert.deepEqual(result.settings.tells, all.tells); assert.deepEqual(result.settings.phrases, ['custom']);
  assert.equal(result.settings.enabled, true); assert.equal(result.settings.mode, 'filter');
  assert.equal(Object.hasOwn(JSON.parse(json).settings, 'mode'), false);
});
test('invalid imports reject instead of mutating or accepting unknown rules', () => {
  for (const raw of ['not json', 'null', '{}', 'x'.repeat(16001), JSON.stringify({ format: 'slop-filter-preset', version: 2, settings: all }), JSON.stringify({ format: 'slop-filter-preset', version: 1, settings: { ...all, tells: ['unknown'] } }), JSON.stringify({ format: 'slop-filter-preset', version: 1, settings: { ...all, phrases: [5] } })]) assert.throws(() => SF.importPreset(raw));
});
test('hostile preset strings remain plain data', () => {
  const p = SF.importPreset(SF.exportPreset({ ...all, phrases: ['<img src=x onerror=alert(1)>'] }, '<script>alert(1)</script>'));
  assert.equal(p.name, '<script>alert(1)</script>'); assert.equal(p.settings.phrases.length, 1);
});
test('manifest permissions are bounded and every runtime file exists', () => {
  const fs = require('node:fs'), path = require('node:path'); const base = path.join(__dirname, '../extension');
  const manifest = require('../extension/manifest.json');
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.linkedin.com/*']);
  for (const name of [...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css, ...Object.values(manifest.icons), manifest.action.default_popup]) assert.ok(fs.existsSync(path.join(base, name)), name);
  for (const name of ['content.js', 'popup.js', 'engine.js']) assert.doesNotMatch(fs.readFileSync(path.join(base, name), 'utf8'), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|innerHTML\s*=/);
});
test('equivalent custom phrases count once under the matching normalization', () => {
  const s = { ...all, tells: [], threshold: 2, phrases: ['Agree?', 'agree?', 'Ａｇｒｅｅ？', 'it’s wild', "it's wild"] };
  assert.equal(SF.analyze('agree?', s).count, 1);
  assert.equal(SF.analyze('agree?', s).flagged, true);
  assert.deepEqual(SF.normalize(s).phrases, ['Agree?', 'it’s wild']);
});

test('choppy prose matches explicit short lines, including an informal example', () => {
  const settings = { ...all, tells: ['prose'] };
  for (const text of ['you sdouhsodosods\nsndosodnosndnsndsndnsdnosd\n\nnodnsodsnds', 'One small thought.\nAnother small thought.\nAnd one more thought.\nThen another thought.\nThe dramatic final thought.']) {
    const result = SF.analyze(text, settings); assert.equal(result.flagged, true); assert.match(result.matches[0].evidence, /↵/);
  }
});
test('prose ignores soft wrapping, two lines, ordinary lists, code and long paragraphs', () => {
  const settings = { ...all, tells: ['prose'] };
  for (const text of [
    'This is a normal continuous paragraph with several sentences. A narrow screen might wrap it across many visual lines, but there are no deliberate line breaks.',
    'One short sentence.\n\nOne other short sentence.',
    '1. Fix the index\n\n2. Run the migration\n\n3. Check the result',
    '- Fix the index\n\n- Run the migration\n\n- Check the result',
    '🚀 Fix the index\n\n🔥 Run the migration\n\n✅ Check the result',
    '```js\nconst a = 1;\n\nconst b = 2;\nconsole.log(a + b);\n```',
    'A lengthy paragraph '.repeat(12)+'\n\n'+'More detailed text '.repeat(12)+'\n\n'+'A final paragraph '.repeat(12)
  ]) assert.equal(SF.analyze(text, settings).flagged, false, text);
});
test('prose remains opt-in for saved and balanced preferences and shares in presets', () => {
  assert.equal(SF.normalize(SF.DEFAULTS).tells.includes('prose'), false);
  assert.equal(SF.normalize({ ...SF.DEFAULTS }).tells.includes('prose'), false);
  const preset = SF.importPreset(SF.exportPreset({ ...all, tells: ['prose'] }));
  assert.deepEqual(preset.settings.tells, ['prose']);
});

test('image-only tell requires a post image and no written caption', () => {
  const settings = { ...all, tells: ['imageOnly'] };
  assert.equal(SF.analyze('', settings, { hasPostImage: true }).flagged, true);
  assert.equal(SF.analyze('   ', settings, { hasPostImage: true }).flagged, true);
  assert.equal(SF.analyze('A real caption.', settings, { hasPostImage: true }).flagged, false);
  assert.equal(SF.analyze('', settings).flagged, false);
  assert.equal(SF.analyze('', { ...settings, threshold: 2 }, { hasPostImage: true }).flagged, true);
});
test('question ending catches final questions and informal think prompts, including an informal example', () => {
  const settings = { ...all, tells: ['questionEnding'] };
  for (const text of ['Here is the update.\nWhat do you guys think?', 'What you guys thingS', 'Thoughts?', 'How would you solve this? 👀', '¿Qué opinan?', 'What do you think?\n\n#growth #work']) {
    const result = SF.analyze(text, settings); assert.equal(result.flagged, true, text); assert.ok(result.matches[0].evidence);
  }
  for (const text of ['Is this useful? Here are the measurements.', 'What you guys think matters to me. Here is the result.', 'What you guys think matters to me.', 'What do you think of the changes is irrelevant.', "I don't care what you think.", 'Here is what you think.', 'One plain statement.', '']) assert.equal(SF.analyze(text, settings).flagged, false, text);
});
test('new format tells remain optional and round-trip through sharing', () => {
  const ids = ['imageOnly', 'questionEnding'];
  for (const id of ids) assert.equal(SF.normalize(SF.DEFAULTS).tells.includes(id), false);
  assert.deepEqual(SF.importPreset(SF.exportPreset({ ...all, tells: ids })).settings.tells, ids);
});

test('the reported hiring post is Job and does not count share-this as engagement bait', () => {
  const text = "We're #hiring a new Director of Operations in Portland, Oregon. Apply today or share this post with your network.";
  const result = SF.analyze(text, { ...all, tells: ['job', 'engagement'] });
  assert.equal(result.flagged, true); assert.deepEqual(result.matches.map(m => m.id), ['job']);
  assert.equal(SF.analyze(text, { ...all, tells: ['engagement'] }).flagged, false);
});
test('job card context and Spanish announcements classify, while ordinary job discussion does not', () => {
  const settings = { ...all, tells: ['job'] };
  assert.equal(SF.analyze('', settings, { hasJobCard: true }).flagged, true);
  assert.equal(SF.analyze('Estamos contratando un analista. Envía tu CV.', settings).flagged, true);
  for (const text of ['I resigned from my job yesterday.', 'Hiring practices need better feedback.', 'Share this article about job interviews.']) assert.equal(SF.analyze(text, settings).flagged, false, text);
});
test('ordinary engagement bait, keyword gates and deliberate custom phrases still work', () => {
  const settings = { ...all, tells: ['engagement'] };
  assert.equal(SF.analyze('Share this with your network.', settings).flagged, true);
  assert.equal(SF.analyze("We're hiring. Comment JOB and get the link.", settings).flagged, true);
  assert.equal(SF.analyze("We're hiring. Share this.", { ...settings, tells: [], phrases: ['share this'] }).flagged, true);
  assert.deepEqual(SF.importPreset(SF.exportPreset({ ...all, tells: ['job'] })).settings.tells, ['job']);
});

test('Doom bait includes the reported threat and X-is-dead slogans', () => {
  const settings = { ...all, tells: ['doom'] };
  for (const text of [
    "If your growth depends on Google traffic, you’re next.", "You're next.", 'You are next.', 'Adapt or die.', "You'll be left behind.", 'You will be left behind.', "Don't get left behind.",
    'SEO is dead.', 'X is dead', 'Cold email is dead!', 'Traditional marketing is dead — here is what replaces it.', 'Scrum is dead. Everything has changed.', 'Google is dead. Adapt or die.'
  ]) {
    const result = SF.analyze(text, settings); assert.equal(result.flagged, true, text); assert.equal(result.count, 1); assert.ok(result.matches[0].evidence);
  }
});
test('Doom bait avoids negations, questions, incidental dead words and literal failure subjects', () => {
  const settings = { ...all, tells: ['doom'] };
  for (const text of ['SEO is not dead.', "SEO isn't dead.", 'Is SEO dead?', 'SEO is dead wrong as a claim.', 'The deadline is Friday.', 'We found a dead link.', 'My phone is dead.', 'The server is dead.', 'My father is dead.', 'She is dead.', 'Our dog is dead.', 'The battery is dead.']) assert.equal(SF.analyze(text, settings).flagged, false, text);
});
test('Doom bait is selectable, counts once, respects threshold and shares in presets', () => {
  const s = { ...all, tells: ['doom'], threshold: 2 };
  assert.equal(SF.analyze("SEO is dead. Adapt or die. You're next.", s).flagged, true);
  assert.equal(SF.analyze("SEO is dead. Adapt or die. You're next.", s).count, 1);
  assert.equal(SF.normalize(SF.DEFAULTS).tells.includes('doom'), false);
  assert.deepEqual(SF.importPreset(SF.exportPreset(s)).settings.tells, ['doom']);
});

test('Leading spaces catches authored indentation and makes evidence visible', () => {
  const s = { ...all, tells: ['leadingSpaces'] };
  for (const text of ['eurneonfeunfeorne\n fonfoenfoenfeo', ' First line', 'First\n\n Second', 'First\r\n\tSecond', 'First\n\u00a0Second']) {
    const result = SF.analyze(text, s);
    assert.equal(result.flagged, true, text);
    assert.match(result.matches[0].evidence, /^[␠⇥]/);
  }
  for (const text of ['', 'First line\nSecond line', 'First line\n   \nSecond line', 'A normal sentence with spaces.']) assert.equal(SF.analyze(text, s).flagged, false, text);
  assert.equal(SF.analyze('First\n Second', {...s, threshold:2}).flagged, true);
  assert.equal(SF.DEFAULTS.tells.includes('leadingSpaces'), false);
  assert.deepEqual(SF.importPreset(SF.exportPreset(s)).settings.tells, ['leadingSpaces']);
});

test('favorite author identities use only exact LinkedIn profile/company paths', () => {
  assert.equal(SF.authorIdentity('https://www.linkedin.com/in/Example/?trk=feed'), '/in/example');
  assert.equal(SF.authorIdentity('/company/example/'), '/company/example');
  for (const bad of ['https://evil.com/in/example', 'https://www.linkedin.com.evil.com/in/example', 'javascript:alert(1)', 'http://www.linkedin.com/in/example', '/in/example/posts', '/feed/', '/in/']) assert.equal(SF.authorIdentity(bad), '', bad);
  assert.equal(SF.exportPreset({...all, lovedAuthors:['private']} ).includes('private'), false);
});

test('Stacked slogans matches repeated short No fragments as an optional style tell', () => {
  const s={...all,tells:['slogans']};
  for (const text of ['No equity. No fees. Fully virtual.', 'No excuses. No limits. Just results.', 'A longer introduction to this offer comes first. No equity. No fees. Fully virtual.']) assert.equal(SF.analyze(text,s).flagged,true,text);
  for (const text of ['No equity. Fully virtual.', 'We shipped today. It works well. Read our docs.', 'No equity is needed because this is a public grant. No fees are charged when submitting an application. Fully virtual.']) assert.equal(SF.analyze(text,s).flagged,false,text);
  assert.equal(SF.analyze('No equity. No fees. Fully virtual.',{...s,threshold:2}).flagged,true);
  assert.equal(SF.DEFAULTS.tells.includes('slogans'),false);
  assert.deepEqual(SF.importPreset(SF.exportPreset(s)).settings.tells,['slogans']);
});

test('one-match policy normalizes old saved settings and imported presets', () => {
  for (const threshold of [1,2,3,4,5,999]) assert.equal(SF.normalize({...all,threshold}).threshold,1);
  const old=JSON.stringify({format:'slop-filter-preset',version:1,settings:{tells:['hooks'],phrases:[],threshold:5}});
  assert.equal(SF.importPreset(old).settings.threshold,1);
  assert.equal(SF.analyze('Let that sink in.',SF.importPreset(old).settings).flagged,true);
});

test('feed sidebar preferences are opt-in booleans and stay out of tell presets', () => {
  assert.deepEqual(SF.normalizeLayout(),{hideLeft:false,hideRight:false});
  assert.deepEqual(SF.normalizeLayout({hideLeft:true,hideRight:'true'}),{hideLeft:true,hideRight:false});
  assert.equal(SF.exportPreset({...all,feedLayout:{hideLeft:true}}).includes('hideLeft'),false);
});
