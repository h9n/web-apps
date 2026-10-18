'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sync = fs.existsSync(require('node:path').join(__dirname, '../sync.js')) ? require('../sync.js') : {};
const note = (text = 'hello', id = 'note-1') => ({ id, text, syntax: 'plain', createdAt: 10, updatedAt: 20 });
const snapshot = (notes = [], tombstones = []) => ({ notes, tombstones });

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
