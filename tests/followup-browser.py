"""Editor tag-link interaction acceptance in Chromium and WebKit."""
import functools, http.server, pathlib, threading
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
ART = pathlib.Path.home()/'.hermes/cache/scratch/scratch-followup'
ART.mkdir(parents=True, exist_ok=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def check(kind, url):
    browser=kind.launch()
    context=browser.new_context(viewport={'width':375,'height':812},has_touch=True)
    page=context.new_page(); errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto(url); page.wait_for_function('typeof db !== "undefined" && db')
    page.locator('#new-note-button').click()
    editor=page.locator('#editor'); editor.fill('Fresh #ideas blue')
    page.locator('#editor-tag-links [data-tag="#ideas"]').wait_for(state='visible', timeout=2000)
    page.screenshot(path=str(ART/f'editor-short-{kind.name}.png'))
    # Click the real textarea, through the non-intercepting visual link layer.
    rect=page.locator('#editor-tag-links [data-tag="#ideas"]').bounding_box()
    # Touch taps follow links without an intercepting overlay.
    page.touchscreen.tap(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
    page.wait_for_function('editorView.hidden && !dirty')
    assert page.locator('#note-search').input_value()=='#ideas'
    page.locator('#note-search').fill('#ideas blue'); assert page.locator('.note-button').count()==1
    page.locator('.note-button').click(); page.wait_for_function('document.activeElement === editor')
    assert editor.input_value()=='Fresh #ideas blue'
    # Editing mode must leave native cursor/selection/undo untouched.
    page.locator('#tag-links-toggle').click()
    editor.click(); editor.press('End'); editor.type(' native')
    assert editor.input_value().endswith(' native')
    after=editor.input_value()
    editor.press('Meta+z'); assert editor.input_value()!=after
    editor.press('Meta+Shift+z'); assert editor.input_value()==after
    # Native drag selection and a held press must not navigate.
    page.locator('#tag-links-toggle').click()
    editor.fill('A #selection and more')
    rect=page.locator('#editor-tag-links [data-tag="#selection"]').bounding_box()
    x,y=rect['x']+rect['width']/2,rect['y']+rect['height']/2
    page.mouse.move(x,y);page.mouse.down();page.wait_for_timeout(400);page.mouse.up()
    assert page.locator('#editor-view').is_visible()
    editor.evaluate('(e)=>e.setSelectionRange(0,0)')
    box=editor.bounding_box()
    page.mouse.move(box['x']+5,y);page.mouse.down();page.mouse.move(x+40,y,steps=10);page.mouse.up()
    assert editor.evaluate('(e)=>e.selectionStart !== e.selectionEnd')
    assert page.locator('#editor-view').is_visible()
    # Scroll during a pointer gesture cancels link activation even if a different
    # occurrence lands under the same coordinate.
    editor.fill(('A #same\n')*100)
    editor.evaluate('(e)=>{e.setSelectionRange(0,0);e.scrollTop=0;e.dispatchEvent(new Event("scroll"));}')
    rect=page.locator('#editor-tag-links [data-tag="#same"]').first.bounding_box()
    x,y=rect['x']+rect['width']/2,rect['y']+rect['height']/2
    page.mouse.move(x,y);page.mouse.down()
    editor.evaluate('(e)=>{e.scrollTop=parseFloat(getComputedStyle(e).lineHeight);e.dispatchEvent(new Event("scroll"));}')
    page.mouse.up();page.wait_for_timeout(100)
    assert page.locator('#editor-view').is_visible(), 'Scroll gestures must not follow a tag'
    # Keyboard navigation exposes real focusable links, not just visual underlines.
    editor.fill('Keyboard #keys')
    link=page.locator('#editor-tag-links [data-tag="#keys"]')
    link.focus();link.press('Enter')
    page.wait_for_function('editorView.hidden && !dirty')
    assert page.locator('#note-search').input_value()=='#keys'
    page.locator('.note-button').click();page.wait_for_function('document.activeElement === editor')
    # Assistive technology activates links with a click, without pointer gestures.
    page.locator('#editor-tag-links [data-tag="#keys"]').evaluate('(e)=>e.click()')
    page.wait_for_function('editorView.hidden && !dirty',timeout=1500)
    page.locator('.note-button').click();page.wait_for_function('document.activeElement === editor')
    # Following a link reserves navigation synchronously while the queued save
    # is held; late native keystrokes cannot race the flush and disappear.
    editor.fill('Locked #locked')
    page.evaluate('() => {queueLocalMutation(()=>new Promise(resolve=>{window.releaseTagSave=resolve;}));}')
    page.wait_for_function('typeof releaseTagSave === "function"')
    page.locator('#editor-tag-links [data-tag="#locked"]').evaluate('(e)=>e.click()')
    assert editor.evaluate('(e)=>e.readOnly'), 'Lock editor before yielding to the navigation save'
    editor.focus();editor.type(' late')
    assert editor.input_value()=='Locked #locked'
    page.evaluate('releaseTagSave()')
    page.wait_for_function('editorView.hidden && !dirty')
    page.locator('.note-button').click();page.wait_for_function('document.activeElement === editor')
    assert not editor.evaluate('(e)=>e.readOnly')
    assert editor.input_value()=='Locked #locked'
    # Storage failures keep the editor/draft open and restore native editability.
    page.evaluate('() => {window.savedTagFlush=flushSave;flushSave=()=>Promise.reject(new Error("fixture"));}')
    page.locator('#editor-tag-links [data-tag="#locked"]').evaluate('(e)=>e.click()')
    page.wait_for_function('!tagNavigationPending')
    assert page.locator('#editor-view').is_visible()
    assert not editor.evaluate('(e)=>e.readOnly')
    assert editor.input_value()=='Locked #locked'
    page.evaluate('flushSave=savedTagFlush')
    editor.fill('Top #top\n'+'a line of text\n'*100+'Bottom #bottom')
    for width in [320,375,768,1280]:
        page.set_viewport_size({'width':width,'height':812})
        for font in ['mono','univers','univers-black','univers-extended']:
            page.evaluate('(font)=>updateSetting("font",font)',font)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.evaluate('''() => {
              const mirror=document.querySelector('#editor-tag-links');
              const a=getComputedStyle(editor),b=getComputedStyle(mirror);
              return ['fontFamily','fontSize','lineHeight','fontWeight','paddingLeft','paddingTop','whiteSpace'].every(k=>a[k]===b[k]);
            }''')
    page.set_viewport_size({'width':375,'height':812})
    page.evaluate('updateSetting("font","univers")')
    editor.evaluate('(e)=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event("scroll"));}')
    page.wait_for_timeout(100)
    rect=page.locator('#editor-tag-links [data-tag="#bottom"]').bounding_box()
    box=editor.bounding_box(); assert box['y'] <= rect['y'] < box['y']+box['height']
    assert page.evaluate('editor.scrollTop === document.querySelector("#editor-tag-links").scrollTop')
    page.screenshot(path=str(ART/f'editor-links-{kind.name}.png'))
    # Touch taps follow links without an intercepting overlay.
    page.touchscreen.tap(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
    page.wait_for_function('editorView.hidden && !dirty')
    assert page.locator('#note-search').input_value()=='#bottom'
    page.reload(); page.wait_for_function('typeof db !== "undefined" && db')
    assert page.locator('.note-title').count()==1
    assert not errors,errors
    context.close();browser.close();print(kind.name,'editor tag taps, flush/search, native undo/redo, scroll PASS')

if __name__=='__main__':
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            for kind in [p.chromium,p.webkit]:check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
    finally:server.shutdown()
