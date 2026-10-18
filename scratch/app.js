"use strict";

const DB_NAME = "scratch-notes";
const DB_VERSION = 2;
const NOTES_STORE = "notes";
const DELETIONS_STORE = "deletions";
const DEVICE_KEY = "scratch-device-id-v1";
const deviceId = localStorage.getItem(DEVICE_KEY) || makeId();
localStorage.setItem(DEVICE_KEY, deviceId);
const SETTINGS_KEY = "scratch-settings-v1";
const STASH_KEY = "scratch-stash-v1";
const IDLE_SAVE_MS = 1200;
const MAX_SAVE_MS = 5000;
const STASH_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STASH_BACKUP_DELAY_MS = 30 * 1000;
const STASH_FETCH_TIMEOUT_MS = 12000;
const DEFAULT_SETTINGS = {
  size: "large",
  font: "sans",
  wrap: true,
  typing: true,
  sort: "modified"
};

const $ = selector => document.querySelector(selector);
const listView = $("#list-view");
const editorView = $("#editor-view");
const notesList = $("#notes-list");
const noteSearch = $("#note-search");
const searchButton = $("#search-button");
const searchControls = $("#search-controls");
const listControls = $("#list-controls");
const emptyState = $("#empty-state");
const emptyMessage = $("#empty-message");
const editor = $("#editor");
const editorHighlight = $("#editor-highlight");
const editorStage = $("#editor-stage");
const reader = $("#reader");
const readerButton = $("#reader-button");
const saveStatus = $("#save-status");
const settingsDialog = $("#settings-dialog");
const dataDialog = $("#data-dialog");
const wrapToggle = $("#wrap-toggle");
const typingToggle = $("#typing-toggle");
const orgToggle = $("#org-toggle");
const storageStatus = $("#storage-status");
const importInput = $("#import-input");
const stashStatus = $("#stash-status");
const stashUrlInput = $("#stash-url");
const stashDeviceInput = $("#stash-device");
const stashSaveButton = $("#stash-save-button");
const stashBackupButton = $("#stash-backup-button");

