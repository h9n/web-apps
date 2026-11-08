const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('function parseTagMetadata(');
const end = source.indexOf('// END TAG METADATA');
test('metadata parser exists and preserves exact canonical bytes on unchanged edit', () => {
 assert.ok(start >= 0 && end > start, 'metadata parser missing');
 const context = vm.createContext({}); vm.runInContext(source.slice(start,end),context);
 for (const text of ['', 'body #inline\n', '#東京 #café', 'body\n\n#one #two\n\n', 'body\r\n\r\n#one\r\n', 'body\n#one', 'body\n\n#one prose', ' \n\n#one  #two \n']) {
  const parsed = context.parseTagMetadata(text);
  assert.equal(context.serializeTagMetadata(parsed, parsed.body, parsed.tags), text);
 }
 assert.equal(context.parseTagMetadata('body\n\n#one #東京\n').body, 'body');
 assert.equal(context.parseTagMetadata('body\n#one').body, 'body');
 assert.equal(context.serializeTagMetadata(context.parseTagMetadata('#one'), 'New body', ['#one']), 'New body\n\n#one');
 assert.equal(context.parseTagMetadata('#one').body, '');
 assert.equal(context.parseTagMetadata('body\n\n#one prose').tags.length, 0);
 assert.equal(context.serializeTagMetadata(context.parseTagMetadata('body\n\n#one\n\n'), 'body', ['#two']), 'body\n\n#two\n\n');
 assert.equal(context.serializeTagMetadata(context.parseTagMetadata('body\n\n#one'), 'body', []), 'body');
 assert.equal(context.serializeTagMetadata(context.parseTagMetadata('line1\r\nline2\r\n\r\n#one\r\n'), 'line1\r\nline2', ['#two']), 'line1\r\nline2\r\n\r\n#two\r\n');
 for (const text of ['#', '#one prose', 'Text #one', '* Heading\nprose #one', 'body\n\n#one #', 'body\n\n#one\nprose']) assert.equal(context.parseTagMetadata(text).tags.length, 0, text);
 assert.equal(context.parseTagMetadata('* Org heading\n\n#東京 #café #a_b').tags.length, 3);
 assert.equal(context.serializeTagMetadata(context.parseTagMetadata('body\n\n'), 'body\n\n', ['#東京']), 'body\n\n#東京');
});
