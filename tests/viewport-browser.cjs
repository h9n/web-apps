const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const BASE = process.env.SCRATCH_TEST_URL || 'http://127.0.0.1:8788/scratch/';
(async () => {
  const browser = await playwright[process.env.BROWSER || 'chromium'].launch({headless:true});
  const errors = [];
  async function fixture({standalone=true,width=393,height=852,reported=793,scale=1,top=0,noVisual=false}={}) {
    const context = await browser.newContext({viewport:{width,height},isMobile:true,hasTouch:true,serviceWorkers:'block'});
    await context.addInitScript(({standalone,reported,scale,top,noVisual}) => {
      Object.defineProperty(navigator,'standalone',{value:standalone,configurable:true});
      window.viewportMetrics = {height:reported,innerHeight:reported,scale,top};
      Object.defineProperty(window,'innerHeight',{get:()=>window.viewportMetrics.innerHeight,configurable:true});
      if (noVisual) Object.defineProperty(window,'visualViewport',{value:null,configurable:true});
      else for (const [key,field] of [['height','height'],['scale','scale'],['offsetTop','top']]) {
        Object.defineProperty(window.visualViewport,key,{get:()=>window.viewportMetrics[field],configurable:true});
      }
    },{standalone,reported,scale,top,noVisual});
    const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
    await page.goto(BASE); await page.waitForFunction(()=>typeof db!=='undefined' && db);
    await page.evaluate(async()=>{
      document.documentElement.style.setProperty('--safe-top','59px');
      document.documentElement.style.setProperty('--safe-bottom','34px');
      const now=Date.now();
      await applyMergedSnapshot([{notes:Array.from({length:24},(_,i)=>ScratchSync.normalizeNote({id:`viewport-${i}`,text:`Synthetic note ${i}\nExtra text`,syntax:'plain',createdAt:now-i,updatedAt:now-i})),tombstones:[]}]);
      syncVisualViewport();
    });
    return {page,context};
  }
  const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1,`${message}: expected ${expected}, got ${actual}`);
  const bottom=(page,selector)=>page.locator(selector).evaluate(node=>node.getBoundingClientRect().bottom);
  async function metrics(page,changes) {
    await page.evaluate(changes=>{Object.assign(window.viewportMetrics,changes);window.visualViewport?.dispatchEvent(new Event('resize'));},changes);
  }
  let f=await fixture();
  near(await bottom(f.page,'#notes-list'),852,'standalone Notes list reaches full CSS viewport despite underreported JS height');
  await f.page.evaluate(()=>{const list=document.querySelector('#notes-list');list.scrollTop=list.scrollHeight;});
  assert.ok(await f.page.locator('.note-row').last().evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight+59),'last note remains reachable');
  await f.page.locator('.note-button').first().click();
  await f.page.waitForFunction(()=>document.activeElement===editor);
  near(await bottom(f.page,'#editor'),852,'standalone editor reaches bottom with hardware/no keyboard');
  await metrics(f.page,{height:500,top:0});
  near(await bottom(f.page,'#editor'),500,'software keyboard still constrains editor');
  await metrics(f.page,{height:460,top:40});
  near(await bottom(f.page,'#editor'),500,'keyboard viewport panning respected');
  await f.page.evaluate(()=>{viewportMetrics.height=793;viewportMetrics.top=0;document.dispatchEvent(new Event('visibilitychange'));});
  near(await bottom(f.page,'#editor'),852,'foreground return restores full standalone height even without resize');
  await f.page.click('#back-button');await f.page.waitForFunction(()=>editorView.hidden);
  await f.page.click('#search-button');
  await metrics(f.page,{height:500});
  near(await bottom(f.page,'#notes-list'),500,'search keyboard constrains list');
  await f.page.evaluate(()=>document.querySelector('#note-search').blur());
  await metrics(f.page,{height:793});
  near(await bottom(f.page,'#notes-list'),852,'search keyboard dismissal restores full list');
  await f.page.setViewportSize({width:852,height:393});
  await metrics(f.page,{height:334,innerHeight:334});
  near(await bottom(f.page,'#notes-list'),393,'rotation remeasures CSS layout viewport');
  await f.page.setViewportSize({width:393,height:852});
  await f.page.evaluate(()=>{Object.assign(viewportMetrics,{height:793,innerHeight:793});window.dispatchEvent(new Event('pageshow'));});
  near(await bottom(f.page,'#notes-list'),852,'pageshow and return rotation restore portrait height');
  await f.context.close();
  f=await fixture({standalone:false,reported:700});
  near(await bottom(f.page,'#notes-list'),700,'ordinary browser tab retains visible viewport sizing');
  await f.context.close();
  f=await fixture({scale:2,reported:426});
  near(await bottom(f.page,'#notes-list'),426,'pinch zoom keeps visual viewport instead of pretending keyboard');
  await f.context.close();
  f=await fixture({width:852,height:393,reported:334});
  near(await bottom(f.page,'#notes-list'),393,'landscape standalone fills CSS viewport');
  await f.page.locator('.note-button').first().click();await f.page.waitForFunction(()=>document.activeElement===editor);
  await metrics(f.page,{height:193});
  near(await bottom(f.page,'#editor'),193,'landscape keyboard constrains editor');
  assert.equal(await f.page.locator('body').evaluate(node=>node.classList.contains('landscape-keyboard')),true,'landscape keyboard hides editor toolbar');
  await metrics(f.page,{height:334});
  near(await bottom(f.page,'#editor'),393,'landscape dismissal restores full shell');
  assert.equal(await f.page.locator('body').evaluate(node=>node.classList.contains('landscape-keyboard')),false,'toolbar restored after dismissal');
  await f.context.close();
  f=await fixture({noVisual:true});
  near(await bottom(f.page,'#notes-list'),852,'standalone fallback uses CSS viewport without visualViewport');
  await f.context.close();
  assert.deepEqual(errors,[]);await browser.close();
  console.log('PASS: standalone underreported viewport, full list/editor bottom, keyboard/search/rotation/zoom/tab sizing and restoration');
})().catch(error=>{console.error(error);process.exit(1)});