let db;
let notes = [];
let tombstones = [];
let undoNote = null;
let undoTimer = null;
let activeNote = null;
let dirty = false;
let editRevision = 0;
let idleSaveTimer = null;
let maxSaveTimer = null;
let readerMode = false;
let settings = loadSettings();
let stashConfig = loadStashConfig();
let stashBackupTimer = null;
let stashBackupRunning = false;
let stashSyncRunning = false;
let saveInFlight = null;
let sealedRevision = null;
let conflictsOnly = false;
let conflictSession = null;
let conflictResolving = false;
const viewportBaselines = { portrait: 0, landscape: 0 };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function loadStashConfig() {
  const defaults = { enabled: false, baseUrl: "", device: "", lastSuccess: 0, lastHash: "", lastError: "" };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STASH_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function saveStashConfig() {
  localStorage.setItem(STASH_KEY, JSON.stringify(stashConfig));
}

function applySettings() {
  document.body.classList.toggle("size-small", settings.size === "small");
  document.body.classList.toggle("size-xsmall", settings.size === "xsmall");
  document.body.classList.toggle("font-mono", settings.font === "mono");
  for (const face of ["univers", "univers-black", "univers-extended"]) {
    document.body.classList.toggle(`font-${face}`, settings.font === face);
  }
  document.body.classList.toggle("no-wrap", !settings.wrap);
  wrapToggle.checked = settings.wrap;
  typingToggle.checked = settings.typing;
  editor.setAttribute("autocorrect", settings.typing ? "on" : "off");
  editor.setAttribute("autocapitalize", settings.typing ? "sentences" : "none");
  editor.spellcheck = settings.typing;
  notesList.setAttribute("aria-label", `Notes, newest by ${settings.sort}`);
  document.querySelectorAll("[data-setting]").forEach(button => {
    button.classList.toggle("active", settings[button.dataset.setting] === button.dataset.value);
  });
}

function syncOrgPresentation() {
  const orgEnabled = activeNote?.syntax === "org";
  orgToggle.checked = orgEnabled;
  readerButton.hidden = !orgEnabled;
  if (!orgEnabled) readerMode = false;
  readerButton.textContent = readerMode ? "Edit" : "Read";
  editorStage.hidden = readerMode;
  reader.hidden = !readerMode;
  document.body.classList.toggle("org-editing", orgEnabled && !readerMode);
  if (orgEnabled) editorHighlight.innerHTML = highlightOrgSource(editor.value);
  else editorHighlight.textContent = "";
  if (readerMode) reader.innerHTML = renderOrgDocument(editor.value);
}

function syncHighlightScroll() {
  editorHighlight.scrollTop = editor.scrollTop;
  editorHighlight.scrollLeft = editor.scrollLeft;
}

function setOrgSyntax(enabled) {
  if (!activeNote) return;
  readerMode = false;
  activeNote.syntax = enabled ? "org" : "plain";
  activeNote.updatedAt = Date.now();
  markNoteRevision();
  dirty = true;
  editRevision += 1;
  saveStatus.textContent = "Unsaved";
  syncOrgPresentation();
  scheduleSave();
}

async function toggleReaderMode() {
  if (activeNote?.syntax !== "org") return;
  if (!readerMode) {
    await flushSave();
    reader.innerHTML = renderOrgDocument(editor.value);
    reader.scrollTop = editor.scrollTop;
    readerMode = true;
    editor.blur();
  } else {
    readerMode = false;
  }
  syncOrgPresentation();
  if (!readerMode) requestAnimationFrame(() => editor.focus());
}

function updateSetting(key, value) {
  settings[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applySettings();
  if (key === "sort") {
    sortNotes();
    renderNotes();
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(NOTES_STORE)) {
        const store = database.createObjectStore(NOTES_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains(DELETIONS_STORE)) database.createObjectStore(DELETIONS_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, operation, storeName = NOTES_STORE) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function loadNotes() {
  tombstones = await transact("readonly", store => store.getAll(), DELETIONS_STORE) || [];
  notes = await transact("readonly", store => store.getAll()) || [];
  notes = notes.map(note => ScratchSync.normalizeNote({ ...note, syntax: note.syntax === "org" ? "org" : "plain" }));
  sortNotes();
  renderNotes();
}

function sortNotes() {
  const field = settings.sort === "created" ? "createdAt" : "updatedAt";
  notes.sort((a, b) => b[field] - a[field]);
}

function noteHeading(text) {
  const orgTitle = text.match(/^#\+title:\s*(.+)$/im);
  if (orgTitle) return orgTitle[1].trim();
  const first = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "Untitled";
  return first.replace(/^\*+\s+/, "");
}

function notePreview(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.slice(1).join(" ") || "No additional text";
}

function safeFilename(text, syntax = "plain") {
  const cleaned = noteHeading(text)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const extension = syntax === "org" ? "org" : "txt";
  return `${cleaned || "Untitled"}.${extension}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function safeLinkHref(value) {
  try {
    const url = new URL(value, location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function renderOrgInline(value) {
  let text = escapeHtml(value);
  const protectedParts = [];
  const protect = html => `\u0000${protectedParts.push(html) - 1}\u0000`;
  text = text.replace(/\[\[([^\]]+)\](?:\[([^\]]+)\])?\]/g, (_, target, label) => {
    const href = safeLinkHref(target);
    const caption = escapeHtml(label || target);
    return protect(href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${caption}</a>` : caption);
  });
  text = text.replace(/([~=])([^\n]+?)\1/g, (_, marker, content) => protect(`<code>${content}</code>`));
  const styles = [
    [/\*([^*\n]+)\*/g, "strong"],
    [/\/([^/\n]+)\//g, "em"],
    [/_([^_\n]+)_/g, "u"],
    [/\+([^+\n]+)\+/g, "del"]
  ];
  for (const [pattern, tag] of styles) {
    text = text.replace(pattern, (_, content) => protect(`<${tag}>${content}</${tag}>`));
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}

function highlightOrgInline(value) {
  let text = escapeHtml(value);
  const protectedParts = [];
  const protect = html => `\u0000${protectedParts.push(html) - 1}\u0000`;
  text = text.replace(/\[\[([^\]]+)\](?:\[([^\]]+)\])?\]/g, (_, target, label) => {
    const visible = label ? `[[${target}][${label}]]` : `[[${target}]]`;
    return protect(`<span class="org-link">${visible}</span>`);
  });
  text = text.replace(/([~=])([^\n]+?)\1/g, (_, marker, content) => protect(`<span class="org-code">${marker}${content}${marker}</span>`));
  text = text.replace(/([*\/_+])([^\n]+?)\1/g, '<span class="org-marker">$1</span>$2<span class="org-marker">$1</span>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}

function highlightOrgSource(text) {
  return text.split("\n").map(line => {
    if (/^\s*#(?!\+)/.test(line)) return `<span class="org-comment">${escapeHtml(line)}</span>`;
    if (/^#\+/.test(line)) return `<span class="org-meta">${escapeHtml(line)}</span>`;
    const heading = line.match(/^(\*+\s+)(.*)$/);
    if (heading) return `<span class="org-heading">${escapeHtml(heading[1])}${highlightOrgInline(heading[2])}</span>`;
    const list = line.match(/^(\s*(?:[-+] |\d+[.)] ))(.*)$/);
    if (list) return `<span class="org-marker">${escapeHtml(list[1])}</span>${highlightOrgInline(list[2])}`;
    return highlightOrgInline(line);
  }).join("\n") + "\n";
}

function renderOrgDocument(text) {
  const output = [];
  const lines = text.split(/\r?\n/);
  let paragraph = [];
  let listType = null;
  let block = null;
  let blockLines = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${renderOrgInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  for (const line of lines) {
    if (block) {
      if (new RegExp(`^#\\+end_${block}$`, "i").test(line)) {
        const content = escapeHtml(blockLines.join("\n"));
        output.push(block === "quote" ? `<blockquote>${renderOrgInline(blockLines.join(" "))}</blockquote>` : `<pre><code>${content}</code></pre>`);
        block = null; blockLines = [];
      } else blockLines.push(line);
      continue;
    }
    const blockStart = line.match(/^#\+begin_(src|example|quote)\b/i);
    if (blockStart) { flushParagraph(); closeList(); block = blockStart[1].toLowerCase(); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^(\*{1,})\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(heading[1].length, 6);
      output.push(`<h${level}>${renderOrgInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^-{5,}\s*$/.test(line)) { flushParagraph(); closeList(); output.push("<hr>"); continue; }
    const keyword = line.match(/^#\+([a-z_]+):\s*(.*)$/i);
    if (keyword) {
      flushParagraph(); closeList();
      output.push(keyword[1].toLowerCase() === "title" ? `<h1>${renderOrgInline(keyword[2])}</h1>` : `<p class="org-keyword">${escapeHtml(line)}</p>`);
      continue;
    }
    if (/^\s*#(?!\+)/.test(line)) continue;
    const item = line.match(/^\s*(?:(-)|(?:\d+[.)]))\s+(?:\[([ Xx-])\]\s+)?(.*)$/);
    if (item) {
      flushParagraph();
      const wanted = item[1] ? "ul" : "ol";
      if (listType !== wanted) { closeList(); output.push(`<${wanted}>`); listType = wanted; }
      const checkbox = item[2] == null ? "" : `<span class="org-checkbox">[${item[2]}]</span> `;
      output.push(`<li>${checkbox}${renderOrgInline(item[3])}</li>`);
      continue;
    }
    closeList(); paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (block) output.push(`<pre><code>${escapeHtml(blockLines.join("\n"))}</code></pre>`);
  return output.join("\n");
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function setSearchOpen(open) {
  // A cached HTML shell can briefly run against newer JavaScript during a PWA update.
  if (!searchButton || !searchControls || !listControls) return;
  searchControls.hidden = !open;
  listControls.classList.toggle("searching", open);
  searchButton.setAttribute("aria-expanded", String(open));
  if (open) {
    noteSearch.focus();
  } else {
    noteSearch.value = "";
    noteSearch.blur();
    renderNotes();
  }
}

function renderNotes() {
  notesList.replaceChildren();
  const query = noteSearch.value.trim().toLocaleLowerCase();
  const roots = currentConflictGroups();
  if (!roots.size) conflictsOnly = false;
  renderConflictIndicators(roots);
  const candidates = conflictsOnly ? notes.filter(note => roots.has(note.conflictOf || note.id)) : notes;
  const visibleNotes = query ? candidates.filter(note => note.text.toLocaleLowerCase().includes(query)) : candidates;
  emptyState.hidden = visibleNotes.length !== 0;
  notesList.hidden = visibleNotes.length === 0;
  emptyMessage.textContent = notes.length && query ? "No matching notes." : "Nothing here.";
  $("#empty-new-button").hidden = notes.length > 0;
  const dateField = settings.sort === "created" ? "createdAt" : "updatedAt";

  for (const note of visibleNotes) {
    const row = document.createElement("li");
    row.className = "note-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-button";
    button.dataset.id = note.id;

    const title = document.createElement("span");
    title.className = "note-title";
    title.textContent = `${note.conflictOf ? "Conflict · " : ""}${noteHeading(note.text)}`;

    const meta = document.createElement("span");
    meta.className = "note-meta";
    const date = document.createElement("span");
    date.className = "note-date";
    date.textContent = formatDate(note[dateField]);
    const preview = document.createElement("span");
    preview.className = "note-preview";
    preview.textContent = notePreview(note.text);
    meta.append(date, preview);
    button.append(title, meta);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "swipe-delete";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${noteHeading(note.text)}`);
    deleteButton.addEventListener("click", () => removeNote(note.id, false));
    row.append(deleteButton, button);
    wireNoteSwipe(row, button);
    notesList.append(row);
  }
}

function currentConflictGroups() {
  const groups = new Map();
  for (const note of notes) {
    const root = note.conflictOf || note.id;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(note);
  }
  for (const [root, versions] of groups) if (versions.length < 2) groups.delete(root);
  return groups;
}

function renderConflictIndicators(groups = currentConflictGroups()) {
  const count = groups.size;
  const banner = $("#conflict-summary");
  if (banner) banner.hidden = count === 0;
  if ($("#conflict-count")) $("#conflict-count").textContent = `${count} note${count === 1 ? " has" : "s have"} conflicting versions`;
  if ($("#review-conflicts-button")) $("#review-conflicts-button").textContent = conflictsOnly ? "Show all notes" : "Show conflicts";
  const dataButton = $("#show-conflicts-button");
  if (dataButton) { dataButton.hidden = count === 0; dataButton.textContent = `Show conflicts (${count})`; }
}

async function showConflicts() {
  if (!editorView.hidden) await closeEditor();
  if (dataDialog.open) dataDialog.close();
  conflictsOnly = true;
  noteSearch.value = "";
  renderNotes();
}

function openConflictReview(id, preserveDraft = false) {
  const note = notes.find(item => item.id === id);
  const rootId = note?.conflictOf || note?.id || id;
  const versions = currentConflictGroups().get(rootId);
  if (!versions) {
    $("#conflict-status").textContent = "These versions are no longer available. Any combined text is still here; copy it before closing.";
    return;
  }
  const prior = preserveDraft ? conflictSession : null;
  conflictSession = {
    rootId,
    versions: structuredClone(versions),
    reviewedRevisions: versions.map(item => item.revision),
    selectedRevision: versions.some(item => item.revision === prior?.selectedRevision) ? prior.selectedRevision : versions[0].revision,
    baseText: prior?.baseText ?? null,
    syntax: prior?.syntax ?? versions[0].syntax
  };
  const container = $("#conflict-versions");
  container.replaceChildren();
  versions.forEach((version, index) => {
    const section = document.createElement("section"); section.className = "conflict-version";
    const heading = document.createElement("h3"); heading.textContent = `Version ${index + 1} · ${noteHeading(version.text)}`;
    const meta = document.createElement("small");
    meta.textContent = `${version.deviceId === deviceId ? "This device" : version.deviceId ? "Another device" : "Earlier backup"} · ${new Date(version.updatedAt).toLocaleString()}${version.syntax === "org" ? " · Org" : ""}`;
    const content = document.createElement("pre"); content.textContent = version.text || "Empty note";
    const actions = document.createElement("div"); actions.className = "conflict-actions";
    const use = document.createElement("button"); use.type = "button"; use.className = "wide-button"; use.textContent = "Use this version";
    use.addEventListener("click", () => resolveReviewedConflict("use", version.revision));
    const combine = document.createElement("button"); combine.type = "button"; combine.className = "wide-button"; combine.textContent = "Combine manually";
    combine.addEventListener("click", () => beginConflictCombination(version.revision));
    actions.append(use, combine); section.append(heading, meta, content, actions); container.append(section);
  });
  if (!preserveDraft) { $("#conflict-combination").hidden = true; $("#conflict-draft").value = ""; }
  $("#conflict-keep-both").textContent = versions.length === 2 ? "Keep both as separate notes" : "Keep all as separate notes";
  $("#conflict-status").textContent = preserveDraft ? "Versions refreshed. Review them before choosing; your combined text has been kept." : "";
  $("#conflict-review-latest").hidden = true;
  if (!$("#conflict-dialog").open) $("#conflict-dialog").showModal();
}

function conflictDraftChanged() {
  return Boolean(conflictSession && conflictSession.baseText !== null && !$("#conflict-combination").hidden && $("#conflict-draft").value !== conflictSession.baseText);
}

function closeConflictReview() {
  if (conflictResolving) return;
  if (conflictDraftChanged() && !confirm("Discard your unsaved combined text? The original versions will be kept.")) return;
  $("#conflict-dialog").close(); conflictSession = null;
}

function beginConflictCombination(revision) {
  const source = conflictSession?.versions.find(note => note.revision === revision);
  if (!source) return;
  if (conflictDraftChanged() && !confirm("Replace your combined text with this version?")) return;
  conflictSession.selectedRevision = revision;
  conflictSession.baseText = source.text;
  conflictSession.syntax = source.syntax;
  $("#conflict-draft").value = source.text;
  $("#conflict-combination").hidden = false;
  $("#conflict-draft").focus();
}

async function resolveReviewedConflict(mode, selectedRevision = conflictSession?.selectedRevision) {
  if (!conflictSession || conflictResolving) return;
  if (mode !== "combine" && conflictDraftChanged() && !confirm("Use this choice instead of your unsaved combined text?")) return;
  const options = {
    rootId: conflictSession.rootId,
    reviewedRevisions: [...conflictSession.reviewedRevisions],
    mode, selectedRevision, deviceId, now: Date.now(),
    ...(mode === "combine" ? { text: $("#conflict-draft").value, syntax: conflictSession.syntax } : {})
  };
  conflictResolving = true;
  $("#conflict-draft").readOnly = true;
  $("#conflict-dialog").querySelectorAll("button").forEach(button => { button.disabled = true; });
  $("#conflict-status").textContent = "Saving your choice…";
  try {
    await queueLocalMutation(async () => {
      await flushSaveInternal();
      const resolved = ScratchSync.resolveConflict({ notes, tombstones }, options);
      await commitMergedSnapshot([resolved]);
    });
    $("#conflict-dialog").close(); conflictSession = null;
    scheduleStashBackup(1000);
    $("#sync-status").textContent = "Conflict resolved locally. Sync now to exchange your choice with other devices.";
  } catch (error) {
    $("#conflict-status").textContent = `${error.message} Your original versions and any combined text are still available.`;
    $("#conflict-review-latest").hidden = false;
  } finally {
    conflictResolving = false;
    $("#conflict-draft").readOnly = false;
    $("#conflict-dialog").querySelectorAll("button").forEach(button => { button.disabled = false; });
  }
}

function wireNoteSwipe(row, button) {
  let start = null;
  let moved = false;
  button.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    moved = false;
  });
  button.addEventListener("pointermove", event => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { start = null; return; }
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      moved = true;
      button.setPointerCapture(event.pointerId);
      notesList.querySelectorAll(".swiped").forEach(other => { if (other !== row) other.classList.remove("swiped"); });
      row.classList.toggle("swiped", dx < 0);
    }
  });
  button.addEventListener("pointerup", () => { start = null; });
  button.addEventListener("pointercancel", () => { start = null; moved = false; });
  button.addEventListener("click", event => {
    if (moved || row.classList.contains("swiped")) {
      event.preventDefault(); event.stopPropagation();
      if (!moved) row.classList.remove("swiped");
      moved = false;
    }
  });
}

function showDeleteUndo(note) {
  undoNote = { ...note };
  $("#delete-notice").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { $("#delete-notice").hidden = true; undoNote = null; }, 10000);
}

function restoreDeletedNote(note) {
  return queueLocalMutation(() => commitRestoredNote(note));
}

async function commitRestoredNote(note) {
  const now = Date.now();
  const restored = ScratchSync.normalizeNote({ id: makeId(), text: note.text, syntax: note.syntax, createdAt: now, updatedAt: now });
  await transact("readwrite", store => store.put(restored));
  notes.push(restored);
  conflictsOnly = false;
  noteSearch.value = "";
  sortNotes(); renderNotes();
  scheduleStashBackup();
  return restored;
}

function makeId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createNote() {
  return queueLocalMutation(commitCreatedNote);
}

async function commitCreatedNote() {
  await flushSaveInternal();
  const now = Date.now();
  const note = ScratchSync.normalizeNote({ id: makeId(), text: "", syntax: "plain", createdAt: now, updatedAt: now });
  await transact("readwrite", store => store.put(note));
  notes.unshift(note);
  conflictsOnly = false;
  noteSearch.value = "";
  openNote(note.id);
}

function openNote(id) {
  activeNote = notes.find(note => note.id === id) || null;
  if (!activeNote) return;
  clearSaveTimers();
  dirty = false;
  editRevision += 1;
  readerMode = false;
  activeNote.syntax = activeNote.syntax === "org" ? "org" : "plain";
  editor.value = activeNote.text;
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  listView.hidden = true;
  editorView.hidden = false;
  saveStatus.textContent = "Saved";
  syncOrgPresentation();
  history.pushState({ noteId: id }, "", `#${encodeURIComponent(id)}`);
  syncVisualViewport();
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
}

async function closeEditor({ fromHistory = false } = {}) {
  await flushSave();
  if (activeNote && !activeNote.text.trim()) await removeNote(activeNote.id, false);
  activeNote = null;
  readerMode = false;
  document.body.classList.remove("org-editing");
  editorView.hidden = true;
  listView.hidden = false;
  sortNotes();
  renderNotes();
  if (!fromHistory && location.hash) history.pushState({}, "", location.pathname + location.search);
}

function clearSaveTimers() {
  clearTimeout(idleSaveTimer);
  clearTimeout(maxSaveTimer);
  idleSaveTimer = null;
  maxSaveTimer = null;
}

function scheduleSave() {
  clearTimeout(idleSaveTimer);
  idleSaveTimer = setTimeout(() => saveActiveNote(), IDLE_SAVE_MS);
  if (!maxSaveTimer) maxSaveTimer = setTimeout(() => saveActiveNote(), MAX_SAVE_MS);
}

function markNoteRevision() {
  // One causal revision per saved batch, not one ancestor for every keystroke.
  if (!dirty || activeNote.revision === sealedRevision) activeNote = ScratchSync.editNote(activeNote, deviceId);
}

function queueSave() {
  if (!activeNote) return;
  activeNote.text = editor.value;
  activeNote.updatedAt = Date.now();
  markNoteRevision();
  if (activeNote.syntax === "org") {
    editorHighlight.innerHTML = highlightOrgSource(editor.value);
    syncHighlightScroll();
  }
  dirty = true;
  editRevision += 1;
  saveStatus.textContent = "Unsaved";
  scheduleSave();
}

function saveActiveNote() {
  return queueLocalMutation(saveActiveNoteInternal);
}

async function saveActiveNoteInternal() {
  if (saveInFlight) await saveInFlight;
  clearSaveTimers();
  if (!activeNote || !dirty || !db) return;
  const revisionBeingSaved = editRevision;
  const note = { ...activeNote };
  sealedRevision = note.revision;
  saveStatus.textContent = "Saving…";
  try {
    saveInFlight = transact("readwrite", store => store.put(note));
    await saveInFlight;
    const index = notes.findIndex(item => item.id === note.id);
    if (index >= 0) notes[index] = note;
    if (revisionBeingSaved === editRevision) {
      dirty = false;
      saveStatus.textContent = "Saved";
      scheduleStashBackup();
    } else {
      saveStatus.textContent = "Unsaved";
      scheduleSave();
    }
  } catch (error) {
    console.error("Could not save note", error);
    saveStatus.textContent = "Save failed";
    dirty = true;
  } finally {
    saveInFlight = null;
  }
}

function flushSave() {
  return queueLocalMutation(flushSaveInternal);
}

async function flushSaveInternal() {
  if (saveInFlight) await saveInFlight;
  if (dirty) await saveActiveNoteInternal();
  if (dirty) throw new Error("Local save failed. No sync or export was performed.");
}

function removeNote(id, ask = true) {
  return queueLocalMutation(() => commitRemovedNote(id, ask));
}

async function commitRemovedNote(id, ask) {
  await flushSaveInternal();
  const note = notes.find(item => item.id === id);
  if (!note) return;
  if (ask && !confirm(`Delete “${noteHeading(note.text)}”?`)) return;
  if (activeNote?.id === id) { clearSaveTimers(); dirty = false; }
  const deletion = { id, deletedAt: Date.now(), deviceId, deviceName: stashConfig.device || "This device", note: { ...note } };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([NOTES_STORE, DELETIONS_STORE], "readwrite");
    transaction.objectStore(NOTES_STORE).delete(id);
    transaction.objectStore(DELETIONS_STORE).put(deletion);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  tombstones = [...tombstones.filter(item => item.id !== id), deletion];
  notes = notes.filter(item => item.id !== id);
  if (ask || note.text.trim()) showDeleteUndo(note);
  scheduleStashBackup();
  if (activeNote?.id === id) {
    activeNote = null;
    editorView.hidden = true;
    listView.hidden = false;
    history.pushState({}, "", location.pathname + location.search);
  }
  renderNotes();
}

async function shareActiveNote() {
  if (!activeNote) return;
  await flushSave();
  const title = noteHeading(activeNote.text);
  const file = new File([activeNote.text], safeFilename(activeNote.text, activeNote.syntax), { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title, text: activeNote.text });
      return;
    }
    await navigator.clipboard.writeText(activeNote.text);
    saveStatus.textContent = "Copied";
    setTimeout(() => { if (!dirty) saveStatus.textContent = "Saved"; }, 1200);
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("Could not share note", error);
      alert("This browser could not open the share sheet or copy the note.");
    }
  }
}

