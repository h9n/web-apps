"""Neon native stream playback, motion, cancellation and failure tests."""
import functools, http.server, pathlib, threading
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
ART=pathlib.Path.home()/'.hermes/cache/scratch/scratch-followup';ART.mkdir(parents=True,exist_ok=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path.endswith('.0dv') and self.headers.get('X-Neon-Stall'):
            self.send_response(200);self.send_header('Content-Length','900');self.end_headers();self.wfile.flush()
            threading.Event().wait(7)
            return
        super().do_GET()

def check(kind,url):
    browser=kind.launch()
    context=browser.new_context(viewport={'width':375,'height':812},reduced_motion='reduce',service_workers='block')
    page=context.new_page();errors=[]
    page.add_init_script('''(() => {
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.pendingAnimation = new Set();
      window.requestAnimationFrame = callback => {
        const id = raf(time => { pendingAnimation.delete(id); callback(time); });
        pendingAnimation.add(id); return id;
      };
      window.cancelAnimationFrame = id => { pendingAnimation.delete(id); cancel(id); };
    })()''')
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(url);page.wait_for_function('typeof db !== "undefined" && db')
    button=page.locator('#colour-button')
    for _ in range(7):button.click()
    assert button.get_attribute('data-mode')=='neon', 'New native neon colour option is required'
    page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "true"')
    assert page.evaluate('getComputedStyle(document.body).color')=='rgb(199, 255, 62)'
    page.wait_for_timeout(350)
    assert page.evaluate('getComputedStyle(document.body).color')=='rgb(199, 255, 62)'
    page.emulate_media(reduced_motion='no-preference')
    page.wait_for_timeout(1050)
    colour=page.evaluate('getComputedStyle(document.body).color')
    assert colour!='rgb(199, 255, 62)',colour
    page.screenshot(path=str(ART/f'neon-{kind.name}.png'))
    page.evaluate('''() => {Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}''')
    assert page.evaluate('pendingAnimation.size')==0
    hidden=page.evaluate('getComputedStyle(document.body).color')
    page.wait_for_timeout(200)
    assert page.evaluate('getComputedStyle(document.body).color')==hidden
    page.evaluate('''() => {Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));}''')
    assert page.evaluate('pendingAnimation.size')==1
    page.evaluate('window.dispatchEvent(new Event("pagehide"))')
    assert page.evaluate('pendingAnimation.size')==0
    page.evaluate('window.dispatchEvent(new Event("pageshow"))')
    assert page.evaluate('pendingAnimation.size')==1
    # Live preference changes freeze immediately, rather than letting a queued RAF run.
    page.emulate_media(reduced_motion='reduce')
    frozen=page.evaluate('getComputedStyle(document.body).color')
    page.wait_for_timeout(300)
    assert page.evaluate('getComputedStyle(document.body).color')==frozen
    # A held load may not repaint or reset the newer choice.
    held=[]
    page.route('**/*.0dv',lambda route: held.append(route))
    page.reload();page.wait_for_function('typeof db !== "undefined" && db')
    page.wait_for_function('document.querySelector("#colour-button").dataset.mode === "neon"')
    page.wait_for_timeout(100)
    button.click();button.click() # wheel → white
    assert button.get_attribute('data-mode')=='white'
    for route in held:
        try:route.fulfill(body=(ROOT/'scratch/colours/ctrl-deck-neon.30fps.10g.0dv').read_bytes())
        except Exception:pass # Fetch abort legitimately cancels the routed request.
    page.wait_for_timeout(100)
    assert page.evaluate('getComputedStyle(document.body).color')=='rgb(255, 255, 255)'
    page.unroute('**/*.0dv')
    page.route('**/*.0dv',lambda route:route.fulfill(body=b'bad!'))
    page.evaluate('localStorage.setItem("scratch-colour-v1","neon")');page.reload()
    page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "error"')
    assert page.evaluate('getComputedStyle(document.body).color')=='rgb(199, 255, 62)'
    button.click();assert button.get_attribute('data-mode')=='wheel'
    page.unroute('**/*.0dv')
    context.set_extra_http_headers({'X-Neon-Stall':'1'})
    page.route('**/*.0dv',lambda route:route.continue_()) # Bypass the browser's prior HTTP-cache hit.
    page.evaluate('localStorage.setItem("scratch-colour-v1","neon")');page.reload()
    page.wait_for_function('document.querySelector("#colour-button").dataset.loaded === "error"',timeout=7000)
    assert page.evaluate('getComputedStyle(document.body).color')=='rgb(199, 255, 62)'
    assert not errors,errors
    context.close();browser.close();print(kind.name,'native neon playback, reduced motion freeze, stale-load cancellation, malformed fallback PASS')
if __name__=='__main__':
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            for kind in [p.chromium,p.webkit]:check(kind,f'http://127.0.0.1:{server.server_port}/scratch/')
    finally:server.shutdown()
