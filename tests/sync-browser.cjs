const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = playwright[process.env.BROWSER || 'chromium'];
const assert = require('node:assert/strict');
const BASE = process.env.SCRATCH_TEST_URL || 'http://127.0.0.1:8788/scratch/';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const snapshots=new Map(); const errors=[];
 async function device(name){
  // Routing cannot intercept service-worker-owned requests; real HTTPS tests keep workers enabled.
  const context=await browser.newContext({viewport:{width:390,height:844},ignoreHTTPSErrors:true,serviceWorkers:process.env.STASH_TEST_SERVER ? 'allow' : 'block'});
  const page=await context.newPage();page.on('pageerror', e=>errors.push(e.message));
  if (!process.env.STASH_TEST_SERVER) await page.route('https://stash.test/**', async route=>{
   const req=route.request();const path=new URL(req.url()).pathname;
   const fulfill=options=>route.fulfill({...options,headers:{'Access-Control-Allow-Origin':new URL(BASE).origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
   if(req.method()==='OPTIONS')return fulfill({status:204});
   if(path==='/v1/health')return fulfill({json:{service:'stash',status:'ok',version:1}});
   if(path==='/v1/scratch/devices')return fulfill({json:{app:'scratch',devices:[...snapshots.keys()].map(device=>({device,types:['backup']}))}});
   const m=path.match(/^\/v1\/scratch\/([^/]+)\/backup(\/latest)?$/);
   if(!m)return fulfill({status:404,json:{error:'not found'}});
   if(req.method()==='POST'){snapshots.set(m[1],JSON.parse(req.postData()));return fulfill({status:201,json:{stored:true}});}
   if(!snapshots.has(m[1]))return fulfill({status:404,json:{error:'no objects'}});
   return fulfill({json:snapshots.get(m[1])});
  });
  await page.goto(BASE);await page.waitForFunction(()=>typeof db!=='undefined' && db);
  await page.click('#data-button');await page.fill('#stash-url',process.env.STASH_TEST_SERVER || 'https://stash.test');await page.fill('#stash-device',name);await page.click('#stash-save-button');
  await page.waitForFunction(()=>stashConfig.lastSuccess>0 && !stashBackupRunning);
  await page.locator('#data-dialog button[value="close"]').click();
  return page;
 }
 async function fillEditor(page,text){
  // openNote schedules focus/caret placement on the next animation frame.
  await page.waitForFunction(()=>!editorView.hidden && document.activeElement===editor);
  await page.fill('#editor',text);
  assert.equal(await page.inputValue('#editor'),text,'editor contains the exact replacement text');
 }
 async function add(page,text){await page.click('#new-note-button');await fillEditor(page,text);await page.click('#back-button');await page.waitForFunction(()=>!dirty);assert.deepEqual(await page.evaluate(()=>notes.map(n=>n.text)),[text],'seed saved exactly before sync');}
 async function sync(page){await page.click('#data-button');await page.click('#stash-sync-button');await page.waitForFunction(()=>!stashSyncRunning && document.querySelector('#sync-status').textContent.startsWith('Sync complete'));await page.locator('#data-dialog button[value="close"]').click();}
 const a=await device('Alpha');const b=await device('Beta');
 await add(a,'Shared seed\n#ideas');await sync(a);await sync(b);
 assert.equal(await b.locator('.note-row').count(),1,'unknown note downloaded');
 const id=await a.evaluate(()=>notes[0].id);
 await a.locator('.note-button').click();await fillEditor(a,'Alpha offline edit\n#ideas');await a.click('#back-button');
 await b.locator('.note-button').click();await fillEditor(b,'Beta offline edit\n#ideas');await b.click('#back-button');
 await a.waitForFunction(()=>!dirty && editorView.hidden);await b.waitForFunction(()=>!dirty && editorView.hidden);
 assert.deepEqual(await a.evaluate(()=>notes.map(n=>n.text)),['Alpha offline edit\n#ideas'],'Alpha saved exact edit before sync');
 assert.deepEqual(await b.evaluate(()=>notes.map(n=>n.text)),['Beta offline edit\n#ideas'],'Beta saved exact edit before sync');
 await sync(a);await sync(b);await sync(a);
 const texts=await a.evaluate(()=>notes.map(n=>n.text).sort());
 assert.deepEqual(texts,['Alpha offline edit\n#ideas','Beta offline edit\n#ideas'],'both concurrent edits preserved');
 assert.ok((await a.locator('.note-title').allTextContents()).some(t=>t.includes('Conflict')),'conflict visibly labelled');
 await sync(a);assert.equal(await a.locator('.note-row').count(),2,'repeated sync no duplicate');
 const staleSnapshot=await a.evaluate(()=>structuredClone({notes,tombstones}));
 await a.locator('.note-title').filter({hasText:'Conflict ·'}).click();
 await a.locator('.conflict-version').filter({hasText:'Beta offline edit'}).getByRole('button',{name:'Use this version',exact:true}).click();
 await a.waitForFunction(()=>!document.querySelector('#conflict-dialog').open && notes.length===1);
 await sync(a);await sync(b);await sync(a);
 assert.deepEqual(await b.evaluate(()=>notes.map(n=>n.text)),['Beta offline edit\n#ideas'],'selected resolution reaches second device');
 await b.evaluate(snapshot=>applyMergedSnapshot([snapshot]),staleSnapshot);
 assert.equal(await b.evaluate(()=>notes.length),1,'old peer snapshot does not reopen conflict');
 assert.equal(await b.evaluate(()=>notes.some(n=>n.conflictOf)),false,'resolution removes conflict marker on peers');
 await a.evaluate(id=>removeNote(id,false),id);await sync(a);await sync(b);
 assert.equal(await b.evaluate(id=>notes.some(n=>n.id===id),id),false,'deletion reaches peer');
 assert.ok(await b.evaluate(()=>tombstones.length>0),'remote deletion retained');
 await b.click('#data-button');assert.ok(await b.locator('#deleted-notes button').count()>0,'recoverable content accessible');
 await b.locator('#deleted-notes button').first().click();
 await b.waitForFunction(()=>notes.some(n=>n.text.includes('offline edit')));
 assert.ok(await b.evaluate(id=>notes.every(n=>n.id!==id),id),'recovery uses fresh ID');
 assert.deepEqual(errors,[]);
 await browser.close();console.log('PASS: two-device sync, concurrent edits, explicit resolution and stale-peer suppression, repeat sync, deletion propagation and recovery');
})().catch(e=>{console.error(e);process.exit(1)});
