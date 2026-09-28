"use strict";

const DB_NAME = "scratch-notes";
const DB_VERSION = 1;
const NOTES_STORE = "notes";
const SETTINGS_KEY = "scratch-settings-v1";
const STASH_KEY = "scratch-stash-v1";
const IDLE_SAVE_MS = 1200;
const MAX_SAVE_MS = 5000;
const STASH_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STASH_BACKUP_DELAY_MS = 30 * 1000;
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
const emptyState = $("#empty-state");
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(NOTES_STORE, mode);
    const store = transaction.objectStore(NOTES_STORE);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function loadNotes() {
  notes = await transact("readonly", store => store.getAll()) || [];
  notes = notes.map(note => ({ ...note, syntax: note.syntax === "org" ? "org" : "plain" }));
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

function renderNotes() {
  notesList.replaceChildren();
  emptyState.hidden = notes.length !== 0;
  notesList.hidden = notes.length === 0;
  const dateField = settings.sort === "created" ? "createdAt" : "updatedAt";

  for (const note of notes) {
    const row = document.createElement("li");
    row.className = "note-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-button";
    button.dataset.id = note.id;

    const title = document.createElement("span");
    title.className = "note-title";
    title.textContent = noteHeading(note.text);

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
    row.append(button);
    notesList.append(row);
  }
}

function makeId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createNote() {
  await flushSave();
  const now = Date.now();
  const note = { id: makeId(), text: "", syntax: "plain", createdAt: now, updatedAt: now };
  await transact("readwrite", store => store.put(note));
  notes.unshift(note);
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

function queueSave() {
  if (!activeNote) return;
  activeNote.text = editor.value;
  activeNote.updatedAt = Date.now();
  if (activeNote.syntax === "org") {
    editorHighlight.innerHTML = highlightOrgSource(editor.value);
    syncHighlightScroll();
  }
  dirty = true;
  editRevision += 1;
  saveStatus.textContent = "Unsaved";
  scheduleSave();
}

async function saveActiveNote() {
  clearSaveTimers();
  if (!activeNote || !dirty || !db) return;
  const revisionBeingSaved = editRevision;
  const note = { ...activeNote };
  saveStatus.textContent = "Saving…";
  try {
    await transact("readwrite", store => store.put(note));
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
  }
}

async function flushSave() {
  if (dirty) await saveActiveNote();
}

async function removeNote(id, ask = true) {
  const note = notes.find(item => item.id === id);
  if (!note) return;
  if (ask && !confirm(`Delete “${noteHeading(note.text)}”?`)) return;
  clearSaveTimers();
  dirty = false;
  await transact("readwrite", store => store.delete(id));
  notes = notes.filter(item => item.id !== id);
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
    version: 2,
    exportedAt: new Date().toISOString(),
    notes,
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
  return `${stashConfig.baseUrl}/v1/scratch/${encodeURIComponent(stashConfig.device)}/backup`;
}

function renderStashStatus() {
  stashUrlInput.value = stashConfig.baseUrl;
  stashDeviceInput.value = stashConfig.device;
  stashBackupButton.disabled = !stashConfig.enabled || stashBackupRunning;
  if (!stashConfig.enabled) {
    stashStatus.textContent = "Not configured. Backups remain local until Stash is set up.";
  } else if (stashBackupRunning) {
    stashStatus.textContent = `Backing up ${notes.length} note${notes.length === 1 ? "" : "s"} as ${stashConfig.device}…`;
  } else if (stashConfig.lastError) {
    stashStatus.textContent = `Backup pending: ${stashConfig.lastError}`;
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
    const response = await fetch(`${baseUrl}/v1/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Stash returned HTTP ${response.status}.`);
    const health = await response.json();
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

async function backupToStash(force = false) {
  if (!stashConfig.enabled || stashBackupRunning || !navigator.onLine) return false;
  if (!force && Date.now() - stashConfig.lastSuccess < STASH_BACKUP_INTERVAL_MS) return false;
  stashBackupRunning = true;
  stashConfig.lastError = "";
  renderStashStatus();
  try {
    await flushSave();
    const payload = makeBackupPayload();
    const body = JSON.stringify(payload);
    const hash = await sha256(JSON.stringify({ notes, settings }));
    if (!force && hash === stashConfig.lastHash) {
      stashConfig.lastSuccess = Date.now();
      stashConfig.lastError = "";
      saveStashConfig();
      return true;
    }
    const response = await fetch(stashObjectUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!response.ok) throw new Error(`Stash returned HTTP ${response.status}.`);
    await response.json();
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

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert("That file is not valid JSON."); return; }
  if (data?.format !== "scratch-backup" || !Array.isArray(data.notes)) {
    alert("That does not look like a Scratch backup.");
    return;
  }
  if (!confirm(`Import ${data.notes.length} note${data.notes.length === 1 ? "" : "s"}? Existing notes will be kept.`)) return;

  const validNotes = data.notes.filter(note => note && typeof note.id === "string" && typeof note.text === "string").map(note => ({
    id: note.id,
    text: note.text,
    syntax: note.syntax === "org" ? "org" : "plain",
    createdAt: Number(note.createdAt) || Date.now(),
    updatedAt: Number(note.updatedAt) || Date.now()
  }));
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(NOTES_STORE, "readwrite");
    const store = transaction.objectStore(NOTES_STORE);
    validNotes.forEach(note => store.put(note));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  if (data.settings && typeof data.settings === "object") {
    settings = { ...DEFAULT_SETTINGS, ...data.settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    applySettings();
  }
  await loadNotes();
  scheduleStashBackup(1000);
  alert(`Imported ${validNotes.length} note${validNotes.length === 1 ? "" : "s"}.`);
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
      ? `${usage}Persistent local storage is enabled. Nothing is synced.`
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
    if (button) openNote(button.dataset.id);
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
