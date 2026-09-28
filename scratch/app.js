"use strict";

const DB_NAME = "scratch-notes";
const DB_VERSION = 1;
const NOTES_STORE = "notes";
const SETTINGS_KEY = "scratch-settings-v1";
const IDLE_SAVE_MS = 1200;
const MAX_SAVE_MS = 5000;
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
const saveStatus = $("#save-status");
const settingsDialog = $("#settings-dialog");
const dataDialog = $("#data-dialog");
const wrapToggle = $("#wrap-toggle");
const typingToggle = $("#typing-toggle");
const storageStatus = $("#storage-status");
const importInput = $("#import-input");

let db;
let notes = [];
let activeNote = null;
let dirty = false;
let editRevision = 0;
let idleSaveTimer = null;
let maxSaveTimer = null;
let settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
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
  sortNotes();
  renderNotes();
}

function sortNotes() {
  const field = settings.sort === "created" ? "createdAt" : "updatedAt";
  notes.sort((a, b) => b[field] - a[field]);
}

function noteHeading(text) {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "Untitled";
}

function notePreview(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.slice(1).join(" ") || "No additional text";
}

function safeFilename(text) {
  const cleaned = noteHeading(text)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${cleaned || "Untitled"}.txt`;
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
  const dateLabel = settings.sort === "created" ? "Created" : "Edited";

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
    date.textContent = `${dateLabel} ${formatDate(note[dateField])}`;
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
  const note = { id: makeId(), text: "", createdAt: now, updatedAt: now };
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
  editor.value = activeNote.text;
  listView.hidden = true;
  editorView.hidden = false;
  saveStatus.textContent = "Saved";
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
  const file = new File([activeNote.text], safeFilename(activeNote.text), { type: "text/plain" });
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

async function exportBackup() {
  await flushSave();
  const backup = {
    format: "scratch-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    notes,
    settings
  };
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
  document.documentElement.style.setProperty("--visual-height", `${height}px`);
  document.documentElement.style.setProperty("--visual-top", `${top}px`);
}

function wireEvents() {
  $("#new-note-button").addEventListener("click", createNote);
  $("#empty-new-button").addEventListener("click", createNote);
  $("#back-button").addEventListener("click", () => closeEditor());
  $("#delete-button").addEventListener("click", () => activeNote && removeNote(activeNote.id));
  $("#share-button").addEventListener("click", shareActiveNote);
  editor.addEventListener("input", queueSave);
  editor.addEventListener("blur", () => { if (dirty) saveActiveNote(); });
  notesList.addEventListener("click", event => {
    const button = event.target.closest(".note-button");
    if (button) openNote(button.dataset.id);
  });

  const openSettings = () => {
    applySettings();
    settingsDialog.showModal();
  };
  $("#editor-settings-button").addEventListener("click", openSettings);
  $("#data-button").addEventListener("click", () => {
    dataDialog.showModal();
    updateStorageStatus(true);
  });
  document.querySelectorAll("[data-setting]").forEach(button => {
    button.addEventListener("click", () => updateSetting(button.dataset.setting, button.dataset.value));
  });
  wrapToggle.addEventListener("change", () => updateSetting("wrap", wrapToggle.checked));
  typingToggle.addEventListener("change", () => updateSetting("typing", typingToggle.checked));
  $("#export-button").addEventListener("click", exportBackup);
  $("#import-button").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const [file] = importInput.files;
    if (file) await importBackup(file);
    importInput.value = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) saveActiveNote();
  });
  window.addEventListener("pagehide", () => { if (dirty) saveActiveNote(); });
  window.addEventListener("popstate", () => { if (!editorView.hidden) closeEditor({ fromHistory: true }); });
  window.addEventListener("resize", syncVisualViewport);
  window.addEventListener("orientationchange", syncVisualViewport);
  window.visualViewport?.addEventListener("resize", syncVisualViewport);
  window.visualViewport?.addEventListener("scroll", syncVisualViewport);
}

async function start() {
  applySettings();
  syncVisualViewport();
  wireEvents();
  try {
    db = await openDatabase();
    await loadNotes();
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
