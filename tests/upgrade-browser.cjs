const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = playwright[process.env.BROWSER || 'chromium'];
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=process.env.SCRATCH_TEST_URL;
 await page.goto(url);await page.waitForFunction(()=>typeof db!=='undefined'&&db);
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await page.click('#new-note-button');await page.fill('#editor','Survive the app upgrade\n#ideas');await page.click('#back-button');await page.waitForFunction(()=>editorView.hidden&&!dirty);
 await page.reload();await page.waitForFunction(()=>notes.length===1);
 assert.equal(await page.evaluate(()=>db.version),2,'fixture starts on the released DB');
 await page.request.post(new URL('/__upgrade',url).href);
 await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
 await page.waitForFunction(async()=> (await caches.keys()).includes('scratch-shell-v19'));
 await page.reload();await page.waitForFunction(()=>typeof ScratchSync?.resolveConflict==='function'&&db?.version===2&&notes.length===1);
 assert.equal(await page.locator('.note-title').textContent(),'Survive the app upgrade','existing text survives migration');
 assert.equal(await page.locator('#stash-sync-button').count(),1);
 assert.equal(await page.locator('#show-conflicts-button').count(),1);
 assert.equal(await page.locator('#sync-reminder').count(),1);
 assert.equal(await page.locator('script[src="app.js?v=18"]').count(),1);
 assert.deepEqual(await page.evaluate(()=>[...db.objectStoreNames]),['deletions','notes']);
 // Cut origin responses so both engines exercise the worker's network-failure fallback.
 await page.request.post(new URL('/__offline',url).href);await page.reload();await page.waitForFunction(()=>typeof ScratchSync!=='undefined'&&notes.length===1);
 await page.click('.note-button');await page.fill('#editor','Edited while offline after upgrade');await page.click('#back-button');await page.waitForFunction(()=>editorView.hidden&&!dirty);
 await page.reload();await page.waitForFunction(()=>notes.some(n=>n.text==='Edited while offline after upgrade'));
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: previous HEAD shell → reminder shell v19, IndexedDB v2 unchanged, notes preserved, offline reload/edit/persistence');
})().catch(e=>{console.error(e);process.exit(1)});
