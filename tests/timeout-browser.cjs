const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await playwright[process.env.BROWSER || 'chromium'].launch({headless:true});
 try {
  const page = await browser.newPage();
  await page.goto(process.env.SCRATCH_TEST_URL || 'http://127.0.0.1:8788/scratch/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  const result = await page.evaluate(async () => {
   const realFetch = window.fetch;
   let aborted = false;
   window.fetch = async (url, {signal}) => new Response(new ReadableStream({
    start(controller) {
     controller.enqueue(new TextEncoder().encode('{"unfinished":'));
     signal.addEventListener('abort', () => {aborted = true; controller.error(new DOMException('Aborted','AbortError'));}, {once:true});
    }
   }), {status:200});
   let outcome;
   try {
    outcome = await Promise.race([
     fetchWithTimeout('https://stash.test/stalled', {}, 'json', 30).then(() => 'resolved', e => e.message),
     new Promise(resolve => setTimeout(() => resolve('hung beyond deadline'),300))
    ]);
   } finally {window.fetch = realFetch;}
   return {outcome,aborted};
  });
  assert.match(result.outcome,/did not respond within/, 'timeout must include body consumption');
  assert.equal(result.aborted,true,'deadline aborts the response body');
  const retry = await page.evaluate(async () => {
   const realFetch = window.fetch; const originalHelper = fetchWithTimeout;
   fetchWithTimeout = (url, options, type) => originalHelper(url, options, type, 30);
   stashConfig.enabled = true; stashConfig.baseUrl = 'https://stash.test';
   let stall = true; let body; let aborts = 0;
   window.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
     body = options.body;
     if (stall) return new Response(new ReadableStream({start(controller) {
      options.signal.addEventListener('abort', () => {aborts++; controller.error(new DOMException('Aborted','AbortError'));}, {once:true});
     }}), {status:201});
     return Response.json({stored:true});
    }
    if (url.endsWith('/devices')) return Response.json({app:'scratch',devices:[]});
    return new Response(body);
   };
   try {
    await syncWithStash();
    const failed = {running:stashSyncRunning || stashBackupRunning, status:document.querySelector('#sync-status').textContent, aborts};
    stall = false; await syncWithStash();
    return {failed, running:stashSyncRunning || stashBackupRunning, status:document.querySelector('#sync-status').textContent};
   } finally {window.fetch = realFetch; fetchWithTimeout = originalHelper; stashConfig.enabled = false;}
  });
  assert.equal(retry.failed.running,false,'timeout releases sync and backup flags');
  assert.equal(retry.failed.aborts,1,'stalled upload body aborted');
  assert.match(retry.failed.status,/Sync stopped:.*did not respond within/);
  assert.equal(retry.running,false);
  assert.match(retry.status,/^Sync complete/,'sync can retry after body timeout');
  console.log('PASS: stalled-body deadline, body abort, running flags released, successful sync retry');
 } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode = 1;});
