const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await playwright[process.env.BROWSER || 'chromium'].launch({headless:true});
 try {
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(process.env.SCRATCH_TEST_URL || 'http://127.0.0.1:8788/scratch/');
  await page.waitForFunction(() => typeof db !== 'undefined' && db);
  const result = await page.evaluate(async () => {
   const seed = ScratchSync.normalizeNote({id:'merge-seed', text:'seed', syntax:'plain', createdAt:1, updatedAt:1});
   await applyMergedSnapshot([{notes:[seed], tombstones:[]}]);
   const branches = ['first import', 'second import'].map((text, i) => ({notes:[{...ScratchSync.editNote(seed, `device-${i}`), text}], tombstones:[]}));
   await Promise.all(branches.map(snapshot => applyMergedSnapshot([snapshot])));
   return notes.map(n => n.text).sort();
  });
  assert.deepEqual(result, ['first import','second import'], 'concurrent merge calls preserve both branches');
  const imported = await page.evaluate(async () => {
   const seed = ScratchSync.normalizeNote({id:'import-seed', text:'import seed', syntax:'plain', createdAt:2, updatedAt:2});
   await applyMergedSnapshot([{notes:[seed], tombstones:[]}]);
   const files = ['first file', 'second file'].map((text,i) => new File([JSON.stringify({format:'scratch-backup',version:3,notes:[{...ScratchSync.editNote(seed, `file-${i}`),text}],tombstones:[]})],`${i}.json`));
   await Promise.all(files.map(file => importBackup(file)));
   return notes.filter(n => n.id === seed.id || n.conflictOf === seed.id).map(n => n.text).sort();
  });
  assert.deepEqual(imported,['first file','second file'],'concurrent imports preserve both branches');
  const ownership = await page.evaluate(async () => {
   const events = []; let release;
   const gate = new Promise(resolve => { release = resolve; });
   const snapshot = JSON.stringify({format:'scratch-backup',version:3,notes:[],tombstones:[]});
   const first = importBackup({text: async () => {events.push('first read'); await gate; return snapshot;}});
   const second = importBackup({text: async () => {events.push('second read'); return snapshot;}});
   stashConfig.enabled = true; stashConfig.baseUrl = 'https://stash.test';
   const originalBackup = backupToStash;
   backupToStash = async () => {events.push('sync backup'); return false;};
   const syncing = syncWithStash();
   await new Promise(resolve => setTimeout(resolve,50));
   const before = [...events]; release();
   await Promise.all([first,second,syncing]);
   backupToStash = originalBackup; stashConfig.enabled = false;
   return {before,events};
  });
  assert.deepEqual(ownership.before,['first read'],'import owns shared queue before awaiting file text');
  assert.deepEqual(ownership.events,['first read','second read','sync backup'],'imports and sync do not overlap');
  await page.reload();
  await page.waitForFunction(() => typeof db !== 'undefined' && db && notes.length === 4);
  assert.deepEqual(await page.evaluate(() => notes.map(n => n.text).sort()),['first file','first import','second file','second import'],'all concurrent branches persisted in IndexedDB');
  for (const order of ['delete-first', 'merge-first']) {
   const state = await page.evaluate(async order => {
    const seed = ScratchSync.normalizeNote({id:`delete-race-${order}`,text:'delete race',syntax:'plain',createdAt:3,updatedAt:3});
    await applyMergedSnapshot([{notes:[seed],tombstones:[]}]);
    const merge = () => applyMergedSnapshot([{notes:[seed],tombstones:[]}]);
    await Promise.all(order === 'delete-first' ? [removeNote(seed.id,false),merge()] : [merge(),removeNote(seed.id,false)]);
    const storedNotes = await transact('readonly', store => store.getAll());
    const storedDeletions = await transact('readonly', store => store.getAll(), DELETIONS_STORE);
    return {memory:notes.some(n => n.id === seed.id),stored:storedNotes.some(n => n.id === seed.id),deletion:tombstones.some(n => n.id === seed.id),storedDeletion:storedDeletions.some(n => n.id === seed.id)};
   },order);
   assert.deepEqual(state,{memory:false,stored:false,deletion:true,storedDeletion:true},`${order}: deletion and stale merge cannot resurrect notes or lose tombstones`);
  }
  for (const kind of ['create','restore']) {
   for (const order of ['local-first','merge-first']) {
    const state = await page.evaluate(async ({kind,order}) => {
     const before = new Set(notes.map(n => n.id));
     const original = {id:'recovery-source',text:'recovered text',syntax:'org'};
     const local = () => kind === 'create' ? createNote() : restoreDeletedNote(original);
     const merge = () => applyMergedSnapshot([]);
     await Promise.all(order === 'local-first' ? [local(),merge()] : [merge(),local()]);
     const added = notes.filter(n => !before.has(n.id));
     const stored = await transact('readonly',store => store.getAll());
     return {added,storedAdded:stored.filter(n => !before.has(n.id)),activeId:activeNote?.id};
    },{kind,order});
    assert.equal(state.added.length,1,`${kind}/${order}: exactly one fresh ID in memory`);
    assert.notEqual(state.added[0].id,'recovery-source','restore never reuses deleted ID');
    assert.deepEqual(state.storedAdded,state.added,`${kind}/${order}: memory and storage agree`);
    if (kind === 'create') assert.equal(state.activeId,state.added[0].id,'created note remains active');
    else assert.equal(state.added[0].text,'recovered text');
   }
  }
  const queuedSave = await page.evaluate(async () => {
   // Hold a real local save's completion while another merge and save queue up.
   await createNote();
   const id = activeNote.id;
   editor.value = 'before queued merge'; queueSave();
   const originalTransact = transact;
   let release, started;
   const gate = new Promise(resolve => {release = resolve;});
   const entered = new Promise(resolve => {started = resolve;});
   let hold = true;
   transact = async (...args) => {
    const result = await originalTransact(...args);
    if (args[0] === 'readwrite' && hold) {hold = false; started(); await gate;}
    return result;
   };
   try {
    const saving = saveActiveNote();
    await entered;
    const merging = applyMergedSnapshot([]);
    editor.value = 'saved while merge queued'; queueSave();
    const secondSave = saveActiveNote();
    release();
    await Promise.all([saving,merging,secondSave]);
    await flushSave();
    return {id,text:notes.find(n => n.id === id)?.text,active:activeNote.text,stored:(await originalTransact('readonly',store => store.get(id))).text,dirty};
   } finally {release(); transact = originalTransact;}
  });
  assert.equal(queuedSave.text,'saved while merge queued');
  assert.equal(queuedSave.active,queuedSave.text);
  assert.equal(queuedSave.stored,queuedSave.text);
  assert.equal(queuedSave.dirty,false,'nested flushes finish without deadlock');
  const responsive = await page.evaluate(async () => {
   let release, started;
   const gate = new Promise(resolve => {release = resolve;});
   const entered = new Promise(resolve => {started = resolve;});
   const importing = importBackup({text:async () => {started(); await gate; return JSON.stringify({format:'scratch-backup',version:3,notes:[],tombstones:[]});}});
   await entered;
   const writing = (async () => {await createNote(); editor.value = 'written during file read'; queueSave(); await flushSave(); return activeNote.id;})();
   try {
    const id = await Promise.race([writing,new Promise((_,reject) => setTimeout(() => reject(new Error('file read blocked local writing')),1500))]);
    release(); await importing;
    return notes.find(n => n.id === id)?.text;
   } finally {release();}
  });
  assert.equal(responsive,'written during file read');
  const persisted = await page.evaluate(async () => ({notes:[...notes].sort((a,b) => a.id.localeCompare(b.id)),tombstones:[...tombstones].sort((a,b) => a.id.localeCompare(b.id))}));
  await page.reload();
  await page.waitForFunction(count => db && notes.length === count,persisted.notes.length);
  assert.deepEqual(await page.evaluate(() => ({notes:[...notes].sort((a,b) => a.id.localeCompare(b.id)),tombstones:[...tombstones].sort((a,b) => a.id.localeCompare(b.id))})),persisted,'all mutations and deletion records survive reload without resurrection');
  console.log('PASS: concurrent imports/shared snapshot ownership; delete/create/restore vs merge both orders; saves behind merge; file-read responsiveness; complete reload consistency');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
