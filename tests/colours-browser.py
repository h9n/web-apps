"""Run: uv run --with playwright python tests/colours-browser.py.
Real browser palette/offline checks and installed v22 → v23 shell upgrade.
"""
import functools
import http.server
import io
import pathlib
import subprocess
import tarfile
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = pathlib.Path.home() / '.hermes/cache/scratch/scratch-tags'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args): pass
    def copyfile(self, source, outputfile):
        try: super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError): pass

def ready(page):
    page.wait_for_function('typeof db !== "undefined" && db')

def check(kind, url):
    browser = kind.launch()
    context = browser.new_context(viewport={'width':375,'height':812}, reduced_motion='reduce')
    page = context.new_page()
    errors = []; streams = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: streams.append(r.url) if '.0dv' in r.url else None)
    page.goto(url); ready(page)
    button = page.locator('#colour-button')
    for mode, colour in [('white','255, 255, 255'),('red','208, 48, 40'),('lime','199, 255, 62'),('cyan','53, 232, 255'),('pink','255, 77, 166'),('violet','167, 139, 250'),('orange','255, 146, 87')]:
        assert button.get_attribute('data-mode') == mode
        assert page.evaluate('getComputedStyle(document.body).color') == f'rgb({colour})'
        assert page.locator('#new-note-button').evaluate('(e) => getComputedStyle(e).color') == f'rgb({colour})'
        if mode == 'lime': page.screenshot(path=str(ARTIFACTS / f'palette-{kind.name}.png'))
        button.click()
    assert button.get_attribute('data-mode') == 'neon'
    page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "true"')
    assert page.evaluate('getComputedStyle(document.body).color') == 'rgb(199, 255, 62)'
    button.click()
    assert button.get_attribute('data-mode') == 'wheel'
    first = page.evaluate('getComputedStyle(document.body).color')
    page.wait_for_timeout(300)
    assert page.evaluate('getComputedStyle(document.body).color') == first
    page.emulate_media(reduced_motion='no-preference')
    page.wait_for_function('(first) => getComputedStyle(document.body).color !== first', arg=first)
    for legacy in ['blockiness','drift','unknown']:
        page.evaluate('(id) => localStorage.setItem("scratch-colour-v1",id)', legacy)
        page.reload(); ready(page)
        assert button.get_attribute('data-mode') == 'white'
        assert page.evaluate('localStorage.getItem("scratch-colour-v1")') == 'white'
    button.click(); button.click()
    page.locator('#new-note-button').click()
    page.locator('#editor').fill('A fluorescent note #ideas')
    assert page.locator('#editor').evaluate('(e) => getComputedStyle(e).color') == 'rgb(199, 255, 62)'
    page.locator('#reader-button').click(); page.locator('#reader').wait_for(state='visible')
    assert page.locator('#reader .hashtag').evaluate('(e) => getComputedStyle(e).color') == 'rgb(199, 255, 62)'
    page.locator('#back-button').click()
    page.wait_for_function('editorView.hidden && !dirty')
    page.evaluate('navigator.serviceWorker.ready')
    page.wait_for_function('navigator.serviceWorker.controller !== null')
    urls = page.evaluate('caches.open("scratch-shell-v23").then(async c => (await c.keys()).map(r => r.url))')
    assert [u.rsplit('/',1)[-1] for u in urls if '.0dv' in u] == ['ctrl-deck-neon.30fps.10g.0dv']
    for file in ['app.js','styles.css','sync.js','colours.js']:
        assert any(f'{file}?v=23' in u for u in urls)
    context.set_offline(True); page.reload(); ready(page)
    assert button.get_attribute('data-mode') == 'lime'
    assert page.locator('.note-title').inner_text() == 'A fluorescent note #ideas'
    assert all('ctrl-deck-neon.30fps.10g.0dv' in u for u in streams), streams
    assert not errors, errors
    context.close(); browser.close()
    print(kind.name, 'exact palette, foreground propagation, persistence, removed-mode migration, motion, precache/offline PASS')

def check_upgrade(kind):
    with tempfile.TemporaryDirectory(prefix='scratch-upgrade-', dir=ARTIFACTS.parent) as previous:
        archive = subprocess.check_output(['git','archive','97dc0f8','scratch'],cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source: source.extractall(previous,filter='data')
        class Handler(QuietHandler):
            root = previous
            def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(self.root),**kwargs)
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        browser = kind.launch(); context = browser.new_context(viewport={'width':375,'height':812})
        page = context.new_page(); errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto(f'http://127.0.0.1:{server.server_port}/scratch/'); ready(page)
            page.locator('#new-note-button').click()
            page.locator('#editor').fill('Preserved original #ideas')
            page.locator('#back-button').click()
            page.wait_for_function('editorView.hidden && !dirty')
            before = page.evaluate('structuredClone(notes)')
            page.evaluate('localStorage.setItem("scratch-colour-v1","drift")')
            page.evaluate('navigator.serviceWorker.ready')
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            assert page.evaluate('caches.has("scratch-shell-v22")')
            Handler.root = str(ROOT)
            page.evaluate('''() => new Promise(async (resolve,reject) => {
              navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});
              try { await (await navigator.serviceWorker.getRegistration()).update(); } catch(e) {reject(e);}
            })''')
            page.wait_for_function('caches.keys().then(keys => keys.includes("scratch-shell-v23") && !keys.includes("scratch-shell-v22"))')
            context.set_offline(True); page.reload(); ready(page)
            assert page.evaluate('structuredClone(notes)') == before, 'Upgrade must preserve every note field/revision'
            assert page.locator('#colour-button').get_attribute('data-mode') == 'white'
            page.locator('.note-button').click()
            page.locator('#reader-button').click(); page.locator('#reader').wait_for(state='visible')
            page.locator('#reader button[data-tag="#ideas"]').click()
            page.wait_for_function('editorView.hidden')
            assert page.locator('#note-search').input_value() == '#ideas'
            page.locator('.note-button').click()
            link = page.locator('#editor-tag-links [data-tag="#ideas"]')
            rect = link.bounding_box()
            page.mouse.click(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
            page.wait_for_function('editorView.hidden && !dirty')
            assert page.locator('#note-search').input_value() == '#ideas'
            # A never-selected-before native neon mode must already be usable offline.
            for _ in range(7): page.locator('#colour-button').click()
            page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "true"')
            assert page.locator('#colour-button').get_attribute('data-mode') == 'neon'
            page.reload(); ready(page)
            page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "true"')
            assert page.evaluate('structuredClone(notes)') == before
            page.locator('.note-button').click()
            page.locator('#editor').fill('Offline edited #ideas #work')
            page.locator('#back-button').click(); page.wait_for_function('editorView.hidden && !dirty')
            page.reload(); ready(page)
            assert page.locator('.note-title').inner_text() == 'Offline edited #ideas #work'
            assert not errors,errors
            page.screenshot(path=str(ARTIFACTS / f'upgraded-offline-{kind.name}.png'))
            print(kind.name,'real v22 → v23 upgrade, exact notes/revisions preserved, removed preference migration, offline tag/read/edit/reload PASS')
        finally:
            context.close(); browser.close(); server.shutdown()

if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            for kind in [p.chromium,p.webkit]:
                check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
                check_upgrade(kind)
    finally: server.shutdown()
