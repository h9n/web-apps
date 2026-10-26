const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const filename = path.join(__dirname, '../colours.js');

test('five fixed modes cycle back to white and decode native GRB with inverse gamma', () => {
  assert.ok(fs.existsSync(filename), 'The colour player must exist');
  const colours = require(filename);
  assert.deepEqual(colours.MODES.map(mode => mode.id), ['white', 'red', 'blockiness', 'drift', 'wheel']);
  assert.equal(colours.nextMode('wheel'), 'white');
  assert.equal(colours.nextMode('white'), 'red');
  assert.equal(colours.nextMode('unknown'), 'red');
  assert.deepEqual(colours.decodeFrame(new Uint8Array([0, 255, 0]), 0, 1), [255, 0, 0]);
  assert.deepEqual(colours.decodeFrame(new Uint8Array([255, 0, 0]), 0, 1), [0, 255, 0]);
  assert.deepEqual(colours.decodeFrame(new Uint8Array([64, 64, 64]), 0, 2), [128, 128, 128]);
  assert.deepEqual(colours.decodeFrame(new Uint8Array([0, 255, 0, 255, 0, 0]), 2, 1), [255, 0, 0]);
  assert.throws(() => colours.decodeFrame(new Uint8Array([1, 2]), 0, 1), /frame/i);
  assert.equal(typeof colours.readableFrame, 'function', 'Black playback must not hide the interface');
  assert.deepEqual(colours.readableFrame([0, 0, 0]), [96, 96, 96]);
  assert.deepEqual(colours.readableFrame([24, 12, 0]), [96, 48, 0]);
  assert.deepEqual(colours.readableFrame([200, 20, 0]), [200, 20, 0]);
});
