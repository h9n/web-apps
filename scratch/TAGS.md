# Scratch tag metadata (shell v24)

The `#` toolbar button opens a small panel. Tag names search the existing Notes search box; Edit replaces a tag and × removes it. New tags can be entered with or without `#`, separated by whitespace. Suggestions come from live note text, including inline tags. Apply/Enter finishes the current entry; Done, Notes, tag navigation, export, import and sync also finish valid pending input. Valid input participates in ordinary autosave before Apply. An incomplete `#` or invalid tag is not metadata: explicit navigation is blocked until corrected/cleared, while body autosave continues with the last valid tags.

## Canonical text boundaries

- Only the **final nonblank line**, when entirely made of hashtags, is hidden metadata. Tokens accept Unicode letters, combining marks, numbers, `_` and `-` after `#`.
- Existing metadata may follow a single newline or a blank separator. Only the final line is recognized; earlier hashtag-only lines and prose hashtags remain in the body, without relocation.
- A hashtag-only note has an empty visible body. An empty or whitespace-only note has no tags. Existing empty/whitespace-only notes survive unchanged open/close; only a genuinely empty newly-created draft is discarded.
- New/changed tags serialize as one space-separated final line, after a blank separator when the body is nonempty. Existing body trailing blank lines are reused, never stripped.
- Unchanged body and tag values return the **original string**, not a normalized reconstruction. Opening, Read/Edit, and closing do not manufacture revisions.
- Body-only edits reuse the original metadata suffix. An untouched CRLF body remains byte-exact when tags change, despite textarea newline normalization. Tag edits preserve the original metadata's trailing newlines; changed tag whitespace is normalized. Removing every metadata tag returns the body, removing the metadata separator/suffix rather than adding a dangling blank tag line.
- Plain and Org rendering consume the visible body. Literal inline hashtags stay visible; existing safely rendered Read-mode links remain available.

## Persistence and concurrency

There is no tag database, note field, IndexedDB migration, server change or backup format change. `activeNote.text` always contains canonical body-plus-tags. Body and valid pending panel edits create one note snapshot through the existing causal-revision/autosave/mutation queue, not independently queued fields. Navigation locks both the native textarea and panel fieldset synchronously before awaiting that queue, including completion controls. Failures retain the draft and unlock controls for retry. Successful import/sync reloads the split editor draft from merged canonical source.

The v23 editor mirror, pointer hit-testing, mirror scroll/typography synchronization and Tag links on/off controls are removed. Native textarea selection, typing and undo are not replaced. The Org syntax highlight is unrelated and remains.

## Local verification

```sh
node --test scratch/tests/*.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
uv run --with playwright python tests/tag-panel-browser.py
uv run --with playwright python tests/followup-browser.py
uv run --with playwright python tests/tags-browser.py
uv run --with playwright python tests/colours-browser.py
uv run --with playwright python tests/neon-browser.py
```

The Python browser suites run isolated Chromium and WebKit profiles. The panel suite also downloads and imports a real version-3 backup into a fresh context and compares all note fields before/after reload. `colours-browser.py` installs pinned v23 (`96f937b`), upgrades at the same origin, compares exact existing note/revision objects, then cuts the network and exercises new tag-panel actions and never-selected neon playback. Existing concurrency, conflict, compatibility, reminder, viewport, timeout, sync and real HTTPS Stash integration suites remain applicable; the sync suite now exercises actual panel-tag propagation between clients.

Screenshots and disposable test backups belong under `~/.hermes/cache/scratch`, never in user note storage. Desktop WebKit is not physical-iPhone keyboard or installed Home Screen verification. No publication is authorized by these local changes.