function makeBackupPayload() {
  return {
    format: "scratch-backup",
    version: 3,
    exportedAt: new Date().toISOString(),
    notes,
    tombstones,
    sourceDevice: { id: deviceId, name: stashConfig.device || "This device" },
    settings
  };
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function normalizeStashUrl(value) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("Stash must use an HTTPS address.");
  if (url.username || url.password) throw new Error("Do not put credentials in the Stash address.");
  return url.href.replace(/\/+$/, "");
}

function validStashDevice(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function stashObjectUrl() {
  return `${stashConfig.baseUrl}/v1/scratch/${encodeURIComponent(deviceId)}/backup`;
}

async function fetchWithTimeout(url, options = {}, responseType = "json", timeoutMs = STASH_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // Keep the abort deadline alive through body consumption, not only headers.
    const data = response.ok ? await response[responseType]() : null;
    if (!response.ok) await response.body?.cancel();
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Stash did not respond within ${timeoutMs / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderStashStatus() {
  stashUrlInput.value = stashConfig.baseUrl;
  stashDeviceInput.value = stashConfig.device;
  stashBackupButton.disabled = !stashConfig.enabled || stashBackupRunning || stashSyncRunning;
  if ($("#stash-sync-button")) $("#stash-sync-button").disabled = !stashConfig.enabled || stashBackupRunning || stashSyncRunning;
  stashSaveButton.disabled = stashBackupRunning || stashSyncRunning;
  if (!stashConfig.enabled) {
    stashStatus.textContent = "Not configured. Backups remain local until Stash is set up.";
  } else if (stashBackupRunning) {
    stashStatus.textContent = `Backing up ${notes.length} note${notes.length === 1 ? "" : "s"} as ${stashConfig.device}…`;
  } else if (stashConfig.lastError) {
    stashStatus.textContent = `Notes remain local. Backup pending: ${stashConfig.lastError} Check Tailscale and retry. In Safari, try View → Reload and Show IP Address.`;
  } else if (stashConfig.lastSuccess) {
    stashStatus.textContent = `Last backed up ${formatDate(stashConfig.lastSuccess)} as ${stashConfig.device}.`;
  } else {
    stashStatus.textContent = `Connected as ${stashConfig.device}. No backup uploaded yet.`;
  }
}

async function testAndSaveStash() {
  stashSaveButton.disabled = true;
  stashStatus.textContent = "Testing Stash…";
  let configured = false;
  try {
    const baseUrl = normalizeStashUrl(stashUrlInput.value);
    const device = stashDeviceInput.value.trim();
    if (!validStashDevice(device)) throw new Error("Use letters, numbers, dots, underscores or hyphens for the device name.");
    const { response, data: health } = await fetchWithTimeout(`${baseUrl}/v1/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Stash returned HTTP ${response.status}.`);
    if (health?.service !== "stash" || health?.status !== "ok") throw new Error("That address did not identify itself as Stash.");
    const changedDestination = baseUrl !== stashConfig.baseUrl || device !== stashConfig.device;
    stashConfig = { ...stashConfig, enabled: true, baseUrl, device, lastError: "" };
    if (changedDestination) Object.assign(stashConfig, { lastSuccess: 0, lastHash: "" });
    saveStashConfig();
    renderStashStatus();
    configured = true;
    await backupToStash(true);
  } catch (error) {
    stashStatus.textContent = error.message || "Could not connect to Stash.";
  } finally {
    stashSaveButton.disabled = false;
    if (configured) renderStashStatus();
  }
}

async function backupToStash(force = false, fromSync = false) {
  if (!stashConfig.enabled || stashBackupRunning || (stashSyncRunning && !fromSync) || !navigator.onLine) return false;
  if (!force && Date.now() - stashConfig.lastSuccess < STASH_BACKUP_INTERVAL_MS) return false;
  stashBackupRunning = true;
  stashConfig.lastError = "";
  renderStashStatus();
  try {
    await flushSave();
    const payload = makeBackupPayload();
    const body = JSON.stringify(payload);
    const hash = await sha256(JSON.stringify({ notes: payload.notes, tombstones: payload.tombstones, settings: payload.settings }));
    if (!force && hash === stashConfig.lastHash) {
      stashConfig.lastSuccess = Date.now();
      stashConfig.lastError = "";
      saveStashConfig();
      return true;
    }
    const { response } = await fetchWithTimeout(stashObjectUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!response.ok) throw new Error(`Stash returned HTTP ${response.status}.`);
    const { response: check, data: storedBody } = await fetchWithTimeout(`${stashObjectUrl()}/latest`, { cache: "no-store" }, "text");
    if (!check.ok || storedBody !== body) throw new Error("Stash upload could not be verified. Your local notes are safe.");
    stashConfig.lastSuccess = Date.now();
    stashConfig.lastHash = hash;
    stashConfig.lastError = "";
    saveStashConfig();
    return true;
  } catch (error) {
    stashConfig.lastError = error.message || "Waschbär could not be reached.";
    saveStashConfig();
    return false;
  } finally {
    stashBackupRunning = false;
    renderStashStatus();
  }
}

function renderDeletedNotes() {
  const container = $("#deleted-notes");
  if (!container) return;
  container.replaceChildren();
  if (!tombstones.length) { container.textContent = "No recorded deletions."; return; }
  for (const deletion of [...tombstones].sort((a, b) => b.deletedAt - a.deletedAt)) {
    const recovered = new Map();
    for (const note of [deletion.note, ...(deletion.versions || [])]) {
      if (note && typeof note.text === "string") recovered.set(`${note.text}\u0000${note.syntax}`, note);
    }
    const label = document.createElement("p");
    label.textContent = `Deleted ${formatDate(deletion.deletedAt)} · ${deletion.deviceName || deletion.deviceId || "Unknown device"}`;
    container.append(label);
    for (const note of recovered.values()) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "wide-button";
      button.textContent = `Restore copy · ${noteHeading(note.text)}`;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await restoreDeletedNote(note); button.textContent = "Copy restored"; }
        catch (error) { button.disabled = false; alert(error.message); }
      });
      container.append(button);
    }
  }
}

