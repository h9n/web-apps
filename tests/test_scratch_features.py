import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ScratchFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "scratch" / "index.html").read_text()
        cls.css = (ROOT / "scratch" / "styles.css").read_text()
        cls.js = (ROOT / "scratch" / "app.js").read_text()

    def test_editor_line_spacing_is_compact(self):
        self.assertIn("font-size: 24px;\n  line-height: 1.1", self.css)
        self.assertIn("font-size: 18px; line-height: 1.1", self.css)
        self.assertIn("font-size: 14px; line-height: 1.1", self.css)

    def test_stash_network_requests_have_a_timeout(self):
        self.assertIn("async function fetchWithTimeout", self.js)
        self.assertIn("AbortController", self.js)
        self.assertIn("STASH_FETCH_TIMEOUT_MS", self.js)
        self.assertIn("fetchWithTimeout(`${baseUrl}/v1/health`", self.js)
        self.assertIn("fetchWithTimeout(stashObjectUrl()", self.js)

    def test_stash_setup_and_status_controls_exist(self):
        for control in ("stash-url", "stash-device", "stash-save-button", "stash-backup-button", "stash-status"):
            self.assertIn(f'id="{control}"', self.html)

    def test_stash_configuration_is_local_and_excluded_from_backups(self):
        self.assertIn('const STASH_KEY = "scratch-stash-v1"', self.js)
        self.assertIn("localStorage.getItem(STASH_KEY)", self.js)
        self.assertIn("localStorage.setItem(STASH_KEY", self.js)
        self.assertNotIn("stashConfig,\n    settings", self.js)

    def test_stash_health_upload_and_opportunistic_triggers_exist(self):
        self.assertIn('fetchWithTimeout(`${baseUrl}/v1/health`', self.js)
        self.assertIn('fetchWithTimeout(stashObjectUrl()', self.js)
        self.assertIn('window.addEventListener("online"', self.js)
        self.assertIn('document.visibilityState === "visible"', self.js)
        self.assertIn("const STASH_BACKUP_INTERVAL_MS", self.js)

    def test_large_editor_size_is_restrained(self):
        self.assertIn("font-size: 24px", self.css)
        self.assertNotIn("font-size: 30px", self.css)

    def test_editor_controls_exist(self):
        self.assertIn('data-value="xsmall"', self.html)
        self.assertIn('id="typing-toggle"', self.html)
        self.assertIn('id="share-button"', self.html)

    def test_notes_list_has_its_own_bounded_touch_scroll_area(self):
        self.assertRegex(self.css, r"(?s)#list-view\s*\{[^}]*height:\s*100dvh;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;")
        self.assertRegex(self.css, r"(?s)\.notes-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;")

    def test_list_search_filters_full_note_text_without_changing_storage(self):
        self.assertIn('id="note-search"', self.html)
        self.assertIn('const query = noteSearch.value.trim().toLocaleLowerCase()', self.js)
        self.assertIn('note.text.toLocaleLowerCase().includes(query)', self.js)
        self.assertIn('noteSearch.addEventListener("input", renderNotes)', self.js)
        self.assertIn('No matching notes.', self.js)
        self.assertIn('noteSearch.value = "";\n  openNote(note.id)', self.js)
        self.assertRegex(self.css, r'(?s)#list-view\s*\{[^}]*height:\s*var\(--visual-height, 100dvh\);[^}]*min-height:\s*0;')

    def test_search_is_collapsed_into_existing_sort_row(self):
        self.assertIn('id="search-button"', self.html)
        self.assertIn('id="note-search"', self.html)
        self.assertIn('id="search-controls"', self.html)
        self.assertNotIn('class="search-row"', self.html)
        self.assertIn('function setSearchOpen(open)', self.js)
        self.assertIn('searchButton?.addEventListener("click"', self.js)
        self.assertIn('.list-controls.searching', self.css)

    def test_shell_assets_are_versioned_together(self):
        self.assertIn('href="styles.css?v=14"', self.html)
        self.assertIn('src="app.js?v=14"', self.html)
        sw = (ROOT / 'scratch' / 'sw.js').read_text()
        self.assertIn('"./styles.css?v=14"', sw)
        self.assertIn('"./app.js?v=14"', sw)
        self.assertIn('scratch-shell-v14', sw)

    def test_univers_font_options_use_real_web_faces(self):
        for value in ('univers', 'univers-black', 'univers-extended'):
            self.assertIn(f'data-value="{value}"', self.html)
            self.assertIn(f'body.font-{value} :is(#editor, #editor-highlight)', self.css)
        self.assertIn('document.body.classList.toggle(`font-${face}`, settings.font === face)', self.js)
        for filename in ('U.woff2', 'U-Black.woff2', 'U-ExtraBlackExt.woff2'):
            self.assertTrue((ROOT / 'scratch' / 'fonts' / filename).is_file())
            self.assertIn(filename, self.css)
        self.assertIn('body.font-univers-extended :is(#editor, #editor-highlight)', self.css)

    def test_cursor_icon_has_vector_master_and_all_install_sizes(self):
        svg = (ROOT / 'scratch' / 'icons' / 'cursor.svg').read_text()
        self.assertIn('<path', svg)
        self.assertIn('cursor', svg.lower())
        self.assertTrue((ROOT / 'scratch' / 'icons' / 'cursor-180.png').is_file())
        self.assertIn('href="icons/cursor-180.png"', self.html)
        for size in (180, 192, 512):
            self.assertTrue((ROOT / 'scratch' / 'icons' / f'icon-{size}.png').is_file())
        self.assertTrue((ROOT / 'scratch' / 'icons' / 'icon-512-maskable.png').is_file())

    def test_list_controls_exist(self):
        self.assertIn('id="data-button"', self.html)
        self.assertIn('data-setting="sort"', self.html)
        self.assertIn('id="data-dialog"', self.html)

    def test_typing_assistance_updates_textarea_attributes(self):
        self.assertIn('editor.setAttribute("autocorrect"', self.js)
        self.assertIn('editor.setAttribute("autocapitalize"', self.js)
        self.assertIn('editor.spellcheck = settings.typing', self.js)

    def test_hybrid_autosave_and_lifecycle_flushes_exist(self):
        self.assertIn("const IDLE_SAVE_MS = 1200", self.js)
        self.assertIn("const MAX_SAVE_MS = 5000", self.js)
        self.assertIn('document.addEventListener("visibilitychange"', self.js)
        self.assertIn('editor.addEventListener("blur"', self.js)

    def test_visual_viewport_drives_editor_height(self):
        self.assertIn("window.visualViewport", self.js)
        self.assertIn("--visual-height", self.js)
        self.assertIn("var(--visual-height, 100dvh)", self.css)

    def test_editor_uses_blue_native_selection_colour(self):
        self.assertIn("caret-color: var(--system-blue)", self.css)
        self.assertIn("#editor::selection", self.css)

    def test_no_desktop_frame_border(self):
        self.assertNotIn("border-left: 1px solid var(--line)", self.css)
        self.assertNotIn("border-right: 1px solid var(--line)", self.css)

    def test_light_mode_follows_os(self):
        self.assertIn("@media (prefers-color-scheme: light)", self.css)
        self.assertIn('media="(prefers-color-scheme: light)"', self.html)
        self.assertIn('media="(prefers-color-scheme: dark)"', self.html)

    def test_landscape_keyboard_hides_editor_bar(self):
        self.assertIn('classList.toggle("landscape-keyboard"', self.js)
        self.assertIn("body.landscape-keyboard .editor-bar", self.css)

    def test_note_dates_do_not_repeat_sort_mode(self):
        self.assertNotIn('const dateLabel = settings.sort', self.js)
        self.assertNotIn('`${dateLabel} ${formatDate(note[dateField])}`', self.js)

    def test_org_mode_is_explicit_and_per_note(self):
        self.assertIn('id="org-toggle"', self.html)
        self.assertIn('activeNote.syntax === "org"', self.js)
        self.assertIn('syntax: note.syntax === "org" ? "org" : "plain"', self.js)

    def test_org_editor_has_highlight_mirror_and_transient_reader(self):
        self.assertIn('id="editor-highlight"', self.html)
        self.assertIn('id="reader"', self.html)
        self.assertIn('id="reader-button"', self.html)
        self.assertIn('function renderOrgDocument', self.js)
        self.assertIn('function highlightOrgSource', self.js)
        self.assertIn('readerMode = false', self.js)

    def test_org_share_extension_follows_note_mode(self):
        self.assertIn('const extension = syntax === "org" ? "org" : "txt"', self.js)
        self.assertIn('safeFilename(activeNote.text, activeNote.syntax)', self.js)

    def test_org_reader_is_safe_and_noninteractive(self):
        self.assertIn('function escapeHtml', self.js)
        self.assertIn('safeLinkHref', self.js)
        self.assertNotIn('type="checkbox"', self.js)

    def test_org_title_keyword_names_note_and_export(self):
        self.assertIn('const orgTitle = text.match(/^#\\+title:\\s*(.+)$/im)', self.js)
        self.assertIn('if (orgTitle) return orgTitle[1].trim()', self.js)

    def test_org_renderer_protects_every_generated_inline_fragment(self):
        start = self.js.index("function renderOrgInline")
        end = self.js.index("function highlightOrgInline", start)
        renderer = self.js[start:end]
        self.assertIn("protect(`<${tag}>${content}</${tag}>`)", renderer)

    def test_org_highlighter_protects_generated_markup(self):
        start = self.js.index("function highlightOrgInline")
        end = self.js.index("function highlightOrgSource", start)
        highlighter = self.js[start:end]
        self.assertIn("const protectedParts", highlighter)
        self.assertIn("const protect", highlighter)

    def test_service_worker_cache_is_advanced(self):
        sw = (ROOT / "scratch" / "sw.js").read_text()
        self.assertIn('scratch-shell-v14', sw)
        for filename in ('U.woff2', 'U-Black.woff2', 'U-ExtraBlackExt.woff2'):
            self.assertIn(f'fonts/{filename}', sw)


if __name__ == "__main__":
    unittest.main()
