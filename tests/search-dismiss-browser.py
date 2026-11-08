"""Search dismissal regression in isolated Chromium and WebKit contexts."""
import functools, http.server, pathlib, threading
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
ART = pathlib.Path.home()/'.hermes/cache/scratch/search-dismiss'
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args): pass

def check(kind, url):
 browser=kind.launch()
 page=browser.new_page(viewport={'width':320,'height':812})
 errors=[]; page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto(url); page.wait_for_function('typeof db !== "undefined" && db')
 page.evaluate(r'''async () => {
  for (const text of ['Alpha\n\n#ideas', 'Beta\n\n#other']) {
   await createNote(); editor.value=text; queueSave(); await flushSave(); await closeEditor();
  }
 }''')
 original=page.evaluate('JSON.stringify(notes)')
 height=page.locator('#list-controls').bounding_box()['height']
 page.locator('#search-button').click()
 page.locator('#note-search').fill('Alpha')
 assert page.locator('.note-button').count()==1
 close=page.get_by_role('button',name='Close search',exact=True)
 assert close.count()==1 and close.is_visible(), 'Search needs a discoverable Close search action, distinct from Clear'
 page.locator('#clear-search').click()
 assert page.locator('#search-controls').is_visible()
 assert page.locator('#note-search').input_value()==''
 assert page.locator('#note-search').evaluate('(e)=>e===document.activeElement')
 assert page.locator('.note-button').count()==2
 for width in [320,375,481,768,1280]:
  page.set_viewport_size({'width':width,'height':812})
  assert page.locator('#list-controls').bounding_box()['height']==height
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  for selector in ['#note-search','#clear-search','#close-search']:
   box=page.locator(selector).bounding_box()
   assert box['x']>=0 and box['x']+box['width']<=width, (width,selector,box)
  for selector in ['#clear-search','#close-search']:
   box=page.locator(selector).bounding_box(); assert box['width']>=44 and box['height']>=44
 page.set_viewport_size({'width':320,'height':812})
 ART.mkdir(parents=True,exist_ok=True)
 page.screenshot(path=str(ART/f'{kind.name}.png'))
 page.locator('#note-search').fill('#id')
 assert page.locator('#search-tag-suggestions').is_visible()
 close.click()
 def closed():
  assert page.locator('#search-controls').is_hidden()
  assert page.get_by_role('group',name='Sort notes').is_visible()
  assert page.locator('#note-search').input_value()==''
  assert not page.locator('#note-search').evaluate('(e)=>e===document.activeElement')
  assert page.locator('#search-tag-suggestions').is_hidden()
  assert page.locator('.note-button').count()==2
  assert page.locator('#search-button').get_attribute('aria-expanded')=='false'
 closed()
 page.locator('#search-button').click(); page.locator('#note-search').fill('#id')
 page.locator('#note-search').press('Escape')
 assert page.locator('#search-controls').is_visible(), 'First Escape only dismisses tag suggestions'
 assert page.locator('#search-tag-suggestions').is_hidden()
 assert page.locator('#note-search').input_value()=='#id'
 page.locator('#note-search').press('Escape'); closed()
 page.locator('#search-button').click(); page.locator('#note-search').fill('Alpha')
 page.locator('#note-search').press('Escape'); closed()
 page.locator('#search-button').click(); page.locator('#search-button').click(); closed()
 assert page.evaluate('JSON.stringify(notes)')==original
 assert not errors,errors
 browser.close(); print(kind.name,'search clear/close/Escape/autocomplete/320px bounds PASS',flush=True)

if __name__=='__main__':
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
 threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   for kind in [p.chromium,p.webkit]: check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
 finally: server.shutdown()
