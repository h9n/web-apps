const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('v22 shell couples every changed asset and no longer precaches personal streams', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  assert.ok(sw.includes('scratch-shell-v22'));
  for (const file of ['styles.css','sync.js','app.js','colours.js']) {
    assert.ok(html.includes(`${file}?v=22`));
    assert.ok(sw.includes(`${file}?v=22`));
  }
  assert.ok(!sw.includes('.0dv'));
});
