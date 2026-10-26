"""Run: uv run --with playwright python tests/colours-browser.py"""
import io
import subprocess
import tarfile
import tempfile
import functools
import http.server
import pathlib
import threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A browser may cancel its old shell fetch during navigation.


def check(browser_type, url):
    browser = browser_type.launch()
    context = browser.new_context(viewport={"width": 375, "height": 812}, color_scheme="light", reduced_motion="no-preference")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.wait_for_function("typeof db !== 'undefined' && db")
    button = page.locator('#colour-button')
    assert button.count() == 1, 'Main-screen colour cycle button is missing'
    assert button.get_attribute('aria-label') == 'Colour: White. Next: Red'
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(0, 0, 0)'
    assert page.evaluate("getComputedStyle(document.body).color") == 'rgb(255, 255, 255)'
    box = button.bounding_box()
    assert box['width'] >= 44 and box['height'] >= 44
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    button.click()
    assert button.get_attribute('data-mode') == 'red'
    assert page.evaluate("getComputedStyle(document.body).color") == 'rgb(208, 48, 40)'
    for selector in ['#new-note-button', '.sort-controls button.active']:
        assert page.locator(selector).evaluate('(e) => getComputedStyle(e).color') == 'rgb(208, 48, 40)', selector
    page.locator('#new-note-button').click()
    page.locator('#editor').fill('* A coloured note\nSome text and [[https://example.com][link]]')
    assert page.locator('#editor').evaluate('(e) => getComputedStyle(e).color') == 'rgb(208, 48, 40)'
    assert page.locator('#delete-button').evaluate('(e) => getComputedStyle(e).color') == 'rgb(208, 48, 40)'
    page.screenshot(path=str(pathlib.Path.home() / '.hermes/cache/scratch' / f'scratch-red-editor-{browser_type.name}.png'))
    page.locator('#editor-settings-button').click()
    assert page.locator('[data-setting="font"][data-value="sans"]').count() == 0
    assert page.locator('[data-setting="font"].active').get_attribute('data-value') == 'univers'
    page.locator('.switch').filter(has=page.locator('#org-toggle')).click()
    page.locator('#settings-dialog button[value="close"]').click()
    assert page.locator('.org-heading').first.evaluate('(e) => getComputedStyle(e).color') == 'rgb(208, 48, 40)'
    page.locator('#back-button').click()
    page.reload()
    page.wait_for_function("typeof db !== 'undefined' && db")
    assert button.get_attribute('data-mode') == 'red'
    for mode in ['blockiness', 'drift', 'wheel']:
        button.click()
        page.wait_for_function('(mode) => document.querySelector("#colour-button").dataset.mode === mode', arg=mode)
        page.wait_for_timeout(250)
        first = page.evaluate('getComputedStyle(document.body).color')
        assert first != 'rgb(0, 0, 0)', 'Playback must never hide all controls'
        page.wait_for_function('(first) => getComputedStyle(document.body).color !== first', arg=first, timeout=12000)
        assert button.get_attribute('data-error') is None
    button.click()
    assert button.get_attribute('data-mode') == 'white'
    # Old saved Sans selection migrates without touching note content.
    page.evaluate('localStorage.setItem("scratch-settings-v1", JSON.stringify({font:"sans"}))')
    page.reload()
    page.wait_for_function("typeof db !== 'undefined' && db")
    assert page.evaluate('settings.font') == 'univers'
    assert page.locator('.note-title').count() == 1
    # Assets must be precached, not merely cached after playing each mode.
    page.evaluate('navigator.serviceWorker.ready.then(() => new Promise(resolve => { if(navigator.serviceWorker.controller) resolve(); else navigator.serviceWorker.addEventListener("controllerchange", resolve, {once:true}); }))')
    cache_urls = page.evaluate('caches.keys().then(async keys => (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat())')
    assert any('/colours/blockiness.' in u for u in cache_urls)
    assert any('/colours/nocturnal-drift.' in u for u in cache_urls)
    context.set_offline(True)
    page.reload()
    page.wait_for_function("typeof db !== 'undefined' && db")
    button.click()
    button.click()
    page.wait_for_timeout(400)
    assert button.get_attribute('data-mode') == 'blockiness'
    assert button.get_attribute('data-error') is None
    page.screenshot(path=str(pathlib.Path.home() / '.hermes/cache/scratch' / f'scratch-colours-{browser_type.name}.png'))
    assert not errors, errors
    context.close()
    browser.close()
    print(f'{browser_type.name}: five modes, all foreground/Org, persistence, Sans migration, mobile layout, offline playback PASS')


