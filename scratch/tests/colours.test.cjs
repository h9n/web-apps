const test = require('node:test');
const assert = require('node:assert/strict');
const colours = require('../colours.js');
test('ctrl_deck exact fluorescent palette replaces personal 0dv modes', () => {
  assert.deepEqual(colours.MODES.map(m => m.id), ['white', 'red', 'lime', 'cyan', 'pink', 'violet', 'orange', 'neon', 'wheel']);
  assert.deepEqual(colours.MODES.slice(2, 7).map(m => m.rgb), [[199,255,62],[53,232,255],[255,77,166],[167,139,250],[255,146,87]]);
  assert.deepEqual(colours.MODES.filter(m => m.url).map(m => m.id), ['neon']);
  assert.equal(colours.MODES.find(m => m.id === 'neon').url, 'colours/ctrl-deck-neon.30fps.10g.0dv');
  assert.equal(colours.nextMode('wheel'), 'white');
});
