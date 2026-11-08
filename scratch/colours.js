/* Whole-foreground colours: exact ctrl_deck palette and native GRB neon loop. */
(function (root) {
  "use strict";
  const MODES = Object.freeze([
    { id: "white", label: "White", rgb: [255, 255, 255] },
    { id: "red", label: "Red", rgb: [208, 48, 40] },
    { id: "lime", label: "Acid lime", rgb: [199, 255, 62] },
    { id: "cyan", label: "Electric cyan", rgb: [53, 232, 255] },
    { id: "pink", label: "Hot pink", rgb: [255, 77, 166] },
    { id: "violet", label: "Ultraviolet", rgb: [167, 139, 250] },
    { id: "orange", label: "Ember orange", rgb: [255, 146, 87] },
    { id: "neon", label: "Neon loop · 10 seconds", rgb: [199, 255, 62], url: "colours/ctrl-deck-neon.30fps.10g.0dv" },
    { id: "wheel", label: "Colour wheel" }
  ]);
  function nextMode(id) {
    const index = Math.max(0, MODES.findIndex(mode => mode.id === id));
    return MODES[(index + 1) % MODES.length].id;
  }
  function init(button) {
    if (!button) return;
    const key = "scratch-colour-v1";
    let selected;
    try { selected = localStorage.getItem(key); } catch { /* Private storage. */ }
    let mode = MODES.find(item => item.id === selected) || MODES[0];
    let animation = 0;
    let epoch = performance.now();
    let frames = null;
    let loading = null;
    let generation = 0;
    let suspended = false;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    function paint(rgb) {
      document.documentElement.style.setProperty("--foreground", `rgb(${rgb.join(", ")})`);
      document.documentElement.style.setProperty("--foreground-rgb", rgb.join(", "));
    }
    function draw(now) {
      animation = 0;
      if (document.hidden || suspended || reducedMotion.matches) return;
      if (mode.id === "neon") {
        if (!frames) return;
        const offset = Math.floor((now - epoch) * 30 / 1000) % (frames.length / 3) * 3;
        // Native .10g is gamma 1. Reorder headerless GRB bytes, no gamma transform.
        paint([frames[offset + 1], frames[offset], frames[offset + 2]]);
        animation = requestAnimationFrame(draw);
        return;
      }
      if (mode.id !== "wheel") return;
      const hue = ((now - epoch) / 120000) % 1;
      const channel = offset => {
        const x = (hue * 6 + offset) % 6;
        return Math.round(255 * Math.max(0, Math.min(1, Math.abs(x - 3) - 1)));
      };
      paint([channel(0), channel(4), channel(2)]);
      animation = requestAnimationFrame(draw);
    }
    function restart() {
      cancelAnimationFrame(animation);
      animation = 0;
      if (!document.hidden && !suspended && !reducedMotion.matches) draw(performance.now());
    }
    async function loadNeon(token) {
      const controller = new AbortController();
      loading = controller;
      // Keep the bound through body consumption, not just response headers.
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(mode.url, { signal: controller.signal });
        if (!response.ok) throw new Error("Colour download failed");
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length !== 900) throw new Error("Invalid native neon stream");
        if (generation !== token || controller.signal.aborted) return;
        frames = data;
        epoch = performance.now();
        button.dataset.loaded = "true";
        restart();
      } catch {
        if (generation === token) {
          button.dataset.loaded = "error";
          button.title = "Neon loop unavailable · showing Acid lime · tap for Colour wheel";
        }
      } finally {
        clearTimeout(timeout);
        if (loading === controller) loading = null;
      }
    }
    function select(id) {
      cancelAnimationFrame(animation);
      loading?.abort();
      generation += 1;
      frames = null;
      delete button.dataset.loaded;
      mode = MODES.find(item => item.id === id) || MODES[0];
      epoch = performance.now();
      button.dataset.mode = mode.id;
      const next = MODES.find(item => item.id === nextMode(mode.id));
      button.setAttribute("aria-label", `Colour: ${mode.label}. Next: ${next.label}`);
      button.title = `${mode.label} · tap for ${next.label}`;
      paint(mode.rgb || [255, 0, 0]);
      try { localStorage.setItem(key, mode.id); } catch { /* Session only. */ }
      restart();
      if (mode.url) loadNeon(generation);
    }
    button.addEventListener("click", () => select(nextMode(mode.id)));
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("pagehide", () => { suspended = true; cancelAnimationFrame(animation); });
    window.addEventListener("pageshow", () => { suspended = false; restart(); });
    reducedMotion.addEventListener("change", restart);
    select(mode.id);
  }
  const api = { MODES, nextMode, init };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScratchColours = api;
})(typeof window === "object" ? window : globalThis);
