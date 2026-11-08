/* Whole-foreground colours. Fluorescents copied verbatim from ctrl_deck's
   /Users/hamish/art/tools/neon-deck/decks.json (not approximated). */
(function (root) {
  "use strict";
  const MODES = Object.freeze([
    { id: "white", label: "White", rgb: [255, 255, 255] },
    { id: "red", label: "Red", rgb: [208, 48, 40] },
    { id: "lime", label: "Acid lime", rgb: [199, 255, 62] }, // #C7FF3E
    { id: "cyan", label: "Electric cyan", rgb: [53, 232, 255] }, // #35E8FF
    { id: "pink", label: "Hot pink", rgb: [255, 77, 166] }, // #FF4DA6
    { id: "violet", label: "Ultraviolet", rgb: [167, 139, 250] }, // #A78BFA
    { id: "orange", label: "Ember orange", rgb: [255, 146, 87] }, // #FF9257
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
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    function paint(rgb) {
      document.documentElement.style.setProperty("--foreground", `rgb(${rgb.join(", ")})`);
      document.documentElement.style.setProperty("--foreground-rgb", rgb.join(", "));
    }
    function draw(now) {
      animation = 0;
      if (document.hidden || mode.id !== "wheel") return;
      const hue = ((now - epoch) / 120000) % 1;
      const channel = offset => {
        const x = (hue * 6 + offset) % 6;
        return Math.round(255 * Math.max(0, Math.min(1, Math.abs(x - 3) - 1)));
      };
      paint([channel(0), channel(4), channel(2)]);
      if (!reducedMotion.matches) animation = requestAnimationFrame(draw);
    }
    function restart() {
      cancelAnimationFrame(animation);
      if (!document.hidden) draw(performance.now());
    }
    function select(id) {
      cancelAnimationFrame(animation);
      mode = MODES.find(item => item.id === id) || MODES[0];
      epoch = performance.now();
      button.dataset.mode = mode.id;
      const next = MODES.find(item => item.id === nextMode(mode.id));
      button.setAttribute("aria-label", `Colour: ${mode.label}. Next: ${next.label}`);
      button.title = `${mode.label} · tap for ${next.label}`;
      paint(mode.rgb || [255, 255, 255]);
      try { localStorage.setItem(key, mode.id); } catch { /* Session only. */ }
      restart();
    }
    button.addEventListener("click", () => select(nextMode(mode.id)));
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("pagehide", () => cancelAnimationFrame(animation));
    window.addEventListener("pageshow", restart);
    reducedMotion.addEventListener("change", restart);
    select(mode.id);
  }
  const api = { MODES, nextMode, init };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScratchColours = api;
})(typeof window === "object" ? window : globalThis);
