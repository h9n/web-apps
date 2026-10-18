'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sync = fs.existsSync(require('node:path').join(__dirname, '../sync.js')) ? require('../sync.js') : {};
const note = (text = 'hello', id = 'note-1') => ({ id, text, syntax: 'plain', createdAt: 10, updatedAt: 20 });
const snapshot = (notes = [], tombstones = []) => ({ notes, tombstones });
const conflictFixture = (count = 2) => {
  const base = Sync.normalizeNote(note());
  const heads = Array.from({ length: count }, (_, i) => Sync.editNote({ ...base, text: `version-${i}`, syntax: i % 2 ? 'org' : 'plain' }, `device-${i}`));
  return { base, heads, current: Sync.mergeSnapshots(snapshot([heads[0]]), heads.slice(1).map(n => snapshot([n]))) };
};
const resolutionOptions = (current, overrides = {}) => ({
  rootId: 'note-1', reviewedRevisions: current.notes.filter(n => n.id === 'note-1' || n.conflictOf === 'note-1').map(n => n.revision),
  mode: 'use', selectedRevision: current.notes.find(n => n.conflictOf).revision, deviceId: 'resolver', now: 100, ...overrides
});

test('use resolution keeps the original identity and acknowledges every reviewed head and ancestor', () => {
  const { base, heads, current } = conflictFixture(3);
  const selected = current.notes.find(n => n.conflictOf);
  const unrelated = note('untouched', 'other');
  const tombstone = { id: 'deleted-other', deletedAt: 0, deviceId: 'a', deviceName: 'A', extra: { retained: true } };
  const input = snapshot([...current.notes, unrelated], [tombstone]);
  const options = resolutionOptions(current);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const before = JSON.stringify([input, options]);
  freeze(input); freeze(options);
  const result = Sync.resolveConflict(input, options);
  const resolved = result.notes.find(n => n.id === base.id);
  assert.equal(resolved.text, selected.text);
  assert.equal(resolved.syntax, selected.syntax);
  assert.equal(resolved.createdAt, selected.createdAt);
  assert.equal(resolved.updatedAt, 100);
  assert.equal(resolved.deviceId, 'resolver');
  assert.equal(resolved.conflictOf, undefined);
  assert.match(resolved.revision, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(resolved.ancestors, [base.revision, ...heads.map(n => n.revision)].sort());
  assert.deepEqual(result.notes.find(n => n.id === 'other'), unrelated);
  assert.deepEqual(result.tombstones, [tombstone]);
  assert.deepEqual(result.report, { added: 0, updated: 1, deleted: 2, conflicts: 0 });
  assert.equal(JSON.stringify([input, options]), before);
  for (const stale of [current, ...heads.map(n => snapshot([n]))]) {
    assert.deepEqual(Sync.mergeSnapshots(result, [stale]).notes, Sync.mergeSnapshots(stale, [result]).notes);
    assert.equal(Sync.mergeSnapshots(stale, [result]).notes.filter(n => n.id === base.id || n.conflictOf === base.id).length, 1);
  }
});

test('combine resolution persists explicit draft text and syntax including empty content', () => {
  const { current } = conflictFixture();
  for (const text of ['combined draft\n* heading', '']) {
    const result = Sync.resolveConflict(current, resolutionOptions(current, { mode: 'combine', text, syntax: 'org' }));
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].text, text);
    assert.equal(result.notes[0].syntax, 'org');
    assert.deepEqual(Sync.mergeSnapshots(current, [result]).notes, result.notes);
  }
});

