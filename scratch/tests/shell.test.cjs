const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('v23 shell couples every asset and precaches only the new native neon stream', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  assert.ok(sw.includes('scratch-shell-v23'));
  for (const file of ['styles.css','sync.js','app.js','colours.js']) {
    assert.ok(html.includes(`${file}?v=23`));
    assert.ok(sw.includes(`${file}?v=23`));
  }
  assert.ok(sw.includes('ctrl-deck-neon.30fps.10g.0dv'));
  assert.ok(!sw.includes('nocturnal-drift') && !sw.includes('blockiness'));
});