let mutationQueue = Promise.resolve();

function queueLocalMutation(operation) {
  // Own both the IndexedDB commit and its in-memory replacement. Network/file
  // reads use snapshotQueue instead, so they never block local writing.
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}

function applyMergedSnapshot(remotes) {
  return queueLocalMutation(() => commitMergedSnapshot(remotes));
}

async function commitMergedSnapshot(remotes) {
  // Internal operations must not enqueue behind the transaction they own.
  await flushSaveInternal();
  const merged = ScratchSync.mergeSnapshots({ notes, tombstones }, remotes);
  // Briefly prevent input while the atomic local transaction commits.
  const app = $("#app");
  app.inert = true;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([NOTES_STORE, DELETIONS_STORE], "readwrite");
      const store = transaction.objectStore(NOTES_STORE);
      const retained = new Set(merged.notes.map(note => note.id));
      notes.forEach(note => { if (!retained.has(note.id)) store.delete(note.id); });
      merged.notes.forEach(note => store.put(note));
      merged.tombstones.forEach(item => transaction.objectStore(DELETIONS_STORE).put(item));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    notes = merged.notes;
    tombstones = merged.tombstones;
    if (activeNote) {
      activeNote = notes.find(note => note.id === activeNote.id) || null;
      if (activeNote) { editor.value = activeNote.text; syncOrgPresentation(); }
      else { editorView.hidden = true; listView.hidden = false; history.replaceState({}, "", location.pathname + location.search); }
    }
    sortNotes(); renderNotes(); renderDeletedNotes();
    return merged.report;
  } finally { app.inert = false; }
}

