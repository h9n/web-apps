# Web Apps

Small, dependency-free web applications hosted at `apps.octofi.sh`.

## Applications

- [`/scratch/`](scratch/) — a local-first plain-text notebook with installable offline support, configurable typography and typing assistance, native sharing, sorting, search, JSON backup, and optional Stash backup/manual sync. Notes live in IndexedDB. They are sent only to the Stash address you explicitly configure, never committed to this repository.

## Structure

Each application lives in its own directory and uses relative URLs so it can be developed locally and published under the same path.

## Local preview

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/`.

## Scratch: deliberately small conventions

- Tap the shaded backdrop to close Writing or Data. Settings apply immediately.
- Swipe a note left to reveal Delete. Undo is offered for ten seconds. Data → Deleted notes retains recoverable copies; restore creates a fresh note ID and keeps the deletion history.
- Tags are ordinary text: write `#ideas` anywhere and search for `#ideas`. There is no separate tag database.
- Stash device names are labels. Each browser installation has an independent stable device UUID, excluded from portable settings. Renaming a device does not change its identity.
- Automatic uploads remain backups only. **Sync now** first archives local state, downloads each other device's latest backup, merges locally in one IndexedDB transaction, then uploads the merged snapshot. Settings and endpoint configuration are not synced. Devices exchange changes only when they upload/sync; this is not real-time collaboration.
- Revisions track ancestry, not clock-based winners. Independent edits are retained separately and labelled Conflict. Deletions win for that ID, with recoverable content retained in deletion records. Tombstones are never automatically pruned. Historical Stash archives remain independent of the latest sync snapshots.
- Backups now use version 3 (notes, revision metadata, permanent deletion records, source-device label, writing settings). Keep older devices updated before relying on deletion sync: old versions neither record deletions nor understand revisions. Older backups can still be read conservatively; ambiguous edits must not silently overwrite local text.
- Imports and manual sync share a serial queue, including file reading and local commit. Repeated imports wait rather than discarding an in-flight backup. Stash's 12-second request deadline includes reading the response body; timed-out operations can be retried.
- Stash needs `GET /v1/scratch/devices`, returning `{app:"scratch",devices:[{device:"…",types:["backup"]}]}`, plus its existing upload and latest-backup endpoints. An older server still supports backup but cannot discover peers for sync.

## Verification

```sh
python3 -m unittest discover -s tests -v
node --test scratch/tests/sync.test.cjs
# With a local preview running on port 8788 and Playwright available:
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/browser.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/sync-browser.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/compatibility-browser.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/concurrency-browser.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/timeout-browser.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright python3 tests/integration.py /path/to/stash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright python3 tests/upgrade.py
```

Browser tests use isolated storage and synthetic notes, not real browser profiles or personal backups. `SCRATCH_TEST_URL` overrides the local preview address. Set `BROWSER=webkit` to exercise WebKit. The routed sync fixture blocks service workers so its network interception is effective; real HTTPS integration leaves them enabled.
