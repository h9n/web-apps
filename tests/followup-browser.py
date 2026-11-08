"""Native editing and atomic tag/body saves, replacing obsolete mirror tests."""
import functools, http.server, pathlib, threading
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,format,*args): pass

def check(kind,url):
 browser=kind.launch(); context=browser.new_context(viewport={'width':375,'height':812},has_touch=True)
 page=context.new_page(); errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto(url); page.wait_for_function('typeof db !== "undefined" && db')
 page.locator('#new-note-button').click(); page.wait_for_function('document.activeElement === editor')
 editor=page.locator('#editor'); editor.type('Native #inline')
 after=editor.input_value(); editor.press('Meta+z'); assert editor.input_value()!=after
 editor.press('Meta+Shift+z'); assert editor.input_value()==after
 assert page.locator('#editor-tag-links').count()==0
 page.locator('#tags-button').click(); page.locator('#tag-input').fill('#one'); page.locator('#tag-add').click()
 page.locator('#tag-panel-done').click(); editor.fill('Atomic body #inline')
 page.locator('#tags-button').click()
 page.locator('#tag-list [aria-label="Edit #one"]').click(); page.locator('#tag-input').fill('#edited')
 # Navigation consumes pending input and locks ALL draft fields before yielding.
 page.evaluate('() => { queueLocalMutation(()=>new Promise(resolve=>{window.releaseSave=resolve;})); }')
 page.wait_for_function('typeof releaseSave === "function"')
 page.locator('#back-button').click()
 assert editor.evaluate('(e)=>e.readOnly'), 'Notes navigation must lock body while flush is held'
 assert page.locator('#tag-input').is_disabled()
 editor.focus(); editor.type(' late'); assert editor.input_value()=='Atomic body #inline'
 page.evaluate('releaseSave()'); page.wait_for_function('editorView.hidden && !dirty')
 assert page.evaluate('notes[0].text')=='Atomic body #inline\n\n#edited'
 page.reload();page.wait_for_function('typeof db !== "undefined" && db && notes.length')
 page.locator('.note-button').click(); assert not editor.evaluate('(e)=>e.readOnly')
 page.locator('#tags-button').click()
 # Failed real transaction leaves both fields recoverable; retry saves them together.
 page.locator('#tag-input').fill('#retry')
 page.wait_for_function('!dirty && activeNote.text.endsWith("#edited #retry")', timeout=4000)
 page.locator('#tag-add').click()
 page.evaluate('''() => {window.originalTransact=transact;transact=(mode,action)=>mode==='readwrite'?Promise.reject(new Error('fixture storage failure')):originalTransact(mode,action);}''')
 page.locator('#tag-input').fill('#unsaved')
 page.locator('#tag-list [data-tag="#edited"]').click();page.wait_for_function('!tagNavigationPending')
 assert page.locator('#editor-view').is_visible(); assert not editor.evaluate('(e)=>e.readOnly')
 assert not page.locator('#tag-input').is_disabled()
 assert page.locator('#tag-list [data-tag="#unsaved"]').count()==1
 page.evaluate('() => {transact=originalTransact;}'); page.locator('#tag-list [data-tag="#edited"]').click()
 page.wait_for_function('editorView.hidden && !dirty')
 assert page.evaluate('notes[0].text')=='Atomic body #inline\n\n#edited #retry #unsaved'
 # Clearing one tag then removing the following tag must not use its stale index.
 page.locator('.note-button').click();page.locator('#tags-button').click()
 page.locator('#tag-list [aria-label="Remove #unsaved"]').click()
 page.locator('#tag-list [aria-label="Edit #edited"]').click();page.locator('#tag-input').fill('')
 page.locator('#tag-list [aria-label="Remove #retry"]').click()
 assert page.evaluate('panelTags')==[], 'pending removal shifted the clicked tag index'
 page.locator('#back-button').click();page.wait_for_function('editorView.hidden && !dirty')
 assert page.evaluate('notes[0].text')=='Atomic body #inline'
 # Incomplete tags cannot navigate away, and must not block body autosave.
 page.locator('#note-search').fill('');page.locator('.note-button').click()
 page.locator('#tags-button').click();page.locator('#tag-input').fill('#')
 editor.fill('Body remains safe #inline')
 page.wait_for_function('!dirty && activeNote.text === "Body remains safe #inline"')
 page.locator('#reader-button').click();page.locator('#share-button').click();page.locator('#delete-button').click()
 assert page.locator('#editor-view').is_visible()
 page.locator('#back-button').click();page.wait_for_timeout(100)
 assert page.locator('#editor-view').is_visible()
 assert not editor.evaluate('(e)=>e.readOnly')
 page.locator('#tag-input').fill('#valid');page.locator('#back-button').click()
 page.wait_for_function('editorView.hidden && !dirty')
 assert page.evaluate('notes[0].text')=='Body remains safe #inline\n\n#valid'
 assert not errors,errors
 context.close();browser.close();print(kind.name,'native undo, held atomic saves, failure/retry, tag removal PASS')

if __name__=='__main__':
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   for kind in [p.chromium,p.webkit]:check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
 finally:server.shutdown()
