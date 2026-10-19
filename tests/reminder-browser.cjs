const { [process.env.BROWSER || 'chromium']: engine } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const BASE = process.env.SCRATCH_TEST_URL || 'http://127.0.0.1:8788/scratch/';
const DAY = 86400000, NOW = 1800000000000, KEY = 'scratch-sync-reminder-v1';
(async () => {
  const browser = await engine.launch({headless:true});
  const errors = [];
  async function fixture(record = {firstSeen:NOW-DAY,lastSync:NOW-DAY,snoozedUntil:0}, health = 'ok') {
    const context = await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
    await context.addInitScript(({record,NOW,KEY,health}) => {
      window.now = NOW; Date.now = () => window.now;
      // Exercise the production abort deadline without a twelve-second test.
      const timeout = window.setTimeout;
      window.setTimeout = (fn,ms,...args) => timeout(fn,ms===12000 && health==='timeout'?80:ms,...args);
      if (!localStorage.getItem('scratch-stash-v1')) {
        localStorage.setItem('scratch-stash-v1',JSON.stringify({enabled:true,baseUrl:'https://stash.test',device:'Fixture',lastSuccess:NOW,lastError:'existing backup error'}));
        if (record) localStorage.setItem(KEY,JSON.stringify({'https://stash.test':record}));
      }
    }, {record,NOW,KEY,health});
    const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    const state = {checks:0,posts:0,health,body:null,hold:null,failPost:0,failVerify:0,failDevices:false};
    await page.route('https://stash.test/**',async route => {
      const request=route.request(), path=new URL(request.url()).pathname;
      if(path==='/v1/health') {
        state.checks++;
        if(state.health==='timeout') { await new Promise(resolve=>setTimeout(resolve,250)); return route.fulfill({json:{service:'stash',status:'ok'}}).catch(()=>{}); }
        if(state.hold) await state.hold;
        if(state.health==='fail') return route.abort();
        return route.fulfill({json:state.health==='ok'?{service:'stash',status:'ok'}:{service:'other',status:'ok'}});
      }
      if(request.method()==='POST') {
        state.posts++; if(state.posts===state.failPost) return route.fulfill({status:500,json:{error:'failed'}});
        state.body=request.postData(); return route.fulfill({status:201,json:{stored:true}});
      }
      if(path.endsWith('/devices'))return route.fulfill({status:state.failDevices?500:200,json:{devices:[]}});
      if(state.posts===state.failVerify)return route.fulfill({json:{wrong:'read-back'}});
      return route.fulfill({body:state.body || '{}',contentType:'application/json'});
    });
    await page.goto(BASE); await page.waitForFunction(()=>typeof db!=='undefined' && db);
    return {page,context,state};
  }
  const visible = page => page.locator('#sync-reminder').isVisible();
  const settle = page => page.waitForTimeout(100);
  const record = page => page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY))['https://stash.test'],KEY);
  const resume = page => page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  let f = await fixture();
  await f.page.waitForSelector('#sync-reminder',{state:'visible',timeout:1500});
  assert.equal(f.state.checks,1,'due startup checks health');
  assert.equal(await f.page.locator('#sync-reminder-now').textContent(),'Sync now');
  assert.equal(await f.page.locator('#sync-reminder-later').textContent(),'Not now');
  assert.equal(f.state.posts,0,'reminder does not sync automatically');
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'phone banner does not overflow');
  if(process.env.REMINDER_SCREENSHOT) await f.page.screenshot({path:process.env.REMINDER_SCREENSHOT});
  await f.context.close();
  f = await fixture(null); await settle(f.page);
  assert.equal(await visible(f.page),false,'unknown history gets grace, not a backup-derived sync date');
  assert.equal((await record(f.page)).firstSeen,NOW,'first use persists grace');
  await f.page.evaluate(DAY=>{window.now+=DAY;},DAY); await resume(f.page);
  await f.page.waitForSelector('#sync-reminder',{state:'visible',timeout:1500});
  await f.page.click('#sync-reminder-later');
  assert.equal(await visible(f.page),false,'Not now hides immediately');
  assert.equal((await record(f.page)).snoozedUntil,NOW+2*DAY);
  await f.page.reload(); await f.page.waitForFunction(()=>typeof db!=='undefined' && db); await settle(f.page);
  assert.equal(await visible(f.page),false,'snooze survives reload');
  await f.page.evaluate(DAY=>{window.now+=2*DAY;},DAY); await resume(f.page);
  await f.page.waitForSelector('#sync-reminder',{state:'visible',timeout:1500});
  await f.context.close();
  f = await fixture({firstSeen:NOW-2*DAY,lastSync:NOW-1,snoozedUntil:0}); await settle(f.page);
  assert.equal(f.state.checks,0,'recent sync does not check health'); await f.context.close();
  for (const health of ['fail','wrong','timeout']) {
    f=await fixture(undefined,health); await settle(f.page);
    assert.equal(await visible(f.page),false,`${health} health is silent`);
    assert.equal(await f.page.evaluate(()=>stashConfig.lastError),'existing backup error'); await f.context.close();
  }
  f=await fixture(); await f.page.waitForSelector('#sync-reminder',{state:'visible'});
  await f.page.click('#data-button'); await settle(f.page);
  assert.equal(await visible(f.page),false,'any modal hides reminder');
  await f.page.locator('#data-dialog button[value="close"]').click(); await settle(f.page);
  assert.equal(await visible(f.page),true,'returning to Notes reuses fresh health');
  assert.equal(f.state.checks,1,'five-minute throttle reuses valid response');
  await f.page.click('#new-note-button'); await settle(f.page);
  assert.equal(await visible(f.page),false,'editor suppresses banner');
  await f.page.click('#back-button'); await settle(f.page); assert.equal(await visible(f.page),true);
  await f.page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await settle(f.page); assert.equal(await visible(f.page),false,'hidden document suppresses banner');
  await f.page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await settle(f.page); assert.equal(await visible(f.page),true);
  await f.page.evaluate(()=>{stashBackupRunning=true;renderStashStatus();}); await settle(f.page);
  assert.equal(await visible(f.page),false,'backup running suppresses banner');
  await f.page.evaluate(()=>{stashBackupRunning=false;renderStashStatus();}); await settle(f.page);
  await f.page.evaluate(()=>{window.dispatchEvent(new Event('offline'));}); await settle(f.page);
  assert.equal(await visible(f.page),false,'offline invalidates health');
  await f.context.close();
  // Hold an actual routed health request while repeated lifecycle events arrive.
  f=await fixture({firstSeen:NOW,lastSync:NOW,snoozedUntil:0});
  let release; f.state.hold=new Promise(resolve=>{release=resolve;});
  await f.page.evaluate(DAY=>{window.now+=DAY;document.dispatchEvent(new Event('visibilitychange'));},DAY);
  await f.page.waitForTimeout(60);
  for(let i=0;i<4;i++) await resume(f.page);
  assert.equal(f.state.checks,1,'only one health request runs');
  await f.page.click('#data-button'); release(); await settle(f.page);
  assert.equal(await visible(f.page),false,'late health cannot show inside modal');
  await f.page.locator('#data-dialog button[value="close"]').click(); await settle(f.page);
  assert.equal(await visible(f.page),false,'stale response is not cached as fresh');
  assert.equal(f.state.checks,1,'failed/stale checks also throttled');
  await f.page.evaluate(()=>{window.now+=300001;document.dispatchEvent(new Event('visibilitychange'));}); await settle(f.page);
  assert.equal(await visible(f.page),true,'new lifecycle after throttle retries');
  const count=f.state.checks; await f.page.evaluate(()=>{window.now+=10*86400000;}); await f.page.waitForTimeout(350);
  assert.equal(f.state.checks,count,'no periodic polling');
  await f.context.close();
  for (const change of ['snooze','sync','endpoint','editor','conflict']) {
    f=await fixture({firstSeen:NOW,lastSync:NOW,snoozedUntil:0});
    let release; f.state.hold=new Promise(resolve=>{release=resolve;});
    await f.page.evaluate(DAY=>{window.now+=DAY;document.dispatchEvent(new Event('visibilitychange'));},DAY);
    await f.page.waitForTimeout(40);
    if(change==='snooze') await f.page.evaluate(()=>snoozeSyncReminder());
    if(change==='sync') await f.page.evaluate(()=>syncWithStash());
    if(change==='endpoint') await f.page.evaluate(()=>{stashConfig.baseUrl='https://stash.test/changed';saveStashConfig();renderStashStatus();});
    if(change==='editor') await f.page.click('#new-note-button');
    if(change==='conflict') await f.page.evaluate(()=>document.querySelector('#conflict-dialog').showModal());
    release(); await settle(f.page);
    assert.equal(await visible(f.page),false,`stale health after ${change} is discarded`);
    await f.context.close();
  }
  f=await fixture(); await f.page.waitForSelector('#sync-reminder',{state:'visible'});
  const before=await record(f.page);
  await f.page.evaluate(()=>backupToStash(true));
  assert.deepEqual(await record(f.page),before,'backup-only success never resets sync clock');
  f.state.failPost=f.state.posts+2;
  await f.page.click('#sync-reminder-now'); await f.page.waitForFunction(()=>!stashSyncRunning && document.querySelector('#sync-status').textContent.includes('Merged backup pending'));
  assert.deepEqual(await record(f.page),before,'failed postmerge upload does not reset sync clock');
  f.state.failPost=0;
  f.state.failDevices=true; await f.page.evaluate(()=>syncWithStash());
  assert.deepEqual(await record(f.page),before,'failed discovery after prebackup never resets clock');
  f.state.failDevices=false; f.state.failVerify=f.state.posts+2;
  await f.page.evaluate(()=>syncWithStash());
  assert.deepEqual(await record(f.page),before,'unverified merged upload never resets clock');
  f.state.failVerify=0;
  await f.page.evaluate(()=>snoozeSyncReminder());
  await f.page.evaluate(()=>syncWithStash());
  assert.equal((await record(f.page)).lastSync,NOW,'only completed verified sync resets clock');
  assert.equal((await record(f.page)).snoozedUntil,0,'sync clears snooze');
  assert.equal(await visible(f.page),false,'successful sync hides banner');
  assert.equal(await f.page.evaluate(()=>JSON.stringify(makeBackupPayload()).includes('scratch-sync-reminder')),false,'reminder metadata is not portable');
  await f.page.evaluate(()=>{stashConfig.baseUrl='https://stash.test/other/';saveStashConfig();renderStashStatus();}); await settle(f.page);
  assert.equal(await visible(f.page),false,'new normalized endpoint gets independent grace');
  assert.equal(await f.page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY))['https://stash.test/other'].firstSeen,KEY),NOW);
  await f.context.close();
  assert.deepEqual(errors,[]); await browser.close();
  console.log('PASS: daily sync reminder runtime checks');
})().catch(e=>{console.error(e);process.exit(1)});
