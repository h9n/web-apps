const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = playwright[process.env.BROWSER || 'chromium'];
const assert = require('node:assert/strict');
const BASE=process.env.SCRATCH_TEST_URL||'http://127.0.0.1:8788/scratch/';
(async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
 page.on('dialog',d=>d.accept()); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE);await page.waitForFunction(()=>typeof db!=='undefined'&&db);
 await page.click('#new-note-button');await page.fill('#editor','Keep my local text');await page.click('#back-button');
 await page.evaluate(async()=>{
  const note=notes[0]; const old={format:'scratch-backup',version:2,notes:[{id:note.id,text:'Other older-backup text',syntax:'plain',createdAt:note.createdAt,updatedAt:note.updatedAt+1}]};
  await importBackup(new File([JSON.stringify(old)],'old.json',{type:'application/json'}));
 });
 assert.deepEqual(await page.evaluate(()=>notes.map(n=>n.text).sort()),['Keep my local text','Other older-backup text'],'import must preserve both ambiguous versions');
 await page.evaluate(async()=>{
  const note=notes[0];await removeNote(note.id,false);
  await importBackup(new File([JSON.stringify({format:'scratch-backup',version:2,notes:[note]})],'stale.json'));
 });
 assert.equal(await page.evaluate(()=>notes.some(n=>tombstones.some(t=>t.id===n.id))),false,'stale import cannot revive tombstoned IDs');
 const before=await page.evaluate(()=>JSON.stringify({notes,tombstones}));
 await page.evaluate(()=>importBackup(new File([JSON.stringify({format:'scratch-backup',version:3,notes:[{id:'bad'}],tombstones:[]})],'bad.json')));
 assert.equal(await page.evaluate(()=>JSON.stringify({notes,tombstones})),before,'malformed import is atomic');
 await page.click('#new-note-button');await page.fill('#editor','Revision batch');
 await page.evaluate(()=>{for(let i=0;i<100;i++){editor.value+='x';queueSave();}});
 const ancestry=await page.evaluate(()=>activeNote.ancestors.length);
 assert.ok(ancestry<=2,`typing should allocate revisions per saved batch, not per keystroke: ${ancestry}`);
 await page.click('#back-button');
 await page.waitForFunction(()=>editorView.hidden && !dirty);
 await page.reload();await page.waitForFunction(()=>typeof db!=='undefined'&&db&&notes.some(n=>n.text.startsWith('Revision batch')));
 assert.ok(await page.evaluate(()=>notes.some(n=>n.text.startsWith('Revision batch'))),'reload retains note');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: older-backup import, ambiguous edits preserved, stale resurrection blocked, malformed import atomic, bounded typing revisions, reload persistence');
})().catch(e=>{console.error(e);process.exit(1)});
