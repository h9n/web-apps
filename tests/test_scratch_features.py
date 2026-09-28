import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ScratchFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "scratch" / "index.html").read_text()
        cls.css = (ROOT / "scratch" / "styles.css").read_text()
        cls.js = (ROOT / "scratch" / "app.js").read_text()

    def test_editor_controls_exist(self):
        self.assertIn('data-value="xsmall"', self.html)
        self.assertIn('id="typing-toggle"', self.html)
        self.assertIn('id="share-button"', self.html)

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


if __name__ == "__main__":
    unittest.main()
