/* Scratch snapshot sync. Pure except edit/resolve UUID allocation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScratchSync = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  // Synchronous SHA-256 over UTF-8 JSON, per FIPS 180-4 sections 4–6.
  // https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
  // Stream bytes through one block: no text-sized byte/word expansion, no browser APIs.
  const sha256Constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function digest(value) {
    const text = JSON.stringify(value);
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const block = new Uint8Array(64);
    const words = new Uint32Array(64);
    const rotate = (x, n) => (x >>> n) | (x << (32 - n));
    let used = 0;
    let byteLength = 0;
    function byte(value) {
      block[used++] = value;
      byteLength++;
      if (used !== 64) return;
      for (let i = 0; i < 16; i++) {
        const j = i * 4;
        words[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
      }
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
        const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
        words[i] = words[i - 16] + s0 + words[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let i = 0; i < 64; i++) {
        const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choose = (e & f) ^ (~e & g);
        const t1 = (h + sum1 + choose + sha256Constants[i] + words[i]) | 0;
        const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + sum0 + majority) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((word, i) => { hash[i] = (hash[i] + word) >>> 0; });
      used = 0;
    }
    // JSON.stringify escapes lone surrogates; paired ones iterate as full code points.
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point < 0x80) byte(point);
      else if (point < 0x800) { byte(0xc0 | (point >>> 6)); byte(0x80 | (point & 63)); }
      else if (point < 0x10000) {
        byte(0xe0 | (point >>> 12)); byte(0x80 | ((point >>> 6) & 63)); byte(0x80 | (point & 63));
      } else {
        byte(0xf0 | (point >>> 18)); byte(0x80 | ((point >>> 12) & 63));
        byte(0x80 | ((point >>> 6) & 63)); byte(0x80 | (point & 63));
      }
    }
    const high = Math.floor(byteLength / 0x20000000);
    const low = (byteLength * 8) >>> 0;
    byte(0x80);
    while (used !== 56) byte(0);
    for (const word of [high, low]) {
      byte(word >>> 24); byte(word >>> 16); byte(word >>> 8); byte(word);
    }
    return hash.map(word => word.toString(16).padStart(8, '0')).join('');
  }
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const fail = message => { throw new TypeError('Invalid Scratch sync data: ' + message); };
  const identifier = value => {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value) || forbidden.has(value)) fail('identifier');
  };
  const timestamp = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('timestamp');
  };
  function validateJSON(value, seen = new Set(), depth = 0) {
    if (depth > 64) fail('metadata too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) fail('not JSON data');
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail('non-plain object');
    if (Object.getOwnPropertySymbols(value).length) fail('symbol metadata');
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (forbidden.has(key)) fail('unsafe metadata key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!own(descriptor, 'value')) fail('accessor metadata');
      validateJSON(descriptor.value, seen, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) fail('sparse array');
    seen.delete(value);
  }
  function validateNote(note) {
    validateJSON(note);
    if (!note || Array.isArray(note) || typeof note !== 'object') fail('note object');
    identifier(note.id);
    if (typeof note.text !== 'string' || !['plain', 'org'].includes(note.syntax)) fail('note content');
    timestamp(note.createdAt);
    timestamp(note.updatedAt);
    if (own(note, 'revision')) {
      identifier(note.revision);
      if (!Array.isArray(note.ancestors)) fail('revision ancestry');
      for (const ancestor of note.ancestors) {
        identifier(ancestor);
        if (ancestor === note.revision) fail('self ancestry');
      }
    } else if (own(note, 'ancestors')) fail('ancestry without revision');
    if (own(note, 'deviceId')) identifier(note.deviceId);
    if (own(note, 'conflictOf')) {
      identifier(note.conflictOf);
      if (note.id === note.conflictOf || !note.id.startsWith('conflict:') || !own(note, 'revision')) fail('conflict lineage');
    } else if (note.id.startsWith('conflict:')) fail('reserved conflict id');
  }
  function validateSnapshot(source) {
    validateJSON(source);
    if (!source || !Array.isArray(source.notes) || !Array.isArray(source.tombstones)) fail('snapshot arrays');
    const ids = new Set();
    for (const note of source.notes) {
      validateNote(note);
      if (ids.has(note.id)) fail('duplicate note id');
      ids.add(note.id);
    }
    const deleted = new Set();
    for (const tombstone of source.tombstones) {
      if (!tombstone || typeof tombstone !== 'object' || Array.isArray(tombstone)) fail('tombstone');
      identifier(tombstone.id);
      timestamp(tombstone.deletedAt);
      identifier(tombstone.deviceId);
      if (typeof tombstone.deviceName !== 'string') fail('device name');
      if (deleted.has(tombstone.id)) fail('duplicate tombstone id');
      deleted.add(tombstone.id);
      if (own(tombstone, 'versions') && !Array.isArray(tombstone.versions)) fail('recovery versions');
      for (const note of [...(tombstone.versions || []), ...(own(tombstone, 'note') ? [tombstone.note] : [])]) {
        validateNote(note);
        if (note.id !== tombstone.id && note.conflictOf !== tombstone.id) fail('unrelated recovery note');
      }
    }
  }
  function normalizeNote(note) {
    validateNote(note);
    const result = clone(note);
    if (!result.revision) result.revision = 'legacy:' + digest([note.id, note.text, note.syntax, note.createdAt, note.updatedAt]);
    result.ancestors = [...new Set(result.ancestors || [])].sort();
    return result;
  }
  function editNote(note, deviceId) {
    identifier(deviceId);
    const result = normalizeNote(note);
    result.ancestors = [...new Set([...result.ancestors, result.revision])].sort();
    const crypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : require('node:crypto');
    result.revision = crypto.randomUUID();
    result.deviceId = deviceId;
    return result;
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const canonical = value => JSON.stringify(value, function (key, item) {
    if (item && !Array.isArray(item) && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]]));
    }
    return item;
  });
  const conflictId = (id, revision) => 'conflict:' + digest([id, revision]);
  function recover(entry, raw) {
    const note = normalizeNote(raw);
    const root = note.conflictOf || note.id;
    note.id = entry.record.id;
    if (note.id === root) delete note.conflictOf;
    else note.conflictOf = root;
    entry.recovery.set(canonical(note), note);
    return note;
  }
  function validateHistory(sources) {
    const histories = new Map();
    for (const source of sources) {
      const notes = [...source.notes];
      for (const tombstone of source.tombstones) notes.push(...(tombstone.versions || []), ...(tombstone.note ? [tombstone.note] : []));
      for (const raw of notes) {
        const note = normalizeNote(raw);
        const id = note.conflictOf || note.id;
        if (!histories.has(id)) histories.set(id, new Map());
        const versions = histories.get(id);
        const prior = versions.get(note.revision);
        const identity = n => canonical([n.text, n.syntax, n.createdAt, n.updatedAt, n.ancestors]);
        if (prior && identity(prior) !== identity(note)) fail('revision reused for different content or ancestry');
        versions.set(note.revision, note);
      }
    }
    for (const versions of histories.values()) {
      const pending = new Map();
      const children = new Map();
      for (const note of versions.values()) {
        const known = note.ancestors.filter(revision => versions.has(revision));
        pending.set(note.revision, known.length);
        for (const ancestor of known) {
          if (!children.has(ancestor)) children.set(ancestor, []);
          children.get(ancestor).push(note.revision);
        }
      }
      const ready = [...pending.keys()].filter(revision => pending.get(revision) === 0);
      for (let index = 0; index < ready.length; index++) {
        for (const child of children.get(ready[index]) || []) {
          pending.set(child, pending.get(child) - 1);
          if (!pending.get(child)) ready.push(child);
        }
      }
      if (ready.length !== versions.size) fail('cyclic revision ancestry');
    }
  }
  function mergeSnapshots(local, remotes) {
    if (!Array.isArray(remotes)) fail('remote snapshots array');
    [local, ...remotes].forEach(validateSnapshot);
    validateHistory([local, ...remotes]);
    const groups = new Map();
    const deleted = new Map();
    const sources = [local, ...remotes];
    for (const source of sources) {
      for (const raw of source.tombstones) {
        const tombstone = clone(raw);
        const recovered = [...(tombstone.versions || []), ...(tombstone.note ? [tombstone.note] : [])];
        delete tombstone.note;
        delete tombstone.versions;
        if (!deleted.has(tombstone.id)) deleted.set(tombstone.id, { record: tombstone, recovery: new Map() });
        const entry = deleted.get(tombstone.id);
        if (canonical(tombstone) < canonical(entry.record)) entry.record = tombstone;
        for (const note of recovered) recover(entry, note);
        if (raw.note) {
          const primary = recover(entry, raw.note);
          if (!entry.primary || canonical(primary) < canonical(entry.primary)) entry.primary = primary;
        }
      }
    }
    for (const source of sources) {
      for (const raw of source.notes) {
        const note = normalizeNote(raw);
        const id = note.conflictOf || note.id;
        const targets = new Set([id, note.id, ...[note.revision, ...note.ancestors].map(revision => conflictId(id, revision))].filter(key => deleted.has(key)));
        if (targets.size) {
          for (const key of targets) recover(deleted.get(key), note);
          continue;
        }
        note.id = id;
        delete note.conflictOf;
        if (!groups.has(id)) groups.set(id, new Map());
        const versions = groups.get(id);
        const prior = versions.get(note.revision);
        if (!prior || canonical(note) < canonical(prior)) versions.set(note.revision, note);
      }
    }
    const notes = [];
    for (const versions of groups.values()) {
      const candidates = [...versions.values()];
      const heads = candidates.filter(a => !candidates.some(b => b.ancestors.includes(a.revision)))
        .sort((a, b) => a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0);
      heads.forEach((note, index) => {
        if (index) {
          note.conflictOf = note.id;
          note.id = conflictId(note.id, note.revision);
        }
        notes.push(note);
      });
    }
    notes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const prior = new Map(local.notes.map(n => [n.id, normalizeNote(n)]));
    const tombstones = [...deleted.values()].map(entry => {
      const result = entry.record;
      const versions = [...entry.recovery.values()].sort((a, b) => compare(canonical(a), canonical(b)));
      if (versions.length) {
        result.note = clone(entry.primary || versions[0]);
        result.versions = versions;
      }
      return result;
    }).sort((a, b) => compare(a.id, b.id));
    return { notes, tombstones, report: {
      added: notes.filter(n => !prior.has(n.id)).length,
      updated: notes.filter(n => prior.has(n.id) && canonical(n) !== canonical(prior.get(n.id))).length,
      deleted: [...prior.keys()].filter(id => !notes.some(n => n.id === id)).length,
      conflicts: notes.filter(n => n.conflictOf).length
    } };
  }
  // Throws before allocating revisions if the caller's review is stale/deleted.
  // Removed conflict IDs are deliberately NOT tombstoned: the new root's
  // ancestry suppresses reviewed heads, leaving unseen branches concurrent.
  function resolveConflict(snapshot, options) {
    validateSnapshot(snapshot);
    validateHistory([snapshot]);
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('resolution options object');
    // Options need not be JSON (an omitted optional value is allowed), but must
    // never invoke accessors while validating a resolution request.
    for (const key of Object.keys(options)) {
      if (forbidden.has(key) || !own(Object.getOwnPropertyDescriptor(options, key), 'value')) fail('unsafe resolution options');
    }
    const { rootId, selectedRevision, deviceId, now } = options;
    identifier(rootId);
    if (rootId.startsWith('conflict:')) fail('resolution requires the original root id');
    identifier(selectedRevision);
    identifier(deviceId);
    timestamp(now);
    if (!['use', 'combine', 'keep-both'].includes(options.mode)) fail('resolution mode');
    if (!Array.isArray(options.reviewedRevisions)) fail('reviewed revisions array');
    for (const revision of options.reviewedRevisions) identifier(revision);
    if ((options.mode === 'combine' || own(options, 'text')) && typeof options.text !== 'string') fail('resolution text must be a string');
    if ((options.mode === 'combine' || own(options, 'syntax')) && !['plain', 'org'].includes(options.syntax)) fail('resolution syntax must be plain or org');
    const group = snapshot.notes.filter(note => note.id === rootId || note.conflictOf === rootId).map(normalizeNote);
    const deleted = new Set(snapshot.tombstones.map(tombstone => tombstone.id));
    if (deleted.has(rootId) || group.some(note => deleted.has(note.id) || [note.revision, ...note.ancestors].some(revision => deleted.has(conflictId(rootId, revision))))) fail('conflict group contains a permanently deleted version; refresh before resolving');
    if (group.length < 2) fail('no live conflict group remains; refresh before resolving');
    if (group.some(note => group.some(other => other.ancestors.includes(note.revision))) || new Set(group.map(note => note.revision)).size !== group.length) fail('stale conflict group: expected only live revision heads');
    const reviewed = new Set(options.reviewedRevisions);
    if (reviewed.size !== group.length || group.some(note => !reviewed.has(note.revision))) fail('reviewed revisions no longer match the live conflict group; refresh and review all versions');
    const selected = group.find(note => note.revision === selectedRevision);
    if (!selected) fail('selected revision is not a reviewed live version');
    const resolved = editNote(selected, deviceId);
    resolved.id = rootId;
    delete resolved.conflictOf;
    resolved.updatedAt = now;
    if (options.mode === 'combine') {
      resolved.text = options.text;
      resolved.syntax = options.syntax;
    }
    resolved.ancestors = [...new Set(group.flatMap(note => [note.revision, ...note.ancestors]))].sort();
    const notes = snapshot.notes.filter(note => note.id !== rootId && note.conflictOf !== rootId).map(clone);
    notes.push(resolved);
    if (options.mode === 'keep-both') {
      const crypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : require('node:crypto');
      for (const note of group.filter(note => note.revision !== selectedRevision)) {
        const independent = clone(note);
        independent.id = crypto.randomUUID();
        delete independent.conflictOf;
        delete independent.revision;
        delete independent.ancestors;
        independent.createdAt = now;
        independent.updatedAt = now;
        independent.deviceId = deviceId;
        independent.revision = crypto.randomUUID();
        independent.ancestors = [];
        notes.push(independent);
      }
    }
    notes.sort((a, b) => compare(a.id, b.id));
    return { notes, tombstones: clone(snapshot.tombstones), report: {
      added: (options.mode === 'keep-both' ? group.length - 1 : 0) + (snapshot.notes.some(note => note.id === rootId) ? 0 : 1),
      updated: snapshot.notes.some(note => note.id === rootId) ? 1 : 0,
      deleted: group.filter(note => note.id !== rootId).length,
      conflicts: notes.filter(note => note.conflictOf).length
    } };
  }
  return { normalizeNote, editNote, mergeSnapshots, resolveConflict };
}));