def check_upgrade(browser_type):
    # Real prior committed shell, same origin + IndexedDB, then cut the network.
    scratch = pathlib.Path.home() / '.hermes/cache/scratch'
    with tempfile.TemporaryDirectory(prefix='scratch-upgrade-', dir=scratch) as previous:
        archive = subprocess.check_output(['git', 'archive', 'ccede36a35dc1374912bafe8bc07d9edd44a005a', 'scratch'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(previous, filter='data')
        class SwitchingHandler(QuietHandler):
            root = previous
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(self.root), **kwargs)
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), SwitchingHandler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            browser = browser_type.launch()
            context = browser.new_context(viewport={"width": 375, "height": 812}, reduced_motion='no-preference')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            try:
                page.goto(f'http://127.0.0.1:{server.server_port}/scratch/')
                page.wait_for_function("typeof db !== 'undefined' && db")
                assert page.locator('#colour-button').count() == 0
                page.locator('#new-note-button').click()
                page.locator('#editor').fill('A note surviving the colour upgrade')
                page.locator('#back-button').click()
                page.evaluate('navigator.serviceWorker.ready')
                page.wait_for_function('navigator.serviceWorker.controller !== null')
                assert page.evaluate('caches.has("scratch-shell-v20")')
                SwitchingHandler.root = str(ROOT)
                page.evaluate('''() => new Promise(async (resolve, reject) => {
                  navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true});
                  try { await (await navigator.serviceWorker.getRegistration()).update(); }
                  catch (error) { reject(error); }
                })''')
                assert page.evaluate('caches.has("scratch-shell-v21")')
                page.wait_for_function('caches.has("scratch-shell-v20").then(exists => !exists)', timeout=5000)
                context.set_offline(True)
                page.reload()
                page.wait_for_function("typeof db !== 'undefined' && db")
                assert page.locator('.note-title').inner_text() == 'A note surviving the colour upgrade'
                assert page.evaluate('settings.font') == 'univers'
                button = page.locator('#colour-button')
                for _ in range(3):
                    button.click()
                page.wait_for_function('document.querySelector("#colour-button").getAttribute("aria-busy") !== "true"')
                assert button.get_attribute('data-mode') == 'drift'
                assert button.get_attribute('data-error') is None
                page.locator('.note-button').click()
                page.locator('#editor').fill('Still editable offline after the colour upgrade')
                page.locator('#back-button').click()
                page.wait_for_function('document.querySelector(".note-title")?.textContent === "Still editable offline after the colour upgrade"')
                page.reload()
                page.wait_for_function("typeof db !== 'undefined' && db")
                assert page.locator('.note-title').inner_text() == 'Still editable offline after the colour upgrade'
                assert button.get_attribute('data-mode') == 'drift'
                assert not errors, errors
                print(f'{browser_type.name}: old v20 shell → v21, note preservation, Sans migration, offline Drift/edit/reload PASS')
            finally:
                context.close()
                browser.close()
                server.shutdown()


def check_failures_and_reduced_motion(browser_type, url):
    browser = browser_type.launch()
    context = browser.new_context(service_workers='block', reduced_motion='reduce')
    page = context.new_page()
    page.route('**/*.0dv', lambda route: route.fulfill(status=200, body=b'xx'))
    page.goto(url)
    page.wait_for_function("typeof db !== 'undefined' && db")
    button = page.locator('#colour-button')
    button.click()
    button.click()
    page.wait_for_function('document.querySelector("#colour-button").dataset.error === "unavailable"')
    assert page.evaluate('getComputedStyle(document.body).color') == 'rgb(255, 255, 255)'
    page.unroute('**/*.0dv')
    button.click()
    page.wait_for_function('document.querySelector("#colour-button").getAttribute("aria-busy") !== "true"')
    first = page.evaluate('getComputedStyle(document.body).color')
    page.wait_for_timeout(500)
    assert page.evaluate('getComputedStyle(document.body).color') == first
    assert button.get_attribute('data-error') is None
    button.click()
    first = page.evaluate('getComputedStyle(document.body).color')
    page.wait_for_timeout(500)
    assert page.evaluate('getComputedStyle(document.body).color') == first
    page.emulate_media(reduced_motion='no-preference')
    page.wait_for_function('(first) => getComputedStyle(document.body).color !== first', arg=first)
    for width in [320, 375, 430, 1024]:
        page.set_viewport_size({'width': width, 'height': 812})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    context.close()
    browser.close()
    print(f'{browser_type.name}: malformed-asset recovery, reduced motion, responsive widths PASS')


if __name__ == '__main__':
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                for kind in (playwright.chromium, playwright.webkit):
                    url = f'http://127.0.0.1:{server.server_port}/scratch/'
                    check(kind, url)
                    check_failures_and_reduced_motion(kind, url)
                    check_upgrade(kind)
        finally:
            server.shutdown()
