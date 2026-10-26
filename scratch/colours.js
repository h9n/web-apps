/* Native 0dv playback: one GRB triple per frame, no header. */
(function (root) {
  "use strict";
  const MODES = Object.freeze([
    { id: "white", label: "White", rgb: [255, 255, 255] },
    { id: "red", label: "Red", rgb: [208, 48, 40] },
    { id: "blockiness", label: "Blockiness", url: "./colours/blockiness.30fps.n3.70g.0dv", fps: 30, gamma: 7 },
    { id: "drift", label: "Drift", url: "./colours/nocturnal-drift.30fps.10g.0dv", fps: 30, gamma: 1 },
    { id: "wheel", label: "Colour wheel" }
  ]);

  function nextMode(id) {
    const index = Math.max(0, MODES.findIndex(mode => mode.id === id));
    return MODES[(index + 1) % MODES.length].id;
  }

  function decodeFrame(bytes, frame, gamma) {
    if (!bytes.length || bytes.length % 3) throw new Error("Incomplete 0dv frame");
    const offset = (frame % (bytes.length / 3)) * 3;
    return [bytes[offset + 1], bytes[offset], bytes[offset + 2]]
      .map(value => Math.round(255 * Math.pow(value / 255, 1 / gamma)));
  }

  function readableFrame(rgb) {
    const peak = Math.max(...rgb);
    if (!peak) return [96, 96, 96];
    const scale = Math.max(1, 96 / peak);
    return rgb.map(value => Math.round(value * scale));
  }

  function init(button) {
    if (!button) return; // One-shell upgrade compatibility.
    const key = "scratch-colour-v1";
    let selected;
    try { selected = localStorage.getItem(key); } catch { /* Private storage. */ }
    let mode = MODES.find(item => item.id === selected) || MODES[0];
    let bytes = null;
    let animation = 0;
    let generation = 0;
    let controller = null;
    let epoch = performance.now();
    let lastFrame = -1;
    const buffers = new Map();
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    function paint(rgb) {
      document.documentElement.style.setProperty("--foreground", `rgb(${rgb.join(", ")})`);
      document.documentElement.style.setProperty("--foreground-rgb", rgb.join(", "));
    }

    function draw(now) {
      animation = 0;
      if (document.hidden) return;
      const elapsed = now - epoch;
      if (bytes) {
        const frame = Math.floor(elapsed * mode.fps / 1000);
        if (frame !== lastFrame) paint(readableFrame(decodeFrame(bytes, frame, mode.gamma)));
        lastFrame = frame;
      } else if (mode.id === "wheel") {
        const hue = (elapsed / 120000) % 1;
        // HSV at full saturation: a two-minute loop without channel discontinuities.
        const channel = offset => {
          const x = (hue * 6 + offset) % 6;
          return Math.round(255 * Math.max(0, Math.min(1, Math.abs(x - 3) - 1)));
        };
        paint([channel(0), channel(4), channel(2)]);
      }
      if (!reducedMotion.matches && (bytes || mode.id === "wheel")) animation = requestAnimationFrame(draw);
    }

    function restart() {
      cancelAnimationFrame(animation);
      lastFrame = -1;
      if (!document.hidden) draw(performance.now());
    }

    async function select(id) {
      const current = ++generation;
      controller?.abort();
      cancelAnimationFrame(animation);
      bytes = null;
      mode = MODES.find(item => item.id === id) || MODES[0];
      epoch = performance.now();
      button.dataset.mode = mode.id;
      delete button.dataset.error;
      button.removeAttribute("aria-busy");
      const next = MODES.find(item => item.id === nextMode(mode.id));
      button.setAttribute("aria-label", `Colour: ${mode.label}. Next: ${next.label}`);
      button.title = `${mode.label} · tap for ${next.label}`;
      paint(mode.rgb || [255, 255, 255]);
      try { localStorage.setItem(key, mode.id); } catch { /* Still works this session. */ }
      if (!mode.url) { restart(); return; }
      button.setAttribute("aria-busy", "true");
      controller = new AbortController();
      const signal = controller.signal;
      const timeout = setTimeout(() => controller?.signal === signal && controller.abort(), 10000);
      try {
        let data = buffers.get(mode.url);
        if (!data) {
          const response = await fetch(mode.url, { signal });
          if (!response.ok) throw new Error("Colour sequence unavailable");
          data = new Uint8Array(await response.arrayBuffer());
          if (signal.aborted) throw new Error("Colour sequence timed out");
          if (!data.length || data.length % 3) throw new Error("Incomplete 0dv frame");
        }
        if (current !== generation) return;
        buffers.set(mode.url, data);
        bytes = data;
        epoch = performance.now();
        restart();
      } catch (error) {
        if (current !== generation) return;
        paint([255, 255, 255]);
        button.dataset.error = "unavailable";
        button.title = `${mode.label} unavailable · showing white · tap to continue`;
        button.setAttribute("aria-label", `${mode.label} unavailable. Showing white. Next: ${next.label}`);
      } finally {
        clearTimeout(timeout);
        if (current === generation) button.removeAttribute("aria-busy");
      }
    }

    button.addEventListener("click", () => select(nextMode(mode.id)));
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("pagehide", () => cancelAnimationFrame(animation));
    window.addEventListener("pageshow", restart);
    reducedMotion.addEventListener("change", restart);
    select(mode.id);
  }

  const api = { MODES, nextMode, decodeFrame, readableFrame, init };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScratchColours = api;
})(typeof window === "object" ? window : globalThis);
