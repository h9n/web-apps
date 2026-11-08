"""Run: uv run --with playwright python tests/tags-browser.py [search|read|suggest|full]."""
import functools
import http.server
import pathlib
import sys
import threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS = pathlib.Path.home() / '.hermes/cache/scratch/scratch-tags'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
    def copyfile(self, source, output):
        try: super().copyfile(source, output)
        except (BrokenPipeError, ConnectionResetError): pass

def check(kind, url, phase):
    browser = kind.launch()
    context = browser.new_context(viewport={'width':375,'height':812})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function('typeof db !== "undefined" && db')
    for text in ['Alpha #ideas blue #work', 'Beta #ideas red', 'Gamma #ideas-extra blue #work', 'Delta #東京 blue', 'Epsilon #IDEAS blue']:
        page.locator('#new-note-button').click()
        page.locator('#editor').fill(text)
        page.locator('#back-button').click()
        page.wait_for_function('editorView.hidden && !dirty')
    page.locator('#search-button').click()
    search = page.locator('#note-search')
    search.fill('#ideas blue')
    assert page.locator('.note-title').all_text_contents() == ['Epsilon #IDEAS blue','Alpha #ideas blue #work'], 'Words and exact tags must intersect, case-insensitively'
    search.fill('#ideas #work blue')
    assert page.locator('.note-title').all_text_contents() == ['Alpha #ideas blue #work']
    search.fill('#東京')
    assert page.locator('.note-title').all_text_contents() == ['Delta #東京 blue']
    search.fill('')
    if phase == 'search':
        context.close(); browser.close(); print(kind.name, 'search PASS'); return
    page.locator('.note-button').filter(has_text='Alpha').click()
    assert page.locator('#editor').evaluate('(e) => e.tagName') == 'TEXTAREA'
    assert page.locator('#reader-button').is_visible(), 'Plain notes need a tappable Read view'
    page.locator('#reader-button').click()
    page.locator('#reader button[data-tag="#ideas"]').click()
    page.wait_for_function('editorView.hidden')
    assert search.input_value() == '#ideas'
    assert page.locator('.note-title').count() == 3
    search.fill('#ideas blue #work')
    assert page.locator('.note-title').count() == 1
    if phase == 'read':
        context.close(); browser.close(); print(kind.name, 'read PASS'); return
    search.fill('#id')
    assert page.locator('#search-tag-suggestions button').all_text_contents() == ['#ideas', '#ideas-extra']
    search.press('ArrowUp')
    assert search.get_attribute('aria-activedescendant') == 'search-tag-suggestions-1', 'Up from no selection chooses the last tag'
    search.press('Escape')
    assert not page.locator('#search-tag-suggestions').is_visible()
    search.fill(''); search.fill('#id')
    page.screenshot(path=str(ARTIFACTS / f'suggestions-{kind.name}.png'))
    search.press('ArrowDown'); search.press('Enter')
    assert search.input_value() == '#ideas '
    assert page.locator('.note-title').count() == 3
    page.locator('.note-button').filter(has_text='Alpha').click()
    editor = page.locator('#editor')
    editor.fill('Edited #id suffix')
    editor.evaluate('(e) => {e.setSelectionRange(10,10); e.dispatchEvent(new Event("click"));}')
    page.locator('#editor-tag-suggestions button').filter(has_text='#ideas').first.click()
    assert editor.input_value() == 'Edited #ideas suffix'
    assert editor.evaluate('(e) => e.selectionStart') == 14
    assert editor.evaluate('(e) => document.activeElement === e')
    # Native Undo/Redo is checked below on a fresh textarea, without Playwright
    # fill()'s synthetic replace-all history from editing multiple fixtures.
    editor.press('End'); editor.press('Enter'); editor.press('End'); editor.type(' #fresh')
    expected = editor.input_value()
    page.locator('#back-button').click()
    page.wait_for_function('editorView.hidden && !dirty')
    page.reload(); page.wait_for_function('typeof db !== "undefined" && db')
    page.locator('.note-button').filter(has_text='Edited').click()
    assert editor.input_value() == expected
    # Reader text must be literal/safe; hashtags in markup cannot become HTML.
    editor.fill('<img src=x onerror="window.__xss=1"> #fresh #東京 & text')
    page.locator('#reader-button').click()
    page.locator('#reader').wait_for(state='visible')
    assert page.locator('#reader img').count() == 0
    assert page.locator('#reader').inner_text().startswith('<img')
    assert page.locator('#reader button[data-tag="#東京"]').count() == 1
    assert not page.evaluate('window.__xss')
    page.screenshot(path=str(ARTIFACTS / f'reader-{kind.name}.png'))
    for width in [320,375,768,1280]:
        page.set_viewport_size({'width':width,'height':812})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    page.locator('#reader-button').click()
    editor.fill('Only #fresh')
    page.locator('#back-button').click(); page.wait_for_function('editorView.hidden && !dirty')
    page.locator('#search-button').click(); search.fill('#fr')
    assert page.locator('#search-tag-suggestions button').all_text_contents() == ['#fresh']
    # Tags disappear when the last live occurrence is deleted, and reappear on undo.
    search.fill('Only')
    page.locator('.note-button').click()
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#delete-button').click()
    page.wait_for_function('editorView.hidden')
    page.locator('#search-button').click() if not search.is_visible() else None
    search.fill('#fr')
    assert page.locator('#search-tag-suggestions button').count() == 0
    page.locator('#undo-delete').click()
    page.wait_for_function('notes.some(n => n.text === "Only #fresh")')
    search.fill(''); search.fill('#fr')
    assert page.locator('#search-tag-suggestions button').all_text_contents() == ['#fresh']
    page.screenshot(path=str(ARTIFACTS / f'search-{kind.name}.png'))
    native = context.new_page()
    native.on('pageerror', lambda e: errors.append(str(e)))
    native.goto(url)
    native.wait_for_function('typeof db !== "undefined" && db && notes.some(n => n.text.includes("#ideas"))')
    native.locator('#new-note-button').click()
    typed = native.locator('#editor')
    native.wait_for_function('document.activeElement === editor && !editorView.hidden')
    typed.type('Native #id')
    assert typed.input_value() == 'Native #id', typed.input_value()
    typed.click()
    typed.press('End')
    native.locator('#editor-tag-suggestions button').filter(has_text='#ideas').first.click()
    assert typed.input_value() == 'Native #ideas '
    typed.press('Meta+z')
    assert typed.input_value() != 'Native #ideas ', 'Completion must use native undo'
    typed.press('Meta+Shift+z')
    assert typed.input_value() == 'Native #ideas ', f'Native redo failed: {typed.input_value()!r}'
    native.screenshot(path=str(ARTIFACTS / f'native-editor-{kind.name}.png'))
    typed.type(' #' + 'a' * 240)
    native.locator('#reader-button').click(); native.locator('#reader').wait_for(state='visible')
    for width in [320, 375, 768, 1280]:
        native.set_viewport_size({'width':width,'height':812})
        assert native.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert native.locator('#reader').evaluate('(e) => e.scrollWidth <= e.clientWidth'), 'Long tags must wrap in the reader'
        for selector in ['#back-button','#reader-button','#share-button','#editor-settings-button','#delete-button']:
            box = native.locator(selector).bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width, (width,selector,box)
    native.locator('#reader-button').click()
    native.locator('#editor-settings-button').click()
    native.locator('.switch').filter(has=native.locator('#org-toggle')).click()
    native.locator('#settings-dialog button[value="close"]').click()
    typed.fill('Org *#long_tag_name* and [[https://example.com/#work][#link]] =#code_tag= #東京')
    native.locator('#reader-button').click(); native.locator('#reader').wait_for(state='visible')
    assert native.locator('#reader button[data-tag="#long_tag_name"]').count() == 1, 'Org markup must not split a source hashtag'
    assert native.locator('#reader a').get_attribute('href') == 'https://example.com/#work'
    assert native.locator('#reader a button, #reader code button').count() == 0
    assert native.locator('#reader button[data-tag="#東京"]').count() == 1
    native.close()
    assert not errors, errors
    context.close(); browser.close(); print(kind.name, 'tags: search/read/native autocomplete/safety/persistence/delete/undo/responsive PASS')

if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(QuietHandler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            for kind in [p.chromium,p.webkit]: check(kind, f'http://127.0.0.1:{server.server_port}/scratch/', sys.argv[1] if len(sys.argv)>1 else 'full')
    finally: server.shutdown()
