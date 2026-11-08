"""Isolated real-browser metadata panel acceptance tests (no user data)."""
import functools, http.server, pathlib, threading, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
ART = pathlib.Path.home()/'.hermes/cache/scratch/tag-panel'
ART.mkdir(parents=True, exist_ok=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args): pass

def check(kind, url):
 browser=kind.launch()
 context=browser.new_context(viewport={'width':375,'height':812})
 page=context.new_page(); errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto(url); page.wait_for_function('typeof db !== "undefined" && db')
 original='Body #inline\n\n#東京 #ideas\n\n'
 page.evaluate('''async text => {await createNote(); editor.value=text; queueSave(); await flushSave(); await closeEditor();}''', original)
 before=page.evaluate('notes[0]')
 page.locator('.note-button').first.click()
 assert page.locator('#editor').input_value()=='Body #inline', 'trailing metadata must be hidden'
 assert page.locator('#editor-tag-links').count()==0
 assert page.locator('#tag-links-controls').count()==0
 page.locator('#reader-button').click()
 assert '#ideas' not in page.locator('#reader').inner_text()
 page.locator('#reader-button').click()
 page.locator('#back-button').click(); page.wait_for_function('editorView.hidden')
 assert page.evaluate('notes[0]')==before, 'unchanged open/save must not create revisions or normalize bytes'
 page.locator('.note-button').first.click()
 page.locator('#tags-button').click()
 assert page.locator('#tag-panel').is_visible()
 assert page.locator('#tag-list [data-tag]').all_text_contents()==['#東京','#ideas']
 page.locator('#tag-input').fill('#new')
 page.locator('#tag-add').click()
 page.locator('#tag-list button[aria-label="Remove #東京"]').click()
 page.locator('#tag-input').fill('#id')
 assert page.locator('#panel-tag-suggestions button').all_text_contents()==['#ideas']
 page.locator('#tag-input').press('ArrowDown');page.locator('#tag-input').press('Enter')
 assert page.locator('#tag-input').input_value()=='#ideas '
 page.locator('#tag-add').click()
 page.locator('#tag-panel-done').click()
 page.locator('#editor').fill('Edited #inline')
 page.locator('#back-button').click(); page.wait_for_function('editorView.hidden && !dirty')
 assert page.evaluate('notes[0].text')=='Edited #inline\n\n#ideas #new\n\n'
 page.reload(); page.wait_for_function('typeof db !== "undefined" && db && notes.length')
 page.locator('.note-button').first.click()
 assert page.locator('#editor').input_value()=='Edited #inline'
 page.locator('#tags-button').click()
 page.screenshot(path=str(ART/f'panel-{kind.name}.png'))
 page.locator('#tag-list [aria-label="Edit #new"]').click()
 page.locator('#tag-input').fill('#'+'a'*240);page.locator('#tag-add').click()
 for width in [320,375,481,768,1280]:
  page.set_viewport_size({'width':width,'height':812})
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  for selector in ['#tags-button', '#tag-add', '#tag-list button']:
   for rect in page.locator(selector).evaluate_all('(nodes)=>nodes.map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))'):
    assert rect['width'] >= 44 and rect['height'] >= 44, (selector,rect)
 page.locator('#tag-list [data-tag="#ideas"]').click()
 page.wait_for_function('editorView.hidden')
 assert page.locator('#note-search').input_value()=='#ideas'
 page.locator('#note-search').fill('#ideas Edited')
 assert page.locator('.note-button').count()==1
 # Whitespace-only existing notes and CRLF are authored data, not empty drafts.
 cases=['', ' \n\n', '#only\n\n', 'line1\r\nline2\r\n\r\n#東京  #café\r\n', '* Org heading\nprose #inline\n\n#org_tag\n', 'prose #inline\n\n']
 for index,text in enumerate(cases):
  note=page.evaluate('''async ({index,text}) => {
    const note=ScratchSync.normalizeNote({id:'edge-'+index,text,syntax:index===4?'org':'plain',createdAt:100+index,updatedAt:100+index});
    await transact('readwrite',store=>store.put(note)); await loadNotes(); openNote(note.id); return structuredClone(activeNote);
  }''', {'index':index,'text':text})
  body=page.evaluate('parseTagMetadata(activeNote.text).body.replace(/\\r\\n?/g,"\\n")')
  assert page.locator('#editor').input_value()==body
  page.locator('#editor').dispatch_event('input')  # unchanged normalized textarea value
  page.locator('#reader-button').click()
  if index in [2,3,4]: assert page.locator('#reader').inner_text().find(['#only','#東京','#org_tag'][[2,3,4].index(index)])==-1
  page.locator('#back-button').click();page.wait_for_function('editorView.hidden')
  after=page.evaluate('(id)=>notes.find(n=>n.id===id)',note['id'])
  assert after==note, ('no-op changed canonical note/revision',note,after)
 # A merge while the panel contains an unapplied valid tag must include that
 # exact draft and body in its pre-merge flush and reload the combined source.
 page.evaluate('openNote("edge-3")')
 page.locator('#tags-button').click();page.locator('#tag-input').fill('#extra')
 page.evaluate('applyMergedSnapshot([{notes:[],tombstones:[]}])')
 assert page.locator('#editor').input_value()=='line1\nline2'
 assert page.evaluate('activeNote.text')=='line1\r\nline2\r\n\r\n#東京 #café #extra\r\n'
 assert page.evaluate('panelTags')==['#東京','#café','#extra']
 # Real download/import roundtrip: no tag fields or schema migrations.
 page.locator('#back-button').click();page.wait_for_function('editorView.hidden && !dirty')
 page.locator('#data-button').click()
 with page.expect_download() as downloaded: page.locator('#export-button').click()
 backup=ART/f'roundtrip-{kind.name}.json';downloaded.value.save_as(str(backup))
 payload=json.loads(backup.read_text())
 assert payload['version']==3 and payload['format']=='scratch-backup'
 assert all('tags' not in note for note in payload['notes'])
 restored=browser.new_context(); other=restored.new_page()
 other.on('dialog',lambda dialog:dialog.accept())
 other.on('pageerror',lambda e:errors.append(str(e)))
 other.goto(url);other.wait_for_function('typeof db !== "undefined" && db')
 other.locator('#data-button').click();other.locator('#import-input').set_input_files(str(backup))
 other.wait_for_function('(count)=>notes.length===count',arg=len(payload['notes']))
 assert sorted(other.evaluate('notes'),key=lambda n:n['id'])==sorted(payload['notes'],key=lambda n:n['id'])
 other.reload();other.wait_for_function('(count)=>typeof db!=="undefined" && db && notes.length===count',arg=len(payload['notes']))
 assert sorted(other.evaluate('notes'),key=lambda n:n['id'])==sorted(payload['notes'],key=lambda n:n['id'])
 restored.close()
 assert not errors,errors
 context.close(); browser.close(); print(kind.name,'tag panel PASS')

if __name__=='__main__':
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   for kind in [p.chromium,p.webkit]: check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
 finally: server.shutdown()