let snapshotQueue = Promise.resolve();

function queueSnapshotOperation(operation) {
  const result = snapshotQueue.then(operation);
  snapshotQueue = result.catch(() => {});
  return result;
}

function syncWithStash() {
  return queueSnapshotOperation(runStashSync);
}

async function runStashSync() {
  if (stashSyncRunning || stashBackupRunning || !stashConfig.enabled) return;
  const status = $("#sync-status");
  if (!navigator.onLine) { status.textContent = "Offline. Notes remain saved locally; retry sync when connected."; return; }
  stashSyncRunning = true;
  status.textContent = "Saving a backup before sync…";
  renderStashStatus();
  try {
    if (!await backupToStash(true, true)) throw new Error(stashConfig.lastError || "Pre-sync backup failed. No notes were merged.");
    status.textContent = "Downloading device backups…";
    const { response, data: index } = await fetchWithTimeout(`${stashConfig.baseUrl}/v1/scratch/devices`, { cache: "no-store" });
    if (response.status === 404) throw new Error("This Stash server needs the device-discovery update before it can sync. Backup still works.");
    if (!response.ok) throw new Error(`Device discovery returned HTTP ${response.status}.`);
    if (!Array.isArray(index.devices)) throw new Error("Stash returned an invalid device list.");
    const remotes = [];
    const seen = new Set();
    for (const entry of index.devices) {
      if (!entry || !validStashDevice(entry.device) || !Array.isArray(entry.types)) throw new Error("Stash returned an invalid device entry.");
      if (entry.device === deviceId || seen.has(entry.device) || !entry.types.includes("backup")) continue;
      seen.add(entry.device);
      const { response: result, data: snapshot } = await fetchWithTimeout(`${stashConfig.baseUrl}/v1/scratch/${encodeURIComponent(entry.device)}/backup/latest`, { cache: "no-store" });
      if (!result.ok) throw new Error(`Could not download ${entry.device}: HTTP ${result.status}. No notes were merged.`);
      if (snapshot?.format !== "scratch-backup" || ![1, 2, 3].includes(snapshot.version)) throw new Error(`Unrecognised backup from ${entry.device}. No notes were merged.`);
      remotes.push(decodeBackupSnapshot(snapshot));
    }
    const report = await applyMergedSnapshot(remotes);
    const summary = `Added ${report.added}, updated ${report.updated}, deleted ${report.deleted}; ${report.conflicts} unresolved extra version${report.conflicts === 1 ? "" : "s"} retained.`;
    if (!await backupToStash(true, true)) { status.textContent = `Merged locally. ${summary} Merged backup pending: ${stashConfig.lastError}`; return; }
    status.textContent = `Sync complete. ${summary}`;
  } catch (error) {
    status.textContent = `Sync stopped: ${error.message} Notes remain local; check Tailscale and retry.`;
  } finally {
    stashSyncRunning = false;
    renderStashStatus();
  }
}