test('keep-both makes every nonselected version independent without replaying old conflicts', () => {
  const { base, heads, current } = conflictFixture(4);
  const options = resolutionOptions(current, { mode: 'keep-both' });
  const result = Sync.resolveConflict(current, options);
  assert.equal(result.notes.length, 4);
  assert.deepEqual(result.notes.map(n => [n.text, n.syntax]).sort(), heads.map(n => [n.text, n.syntax]).sort());
  const root = result.notes.find(n => n.id === base.id);
  assert.equal(root.text, heads.find(n => n.revision === options.selectedRevision).text);
  const independent = result.notes.filter(n => n.id !== base.id);
  for (const n of independent) {
    assert.match(n.id, /^[0-9a-f-]{36}$/);
    assert.match(n.revision, /^[0-9a-f-]{36}$/);
    assert.equal(n.conflictOf, undefined);
    assert.deepEqual(n.ancestors, []);
    assert.equal(n.deviceId, options.deviceId);
    assert.equal(n.createdAt, options.now);
    assert.equal(n.updatedAt, options.now);
    assert.ok(!heads.some(h => h.revision === n.revision));
  }
  assert.equal(new Set(result.notes.flatMap(n => [n.id, n.revision])).size, 8);
  assert.deepEqual(result.report, { added: 3, updated: 1, deleted: 3, conflicts: 0 });
  for (const stale of [current, snapshot(heads.slice(0, 1)), snapshot(heads.slice(1, 2))]) {
    assert.deepEqual(Sync.mergeSnapshots(result, [stale]).notes, result.notes);
    assert.deepEqual(Sync.mergeSnapshots(stale, [result]).notes, result.notes);
  }
});

test('resolution rejects stale, missing, unseen and non-live reviewed groups without changing drafts', () => {
  const { base, heads, current } = conflictFixture(3);
  const options = resolutionOptions(current, { mode: 'combine', text: 'precious draft', syntax: 'org' });
  const before = JSON.stringify([current, options]);
  for (const reviewedRevisions of [[], options.reviewedRevisions.slice(1), [...options.reviewedRevisions, 'unseen'], [base.revision, ...options.reviewedRevisions.slice(1)]]) {
    assert.throws(() => Sync.resolveConflict(current, { ...options, reviewedRevisions }), /reviewed.*(changed|match)|stale/i);
  }
  const next = Sync.editNote({ ...heads[0], text: 'newly arrived' }, 'late');
  const advanced = Sync.mergeSnapshots(current, [snapshot([next])]);
  assert.throws(() => Sync.resolveConflict(advanced, options), /reviewed.*(changed|match)|stale/i);
  assert.throws(() => Sync.resolveConflict(snapshot(), options), /live conflict/i);
  assert.throws(() => Sync.resolveConflict(snapshot([heads[0]]), options), /live conflict/i);
  const obsolete = { ...heads[0], revision: 'obsolete', ancestors: [] };
  const nonHeads = snapshot([...current.notes, { ...obsolete, id: 'conflict:obsolete', conflictOf: base.id }]);
  nonHeads.notes[0] = { ...nonHeads.notes[0], ancestors: [...nonHeads.notes[0].ancestors, obsolete.revision] };
  assert.throws(() => Sync.resolveConflict(nonHeads, resolutionOptions(nonHeads)), /live.*head|stale/i);
  assert.equal(JSON.stringify([current, options]), before);
});

test('resolution validates options and the whole snapshot with explainable errors', () => {
  const { current } = conflictFixture();
  const options = resolutionOptions(current);
  const cases = [
    [null, /options/], [[], /options/],
    [{ ...options, mode: 'discard' }, /mode/],
    [{ ...options, rootId: ' ' }, /identifier/],
    [{ ...options, rootId: 'conflict:fake' }, /root/],
    [{ ...options, selectedRevision: 'unknown' }, /selected revision/],
    [{ ...options, selectedRevision: null }, /identifier/],
    [{ ...options, reviewedRevisions: null }, /reviewed revisions/],
    [{ ...options, reviewedRevisions: 'abc' }, /reviewed revisions/],
    [{ ...options, reviewedRevisions: [...options.reviewedRevisions, 2] }, /identifier/],
    [{ ...options, deviceId: '' }, /identifier/],
    [{ ...options, deviceId: 2 }, /identifier/],
    ...[undefined, NaN, Infinity, -1, '100'].map(now => [{ ...options, now }, /timestamp/]),
    [{ ...options, mode: 'combine', syntax: 'org' }, /text/],
    [{ ...options, mode: 'combine', text: 2, syntax: 'org' }, /text/],
    [{ ...options, mode: 'combine', text: 'draft' }, /syntax/],
    [{ ...options, mode: 'combine', text: 'draft', syntax: 'html' }, /syntax/],
    [{ ...options, text: 2 }, /text/],
    [{ ...options, syntax: null }, /syntax/]
  ];
  for (const [invalid, message] of cases) assert.throws(() => Sync.resolveConflict(current, invalid), message);
  assert.throws(() => Sync.resolveConflict(snapshot([...current.notes, { ...note('bad', 'unrelated'), syntax: 'html' }]), options), /note content/);
  const result = Sync.resolveConflict(current, { ...options, reviewedRevisions: [...options.reviewedRevisions].reverse(), text: 'ignored for use', syntax: 'org' });
  assert.equal(result.notes[0].text, current.notes.find(n => n.revision === options.selectedRevision).text);
});

