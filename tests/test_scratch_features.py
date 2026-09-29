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
        self.assertIn('scratch-shell-v12', sw)


if __name__ == "__main__":
    unittest.main()