function scheduleStashBackup(delay = STASH_BACKUP_DELAY_MS) {
  if (!stashConfig.enabled) return;
  clearTimeout(stashBackupTimer);
  stashBackupTimer = setTimeout(() => backupToStash(false), delay);
}

async function exportBackup() {
  await flushSave();
  const backup = makeBackupPayload();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const day = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `scratch-backup-${day}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function decodeBackupSnapshot(data) {
  if (data?.format !== "scratch-backup" || ![1, 2, 3].includes(data.version) || !Array.isArray(data.notes)) throw new Error("That is not a supported Scratch backup.");
  const snapshot = {
    notes: data.notes.map(note => note && note.syntax === undefined && data.version < 3 ? { ...note, syntax: "plain" } : note),
    tombstones: data.tombstones === undefined && data.version < 3 ? [] : data.tombstones
  };
  // Validate the whole snapshot before any write. Never silently filter invalid notes.
  ScratchSync.mergeSnapshots({ notes: [], tombstones: [] }, [snapshot]);
  return snapshot;
}

function importBackup(file) {
  // Reserve the shared import/sync queue before reading the file asynchronously.
  return queueSnapshotOperation(() => runBackupImport(file));
}

async function runBackupImport(file) {
  try {
    const data = JSON.parse(await file.text());
    const snapshot = decodeBackupSnapshot(data);
    if (!confirm(`Merge ${snapshot.notes.length} notes and ${snapshot.tombstones.length} deletion records? Conflicting text will be kept; recorded deletions will apply with recovery copies.`)) return;
    const report = await applyMergedSnapshot([snapshot]);
    if (data.settings && typeof data.settings === "object") {
      const choices = { size: ["large", "small", "xsmall"], font: ["sans", "mono", "univers", "univers-black", "univers-extended"], sort: ["modified", "created"] };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const value = data.settings[key];
        if (choices[key] ? choices[key].includes(value) : typeof value === "boolean") settings[key] = value;
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      applySettings(); sortNotes(); renderNotes();
    }
    scheduleStashBackup(1000);
    alert(`Import complete. Added ${report.added}, updated ${report.updated}, deleted ${report.deleted}; ${report.conflicts} conflicts preserved.`);
  } catch (error) { alert(`Import stopped: ${error.message}`); }
}

async function updateStorageStatus(requestPersistence = false) {
  if (!navigator.storage) {
    storageStatus.textContent = "Stored locally in this browser. Export backups occasionally.";
    return;
  }
  try {
    let persistent = await navigator.storage.persisted?.();
    if (!persistent && requestPersistence) persistent = await navigator.storage.persist?.();
    const estimate = await navigator.storage.estimate?.();
    const usage = estimate?.usage ? `${Math.max(1, Math.round(estimate.usage / 1024))} KB used. ` : "";
    storageStatus.textContent = persistent
      ? `${usage}Persistent local storage is enabled. Stash backup and manual sync are optional.`
      : `${usage}Stored locally in Safari. Export backups occasionally.`;
  } catch {
    storageStatus.textContent = "Stored locally in this browser. Export backups occasionally.";
  }
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const top = viewport?.offsetTop || 0;
  const orientation = window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait";
  const editorFocused = document.activeElement === editor;
  if (!editorFocused || height > viewportBaselines[orientation]) {
    viewportBaselines[orientation] = height;
  }
  const keyboardReduction = viewportBaselines[orientation] - height;
  const keyboardVisible = keyboardReduction > 120 || height < 320;
  const hideBar = editorFocused && orientation === "landscape" && keyboardVisible;
  document.body.classList.toggle("landscape-keyboard", hideBar);
  document.documentElement.style.setProperty("--visual-height", `${height}px`);
  document.documentElement.style.setProperty("--visual-top", `${top}px`);
}

function wireEvents() {
  $("#show-conflicts-button")?.addEventListener("click", showConflicts);
  $("#review-conflicts-button")?.addEventListener("click", () => {
    if (conflictsOnly) { conflictsOnly = false; renderNotes(); }
    else showConflicts();
  });
  $("#conflict-close")?.addEventListener("click", closeConflictReview);
  $("#conflict-dialog")?.addEventListener("cancel", event => { event.preventDefault(); closeConflictReview(); });
  $("#conflict-save-combination")?.addEventListener("click", () => resolveReviewedConflict("combine"));
  $("#conflict-keep-both")?.addEventListener("click", () => resolveReviewedConflict("keep-both"));
  $("#conflict-review-latest")?.addEventListener("click", () => conflictSession && openConflictReview(conflictSession.rootId, true));
  $("#undo-delete")?.addEventListener("click", async () => {
    if (!undoNote) return;
    await restoreDeletedNote(undoNote);
    clearTimeout(undoTimer); undoNote = null; $("#delete-notice").hidden = true;
  });
  for (const dialog of [settingsDialog, dataDialog, $("#conflict-dialog")].filter(Boolean)) {
    let startedOutside = false;
    const outside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener("pointerdown", event => { startedOutside = event.target === dialog && outside(event); });
    dialog.addEventListener("click", event => {
      if (startedOutside && event.target === dialog && outside(event)) {
        if (dialog.id === "conflict-dialog") closeConflictReview();
        else dialog.close();
      }
      startedOutside = false;
    });
  }
  searchButton?.addEventListener("click", () => setSearchOpen(searchControls.hidden));
  $("#clear-search")?.addEventListener("click", () => {
    noteSearch.value = "";
    renderNotes();
    noteSearch.focus();
  });
  noteSearch.addEventListener("input", renderNotes);
  noteSearch.addEventListener("keydown", event => {
    if (event.key === "Enter") noteSearch.blur();
  });
  $("#new-note-button").addEventListener("click", createNote);
  $("#empty-new-button").addEventListener("click", createNote);
  $("#back-button").addEventListener("click", () => closeEditor());
  $("#delete-button").addEventListener("click", () => activeNote && removeNote(activeNote.id));
  $("#share-button").addEventListener("click", shareActiveNote);
  readerButton.addEventListener("click", toggleReaderMode);
  editor.addEventListener("input", queueSave);
  editor.addEventListener("scroll", syncHighlightScroll);
  editor.addEventListener("focus", syncVisualViewport);
  editor.addEventListener("blur", () => {
    if (dirty) saveActiveNote();
    setTimeout(syncVisualViewport, 0);
  });
  notesList.addEventListener("click", event => {
    const button = event.target.closest(".note-button");
    if (!button) return;
    const note = notes.find(item => item.id === button.dataset.id);
    if (note && currentConflictGroups().has(note.conflictOf || note.id)) openConflictReview(note.id);
    else openNote(button.dataset.id);
  });

  const openSettings = () => {
    applySettings();
    syncOrgPresentation();
    settingsDialog.showModal();
  };
  $("#editor-settings-button").addEventListener("click", openSettings);
  $("#data-button").addEventListener("click", () => {
    dataDialog.showModal();
    updateStorageStatus(true);
    renderStashStatus();
    renderDeletedNotes();
  });
  document.querySelectorAll("[data-setting]").forEach(button => {
    button.addEventListener("click", () => updateSetting(button.dataset.setting, button.dataset.value));
  });
  wrapToggle.addEventListener("change", () => updateSetting("wrap", wrapToggle.checked));
  typingToggle.addEventListener("change", () => updateSetting("typing", typingToggle.checked));
  orgToggle.addEventListener("change", () => setOrgSyntax(orgToggle.checked));
  $("#export-button").addEventListener("click", exportBackup);
  $("#import-button").addEventListener("click", () => importInput.click());
  stashSaveButton.addEventListener("click", testAndSaveStash);
  stashBackupButton.addEventListener("click", () => backupToStash(true));
  $("#stash-sync-button")?.addEventListener("click", syncWithStash);
  importInput.addEventListener("change", async () => {
    const [file] = importInput.files;
    if (file) await importBackup(file);
    importInput.value = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) saveActiveNote();
    if (document.visibilityState === "visible") scheduleStashBackup(1000);
  });
  window.addEventListener("online", () => scheduleStashBackup(1000));
  window.addEventListener("pagehide", () => { if (dirty) saveActiveNote(); });
  window.addEventListener("popstate", () => { if (!editorView.hidden) closeEditor({ fromHistory: true }); });
  window.addEventListener("resize", syncVisualViewport);
  window.addEventListener("orientationchange", syncVisualViewport);
  window.visualViewport?.addEventListener("resize", syncVisualViewport);
  window.visualViewport?.addEventListener("scroll", syncVisualViewport);
}

async function start() {
  applySettings();
  renderStashStatus();
  syncVisualViewport();
  wireEvents();
  try {
    db = await openDatabase();
    await loadNotes();
    scheduleStashBackup(3000);
  } catch (error) {
    console.error(error);
    alert("Scratch could not open its local database. Notes cannot be saved in this browser session.");
  }
  updateStorageStatus(false);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed", error));
  }
}

start();