test('resolution rejects deleted heads and root while leaving permanent deletion recovery intact', () => {
  const { base, current } = conflictFixture(3);
  const options = resolutionOptions(current);
  const conflict = current.notes.find(n => n.conflictOf);
  const deleted = id => ({ id, deletedAt: 50, deviceId: 'deleting-device', deviceName: 'Deleting device' });
  for (const id of [base.id, conflict.id]) {
    const mixed = snapshot(current.notes, [deleted(id)]);
    assert.throws(() => Sync.resolveConflict(mixed, options), /deleted|deletion/i);
    const live = Sync.mergeSnapshots(mixed, []);
    assert.throws(() => Sync.resolveConflict(live, options), /live conflict|reviewed|deleted|deletion/i);
  }
  const resolved = Sync.resolveConflict(current, options);
  const rootDeletion = snapshot([], [deleted(base.id)]);
  const rootGone = Sync.mergeSnapshots(resolved, [rootDeletion, current]);
  assert.deepEqual(rootGone.notes, []);
  assert.ok(rootGone.tombstones[0].versions.some(n => n.revision === resolved.notes[0].revision));
  assert.deepEqual(Sync.mergeSnapshots(rootDeletion, [resolved, current]).tombstones, rootGone.tombstones);
  const conflictDeletion = snapshot([], [{ ...deleted(conflict.id), note: conflict }]);
  const branchGone = Sync.mergeSnapshots(resolved, [conflictDeletion, current]);
  assert.ok(!branchGone.notes.some(n => n.revision === resolved.notes[0].revision), 'acknowledged deleted branch still defeats a later resolution');
  const recovery = branchGone.tombstones.find(t => t.id === conflict.id);
  assert.equal(recovery.note.text, conflict.text);
  assert.ok(recovery.versions.some(n => n.revision === resolved.notes[0].revision));
  assert.deepEqual(Sync.mergeSnapshots(branchGone, [resolved, current, conflictDeletion]).notes, branchGone.notes);
});

test('unseen later branches remain conflicts after every resolution mode', () => {
  for (const mode of ['use', 'combine', 'keep-both']) {
    const { heads, current } = conflictFixture();
    const result = Sync.resolveConflict(current, resolutionOptions(current, { mode, text: 'combined', syntax: 'plain' }));
    const unseen = Sync.editNote({ ...heads[0], text: 'unseen later edit' }, 'late');
    const merged = Sync.mergeSnapshots(result, [snapshot([unseen]), current]);
    assert.equal(merged.notes.filter(n => n.id === 'note-1' || n.conflictOf === 'note-1').length, 2);
    assert.ok(merged.notes.some(n => n.text === 'unseen later edit'));
    assert.equal(merged.report.conflicts, 1);
    assert.deepEqual(Sync.mergeSnapshots(snapshot([unseen]), [current, result]).notes, merged.notes);
  }
});

test('independent concurrent resolutions preserve both decisions and transitive histories', () => {
  const { heads, current } = conflictFixture(3);
  const advanced = Sync.editNote({ ...heads[0], text: 'advanced' }, 'advance');
  const live = Sync.mergeSnapshots(current, [snapshot([advanced])]);
  const left = Sync.resolveConflict(live, resolutionOptions(live, { selectedRevision: advanced.revision }));
  const right = Sync.resolveConflict(live, resolutionOptions(live, { mode: 'combine', text: 'other decision', syntax: 'org', deviceId: 'other-resolver' }));
  const expectedAncestors = [...new Set([...heads.map(n => n.revision), ...live.notes.flatMap(n => [n.revision, ...n.ancestors])])].sort();
  assert.deepEqual(left.notes[0].ancestors, expectedAncestors);
  assert.deepEqual(right.notes[0].ancestors, expectedAncestors);
  const merged = Sync.mergeSnapshots(left, [right, live, current]);
  assert.deepEqual(merged.notes.map(n => n.text).sort(), ['advanced', 'other decision']);
  assert.equal(merged.report.conflicts, 1);
  assert.deepEqual(Sync.mergeSnapshots(right, [left, current, live]).notes, merged.notes);
  assert.deepEqual(Sync.mergeSnapshots(merged, [left, right, current]).notes, merged.notes);
});

