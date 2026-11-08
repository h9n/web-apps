const test = require('node:test');
const assert = require('node:assert/strict');
const colours = require('../colours.js');
test('ctrl_deck exact fluorescent palette replaces personal 0dv modes', () => {
  assert.deepEqual(colours.MODES.map(m => m.id), ['white', 'red', 'lime', 'cyan', 'pink', 'violet', 'orange', 'wheel']);
  assert.deepEqual(colours.MODES.slice(2, 7).map(m => m.rgb), [[199,255,62],[53,232,255],[255,77,166],[167,139,250],[255,146,87]]);
  assert.ok(colours.MODES.every(m => !m.url));
  assert.equal(colours.nextMode('wheel'), 'white');
});