test('browser UMD resolves conflicts using browser UUID allocation', () => {
  const context = { crypto: require('node:crypto').webcrypto };
  const { current } = conflictFixture();
  context.input = JSON.stringify(current);
  context.options = JSON.stringify(resolutionOptions(current, { mode: 'keep-both' }));
  vm.runInNewContext(fs.readFileSync(require.resolve('../sync.js'), 'utf8') + `
    result = JSON.stringify(ScratchSync.resolveConflict(JSON.parse(input), JSON.parse(options)));
  `, context);
  const result = JSON.parse(context.result);
  assert.equal(result.notes.length, 2);
  assert.ok(result.notes.every(n => !n.conflictOf));
  assert.deepEqual(Sync.mergeSnapshots(current, [result]).notes, result.notes);
});

test('legacy revisions are bounded SHA-256 digests matching Node crypto in browser and Node', () => {
  const { createHash } = require('node:crypto');
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../sync.js'), 'utf8') + `
    normalizeJSON = input => ScratchSync.normalizeNote(JSON.parse(input)).revision;
  `, browser);
  // Include UTF-8 widths, combining marks, lone surrogates, and block/padding boundaries.
  const texts = ['', 'héllo 🌍 漢字 e\u0301 \u0000 \ud800 \udfff', ...Array.from({ length: 130 }, (_, i) => 'a'.repeat(i)), '🌍'.repeat(25000), 'x'.repeat(100000)];
  for (const text of texts) {
    const source = note(text);
    const serialized = JSON.stringify([source.id, text, source.syntax, source.createdAt, source.updatedAt]);
    const expected = 'legacy:' + createHash('sha256').update(serialized, 'utf8').digest('hex');
    const normalized = Sync.normalizeNote(source);
    assert.ok(normalized.revision.length <= 80, 'legacy revision must not embed note text');
    assert.equal(normalized.revision, expected);
    assert.equal(browser.normalizeJSON(JSON.stringify(source)), expected);
    assert.equal(normalized.text, text);
    assert.deepEqual(source, note(text));
  }
});

test('large-note conflict IDs are bounded SHA-256 digests and converge across devices', () => {
  const { createHash } = require('node:crypto');
  const id = 'note-🌍';
  const a = note('a'.repeat(100000), id);
  const b = note('b'.repeat(100000), id);
  const merged = Sync.mergeSnapshots(snapshot([a]), [snapshot([b])]);
  const conflict = merged.notes.find(n => n.conflictOf);
  assert.ok(conflict.id.length <= 100, 'conflict ID must not re-encode its revision');
  const expected = 'conflict:' + createHash('sha256').update(JSON.stringify([id, conflict.revision]), 'utf8').digest('hex');
  assert.equal(conflict.id, expected);
  assert.deepEqual(merged.notes.map(n => n.text).sort(), [a.text, b.text]);
  assert.deepEqual(Sync.mergeSnapshots(snapshot([b]), [snapshot([a])]).notes, merged.notes);
  assert.deepEqual(Sync.mergeSnapshots(merged, [snapshot([a]), snapshot([b])]).notes, merged.notes);
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../sync.js'), 'utf8') + `
    mergeJSON = (a, b) => JSON.stringify(ScratchSync.mergeSnapshots(JSON.parse(a), [JSON.parse(b)]).notes);
  `, browser);
  assert.deepEqual(JSON.parse(browser.mergeJSON(JSON.stringify(snapshot([a])), JSON.stringify(snapshot([b])))), merged.notes);
  // The same digest must be used for deletion lookup, not only conflict creation.
  const deletion = snapshot([], [{ id: conflict.id, deletedAt: 1, deviceId: 'a', deviceName: 'A', note: conflict }]);
  const deleted = Sync.mergeSnapshots(snapshot([a]), [snapshot([b]), deletion]);
  assert.equal(deleted.notes.length, 1);
  assert.notEqual(deleted.notes[0].revision, conflict.revision);
  assert.equal(deleted.tombstones[0].versions[0].text, conflict.text);
});

test('edits allocate UUID revisions and retain transitive ancestry without mutating content', () => {
  const original = Sync.normalizeNote(note());
  const first = Sync.editNote(original, 'device-a');
  const second = Sync.editNote({ ...first, text: 'changed' }, 'device-b');
  assert.match(first.revision, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(second.ancestors, [original.revision, first.revision].sort());
  assert.equal(second.deviceId, 'device-b');
  assert.equal(second.text, 'changed');
  assert.deepEqual(original, Sync.normalizeNote(note()));
});

test('merges causal updates without trusting clocks and reports local changes', () => {
  assert.equal(typeof Sync.mergeSnapshots, 'function');
  const original = Sync.normalizeNote(note());
  const newer = Sync.editNote({ ...original, text: 'new', updatedAt: 1 }, 'a');
  const local = snapshot([original]);
  const remote = snapshot([newer, note('extra', 'note-2')]);
  const before = JSON.stringify([local, remote]);
  const merged = Sync.mergeSnapshots(local, [remote]);
  assert.equal(merged.notes.length, 2);
  assert.equal(merged.notes.find(n => n.id === original.id).text, 'new');
  assert.deepEqual(merged.report, { added: 1, updated: 1, deleted: 0, conflicts: 0 });
  assert.equal(JSON.stringify([local, remote]), before);
  assert.deepEqual(Sync.mergeSnapshots(merged, [local]).notes, merged.notes);
});

test('concurrent versions retain content with deterministic conflict IDs and propagate idempotently', () => {
  const base = Sync.normalizeNote(note());
  const a = Sync.editNote({ ...base, text: 'A', updatedAt: 9999 }, 'a');
  const b = Sync.editNote({ ...base, text: 'B', updatedAt: 1 }, 'b');
  const c = Sync.editNote({ ...base, text: 'C' }, 'c');
  const merged = Sync.mergeSnapshots(snapshot([a]), [snapshot([b]), snapshot([c])]);
  assert.equal(new Set(merged.notes.map(n => n.id)).size, 3);
  assert.deepEqual(merged.notes.map(n => n.text).sort(), ['A', 'B', 'C']);
  assert.equal(merged.notes.filter(n => n.conflictOf === base.id).length, 2);
  assert.equal(merged.report.conflicts, 2);
  assert.deepEqual(Sync.mergeSnapshots(snapshot([c]), [snapshot([b]), snapshot([a])]).notes, merged.notes);
  assert.deepEqual(Sync.mergeSnapshots(merged, [snapshot([a]), snapshot([b]), merged]).notes, merged.notes);
  const next = Sync.editNote({ ...a, text: 'A2' }, 'a');
  const propagated = Sync.mergeSnapshots(merged, [snapshot([next])]);
  assert.deepEqual(propagated.notes.map(n => n.text).sort(), ['A2', 'B', 'C']);
  assert.deepEqual(Sync.mergeSnapshots(snapshot(), [propagated, merged]).notes, propagated.notes);
});

test('permanent deletion defeats stale originals and retained conflict edits while preserving recovery', () => {
  const original = Sync.normalizeNote(note());
  const a = Sync.editNote({ ...original, text: 'A' }, 'a');
  const b = Sync.editNote({ ...original, text: 'B' }, 'b');
  const conflicts = Sync.mergeSnapshots(snapshot([a]), [snapshot([b])]);
  const retained = conflicts.notes.find(n => n.conflictOf);
  const retainedEdit = Sync.editNote({ ...retained, text: 'edited conflict' }, 'c');
  const tombstone = { id: original.id, deletedAt: 0, deviceId: 'a', deviceName: 'Laptop', note: original };
  const remote = snapshot([], [tombstone]);
  const before = JSON.stringify([conflicts, remote]);
  const merged = Sync.mergeSnapshots(conflicts, [remote, snapshot([retainedEdit])]);
  assert.deepEqual(merged.notes, []);
  assert.equal(merged.report.deleted, 2);
  assert.equal(merged.tombstones.length, 1);
  assert.deepEqual(merged.tombstones[0].versions.map(n => n.text).sort(), ['A', 'B', 'edited conflict', 'hello']);
  assert.equal(merged.tombstones[0].deviceName, 'Laptop');
  assert.equal(JSON.stringify([conflicts, remote]), before);
  const replay = Sync.mergeSnapshots(merged, [snapshot([original]), conflicts, remote]);
  assert.deepEqual(replay.notes, []);
  assert.deepEqual(replay.tombstones, merged.tombstones);
  const restored = Sync.editNote({ ...merged.tombstones[0].note, id: 'new-restored-id' }, 'a');
  assert.equal(Sync.mergeSnapshots(merged, [snapshot([restored])]).notes[0].id, 'new-restored-id');
  assert.deepEqual(Sync.mergeSnapshots(remote, [conflicts, snapshot([retainedEdit])]).tombstones, merged.tombstones);
});

test('rejects malformed whole snapshots, unsafe identifiers and prototype pollution', () => {
  const good = note();
  const badNotes = [null, {}, { ...good, text: 4 }, { ...good, syntax: 'html' },
    { ...good, createdAt: '10' }, { ...good, updatedAt: Infinity },
    { ...good, id: '__proto__' }, { ...good, id: 'constructor' }, { ...good, id: 'prototype' },
    { ...good, id: '' }, { ...good, id: 'bad\u0000id' },
    { ...good, revision: 1 }, { ...good, ancestors: ['x'] },
    { ...good, revision: 'r', ancestors: ['r'] },
    { ...good, revision: 'r', ancestors: 'x' },
    { ...good, conflictOf: good.id },
    JSON.parse('{"id":"n","text":"x","syntax":"plain","createdAt":1,"updatedAt":2,"__proto__":{"polluted":true}}'),
    { ...good, metadata: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') }];
  for (const bad of badNotes) {
    assert.throws(() => Sync.mergeSnapshots(snapshot(), [snapshot([good, { ...bad, id: bad && bad.id === good.id ? 'other' : bad?.id }])]), TypeError);
    assert.throws(() => Sync.normalizeNote(bad), TypeError);
  }
  const malformed = [null, {}, { notes: [], tombstones: null }, snapshot([good, good]),
    snapshot([], [{ id: 'n', deletedAt: 1, deviceId: 'a' }]),
    snapshot([], [{ id: 'n', deletedAt: -1, deviceId: 'a', deviceName: 'A' }]),
    snapshot([], [{ id: 'n', deletedAt: 1, deviceId: 'a', deviceName: 'A', note: good }]),
    snapshot([], [{ id: '__proto__', deletedAt: 1, deviceId: 'a', deviceName: 'A' }])];
  for (const remote of malformed) assert.throws(() => Sync.mergeSnapshots(snapshot(), [snapshot([good]), remote]), TypeError);
  assert.throws(() => Sync.mergeSnapshots(snapshot(), {}), TypeError);
  assert.throws(() => Sync.editNote(good, ''), TypeError);
  assert.equal({}.polluted, undefined);
});

test('deleting a retained conflict blocks stale copies and later branch edits without deleting its sibling', () => {
  const original = Sync.normalizeNote(note());
  const a = Sync.editNote({ ...original, text: 'A' }, 'a');
  const b = Sync.editNote({ ...original, text: 'B' }, 'b');
  const merged = Sync.mergeSnapshots(snapshot([a]), [snapshot([b])]);
  const retained = merged.notes.find(n => n.conflictOf);
  const deletion = snapshot([], [{ id: retained.id, deletedAt: 1, deviceId: 'a', deviceName: 'A', note: retained }]);
  const edited = Sync.editNote({ ...retained, text: 'late edit' }, 'b');
  const result = Sync.mergeSnapshots(merged, [deletion, snapshot([edited])]);
  assert.equal(result.notes.length, 1);
  assert.notEqual(result.notes[0].revision, retained.revision);
  assert.equal(result.tombstones[0].versions.length, 2);
  assert.deepEqual(Sync.mergeSnapshots(result, [merged, deletion]).notes, result.notes);
  assert.deepEqual(Sync.mergeSnapshots(result, []).tombstones, result.tombstones);
});

test('preserves deletion-time recovery note and unions all recoverable versions deterministically', () => {
  const original = Sync.normalizeNote(note());
  const changed = Sync.editNote({ ...original, text: 'changed' }, 'b');
  const deletion = snapshot([], [{ id: original.id, deletedAt: 200, deviceId: 'a', deviceName: 'A', note: original }]);
  const second = snapshot([], [{ id: original.id, deletedAt: 1, deviceId: 'b', deviceName: 'B', versions: [changed] }]);
  const result = Sync.mergeSnapshots(deletion, [second]);
  assert.deepEqual(result.tombstones[0].note, original);
  assert.equal(result.tombstones[0].versions.length, 2);
  assert.deepEqual(Sync.mergeSnapshots(second, [deletion]).tombstones, result.tombstones);
  assert.deepEqual(Sync.mergeSnapshots(result, [deletion, second]).tombstones, result.tombstones);
});

test('metadata preservation and report equality are deterministic across property and snapshot order', () => {
  const a = { ...Sync.normalizeNote(note()), extra: { label: 'A', nested: [1, 2] } };
  const b = { extra: { nested: [1, 2], label: 'B' }, ...Sync.normalizeNote(note()) };
  const first = Sync.mergeSnapshots(snapshot([a]), [snapshot([b])]);
  const reversed = Sync.mergeSnapshots(snapshot([b]), [snapshot([a])]);
  assert.deepEqual(first.notes, reversed.notes);
  assert.equal(first.notes[0].extra.label, 'A');
  const reordered = Object.fromEntries(Object.entries(first.notes[0]).reverse());
  assert.equal(Sync.mergeSnapshots(snapshot([reordered]), [first]).report.updated, 0);
  first.notes[0].extra.nested.push(3);
  assert.deepEqual(a.extra.nested, [1, 2]);
});

test('rejects revision equivocation and cyclic causal ancestry instead of dropping data', () => {
  const original = Sync.normalizeNote(note());
  const a = { ...original, revision: 'a', ancestors: ['b'] };
  const b = { ...original, revision: 'b', ancestors: ['a'] };
  assert.throws(() => Sync.mergeSnapshots(snapshot([a]), [snapshot([b])]), TypeError);
  assert.throws(() => Sync.mergeSnapshots(snapshot([original]), [snapshot([{ ...original, text: 'forged' }])]), TypeError);
  assert.throws(() => Sync.mergeSnapshots(snapshot([a]), [snapshot([{ ...a, ancestors: [] }])]), TypeError);
});

test('merge is associative over independent branches and leaves deeply frozen inputs untouched', () => {
  const original = Sync.normalizeNote(note());
  const a = Sync.editNote({ ...original, text: 'A' }, 'a');
  const b = Sync.editNote({ ...original, text: 'B' }, 'b');
  const c = Sync.editNote({ ...a, text: 'C' }, 'a');
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const sa = freeze(snapshot([a]));
  const sb = freeze(snapshot([b]));
  const sc = freeze(snapshot([c]));
  const direct = Sync.mergeSnapshots(sa, [sb, sc]);
  const staged = Sync.mergeSnapshots(Sync.mergeSnapshots(sa, [sb]), [sc]);
  assert.deepEqual(staged.notes, direct.notes);
  assert.deepEqual(Sync.mergeSnapshots(direct, [sa, sb, sc]).report, { added: 0, updated: 0, deleted: 0, conflicts: 1 });
});

test('browser UMD runs normalization, editing and merging without CommonJS', () => {
  const context = { crypto: require('node:crypto').webcrypto };
  vm.runInNewContext(fs.readFileSync(require.resolve('../sync.js'), 'utf8') + `
    const source = ScratchSync.normalizeNote({ id: 'browser', text: 'hello', syntax: 'plain', createdAt: 1, updatedAt: 2 });
    const edited = ScratchSync.editNote({ ...source, text: 'changed' }, 'browser-device');
    result = JSON.stringify(ScratchSync.mergeSnapshots({ notes: [source], tombstones: [] }, [{ notes: [edited], tombstones: [] }]));
  `, context);
  assert.equal(JSON.parse(context.result).notes[0].text, 'changed');
});

test('normalizes legacy notes deterministically without mutation and exposes browser UMD', () => {
  assert.equal(typeof Sync.normalizeNote, 'function');
  const source = note('héllo 🌍');
  const normalized = Sync.normalizeNote(source);
  assert.deepEqual(normalized, Sync.normalizeNote({ ...source }));
  assert.equal(typeof normalized.revision, 'string');
  assert.deepEqual(normalized.ancestors, []);
  assert.notEqual(normalized.revision, Sync.normalizeNote(note('different')).revision);
  assert.notEqual(normalized, source);
  assert.deepEqual(source, note('héllo 🌍'));
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../sync.js'), 'utf8'), browser);
  assert.equal(typeof browser.ScratchSync.normalizeNote, 'function');
});
