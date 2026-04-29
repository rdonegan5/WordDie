const STORAGE_KEY = "random_die_v2";

// state.labels[i] corresponds to face (i+1)
// state.counts[i] tracks how many times face (i+1) rolled
// state.history stores {ts, text} where text is the side text at roll time.
let state = {
  labels: [],
  counts: [],
  history: [],
  maxHistory: 50,
  // Last rolled data for the die render panel. History itself stays {ts, text}.
  lastFace: null,
  lastText: "",
};

const $ = (id) => document.getElementById(id);

function clampInt(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  n = Math.trunc(n);
  return Math.max(min, Math.min(max, n));
}

function defaultLabel(i) {
  return `Side ${i + 1}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function normalizeStateAfterLoad() {
  const MIN_SIDES = 2;

  // Migration / defaults
  if (!Array.isArray(state.labels) || state.labels.length === 0) {
    state.labels = Array.from({ length: 6 }, (_, i) => defaultLabel(i));
  }

  state.labels = state.labels.map((v, i) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length ? s : defaultLabel(i);
  });

  // Ensure at least MIN_SIDES
  if (state.labels.length < MIN_SIDES) {
    while (state.labels.length < MIN_SIDES) state.labels.push(defaultLabel(state.labels.length));
  }

  // Counts length match labels length
  const counts = Array.isArray(state.counts) ? state.counts : [];
  state.counts = Array.from({ length: state.labels.length }, (_, i) => {
    const c = counts[i];
    return typeof c === "number" && c >= 0 ? c : 0;
  });

  // Migrate history entries to {ts, text} and prune
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history = state.history
    .map((h) => {
      if (!h || typeof h !== "object") return null;

      const ts = typeof h.ts === "number" ? h.ts : Date.now();

      if (typeof h.text === "string") {
        return { ts, text: h.text };
      }

      // Backwards-compat for older version: {ts, face}
      if (typeof h.face === "number") {
        const idx = h.face - 1;
        const text = state.labels[idx] ?? defaultLabel(idx);
        return { ts, text };
      }

      return null;
    })
    .filter(Boolean)
    .slice(-state.maxHistory);

  // Reconstruct last roll (for die render) if older storage didn't have it.
  if (!Array.isArray(state.history) || state.history.length === 0) {
    state.lastFace = Number.isFinite(state.lastFace) ? state.lastFace : null;
    state.lastText = typeof state.lastText === "string" ? state.lastText : "";
    return;
  }

  const latestText = state.history[state.history.length - 1]?.text;
  if (typeof state.lastText !== "string" || !state.lastText) state.lastText = latestText ?? "";

  const idx = state.labels.findIndex((l) => l === state.lastText);
  if (Number.isFinite(state.lastFace)) {
    // Keep existing value if it's plausible, otherwise fall back to lookup.
    if (typeof idx === "number" && idx >= 0) {
      const plausibleFace = idx + 1;
      state.lastFace = plausibleFace;
    } else {
      state.lastFace = null;
    }
  } else {
    state.lastFace = idx >= 0 ? idx + 1 : null;
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    // Backwards-compat if an older version saved {sides, labels, counts, history}
    if (Array.isArray(parsed.labels)) state.labels = parsed.labels;
    else if (typeof parsed.sides === "number") {
      const n = clampInt(parsed.sides, 2, 1000);
      state.labels = Array.from({ length: n }, (_, i) => defaultLabel(i));
    }

    if (Array.isArray(parsed.counts)) state.counts = parsed.counts;
    if (Array.isArray(parsed.history)) state.history = parsed.history;
    if (typeof parsed.maxHistory === "number") state.maxHistory = parsed.maxHistory;
  } catch {
    // Corrupted storage: ignore and use defaults
  }
}

function renderSideInputs() {
  const container = $("sideLabels");
  container.innerHTML = "";

  const MIN_SIDES = 2;
  const n = state.labels.length;

  $("sidesInfo").textContent = `Current sides: ${n}`;

  state.labels.forEach((label, idx) => {
    const row = document.createElement("div");
    row.className = "side-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = label;

    const minusBtn = document.createElement("button");
    minusBtn.className = "btn-small";
    minusBtn.type = "button";
    minusBtn.textContent = "-";
    minusBtn.title = `Remove side ${idx + 1}`;
    minusBtn.disabled = n <= MIN_SIDES;

    input.addEventListener("input", () => {
      state.labels[idx] = input.value;
      saveState();
      renderCounts(); // counts depend on number of sides; history text is stored at roll time
    });

    minusBtn.addEventListener("click", () => removeSideAtIndex(idx));

    row.appendChild(input);
    row.appendChild(minusBtn);
    container.appendChild(row);
  });
}

function renderCounts() {
  const body = $("countsBody");
  body.innerHTML = "";

  for (let i = 0; i < state.labels.length; i++) {
    const face = i + 1;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${face}</td>
      <td>${escapeHtml(state.labels[i])}</td>
      <td>${state.counts[i] ?? 0}</td>
    `;
    body.appendChild(tr);
  }

  const total = state.counts.reduce((a, b) => a + (b || 0), 0);
  $("totals").textContent = `Total rolls: ${total}`;
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";

  if (!state.history.length) {
    box.innerHTML = `<div class="muted">No rolls yet.</div>`;
    return;
  }

  const items = [...state.history].sort((a, b) => b.ts - a.ts);
  for (const h of items) {
    const div = document.createElement("div");
    div.className = "hist-item";
    div.textContent = `${new Date(h.ts).toLocaleString()} — ${h.text}`;
    box.appendChild(div);
  }
}

function renderResult(face, text) {
  const idx = face - 1;
  $("resultWrap").textContent = `You rolled: ${text}`;
  $("rollMeta").textContent = `Face ${face} — rolled ${state.counts[idx] ?? 0} time(s).`;
}

const CUBE_ROTATIONS_BY_PIP = {
  1: { rx: 0, ry: 0 },
  2: { rx: 0, ry: -90 },
  3: { rx: 0, ry: 180 },
  4: { rx: 0, ry: 90 },
  5: { rx: -90, ry: 0 },
  6: { rx: 90, ry: 0 },
};

// Track current orientation + scale so toss animation starts smoothly (no jump).
let die3dCurrent = { rx: 0, ry: 0, scale: 1 };

function setDieTextOnFaces(text) {
  const els = document.querySelectorAll("[data-die3d-text]");
  for (const el of els) {
    el.textContent = text ?? "";
  }
}

function initDie3dFaces() {
  // Set initial text (helps avoid flash of empty faces)
  setDieTextOnFaces(state.lastText || state.labels[0] || defaultLabel(0));
}

function parseCurrentTransformRotation(die3dEl) {
  // We keep our own die3dCurrent, so this is a fallback.
  if (
    die3dCurrent &&
    Number.isFinite(die3dCurrent.rx) &&
    Number.isFinite(die3dCurrent.ry) &&
    Number.isFinite(die3dCurrent.scale)
  ) {
    return { rx: die3dCurrent.rx, ry: die3dCurrent.ry, scale: die3dCurrent.scale };
  }
  return { rx: 0, ry: 0, scale: 1 };
}

function animateDie3dToPip(pipCount, animate = true) {
  const die3dEl = $("die3d");
  if (!die3dEl) return;

  const rot = CUBE_ROTATIONS_BY_PIP[pipCount] || CUBE_ROTATIONS_BY_PIP[1];
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const { rx: startRx, ry: startRy, scale: startScale } = parseCurrentTransformRotation(die3dEl);
  const MIN_SPINS_SUM = 4; // 2+2
  const MAX_SPINS_SUM = 8; // 4+4

  if (!animate || reduceMotion) {
    // No toss: keep current scale, snap rotation (no user tracking anyway).
    die3dEl.style.transition = "transform 0ms";
    die3dEl.style.transform = `rotateX(${rot.rx}deg) rotateY(${rot.ry}deg) scale3d(${startScale}, ${startScale}, ${startScale})`;
    die3dCurrent = { rx: rot.rx, ry: rot.ry, scale: startScale };
    return;
  }

  // Start from current rotation (smooth), then toss through extra spins.
  const spinsX = Math.floor(Math.random() * 3) + 2; // 2..4
  const spinsY = Math.floor(Math.random() * 3) + 2; // 2..4
  const spinsSum = spinsX + spinsY;
  const speedNorm = (spinsSum - MIN_SPINS_SUM) / (MAX_SPINS_SUM - MIN_SPINS_SUM); // 0..1

  // C) Map rotation speed => die scale:
  // speed 0 => 1.0
  // speed max => 0.5
  const endScale = 1 - 0.5 * speedNorm;
  // Make scaling change gradually during the toss (not instantly).
  const midScale = startScale + (endScale - startScale) * 0.65;

  // More speed => slightly faster settle.
  const durationTotal = Math.round(1050 - 420 * speedNorm); // ~630..1050
  const duration1 = Math.round(durationTotal * 0.7);
  const duration2 = durationTotal - duration1;

  // Ensure final orientation lands exactly on the selected side (no "snap" settle).
  const endRx = rot.rx + spinsX * 360;
  const endRy = rot.ry + spinsY * 360;

  // Add disorientation during the first phase, but always end exactly at (endRx,endRy).
  const midJitterX = (Math.random() * 220 - 110) * (0.5 + 0.5 * speedNorm); // +/- ~55..110*
  const midJitterY = (Math.random() * 220 - 110) * (0.5 + 0.5 * speedNorm);
  const midRx = rot.rx + spinsX * 360 + midJitterX;
  const midRy = rot.ry + spinsY * 360 + midJitterY;

  // Ensure we start at the current visual orientation + scale (no jump).
  die3dEl.style.transition = "none";
  die3dEl.style.transform = `rotateX(${startRx}deg) rotateY(${startRy}deg) scale3d(${startScale}, ${startScale}, ${startScale})`;
  void die3dEl.offsetWidth;

  die3dEl.style.transition = `transform ${duration1}ms cubic-bezier(0.2, 0.9, 0.2, 1)`;
  die3dEl.style.transform = `rotateX(${midRx}deg) rotateY(${midRy}deg) scale3d(${midScale}, ${midScale}, ${midScale})`;

  const onPhase1End = () => {
    die3dEl.removeEventListener("transitionend", onPhase1End);
    die3dEl.style.transition = `transform ${duration2}ms cubic-bezier(0.15, 0.95, 0.2, 1)`;
    die3dEl.style.transform = `rotateX(${endRx}deg) rotateY(${endRy}deg) scale3d(${endScale}, ${endScale}, ${endScale})`;

    const onPhase2End = () => {
      die3dEl.removeEventListener("transitionend", onPhase2End);
      die3dCurrent = { rx: rot.rx, ry: rot.ry, scale: endScale };
    };
    die3dEl.addEventListener("transitionend", onPhase2End, { once: true });
  };

  die3dEl.addEventListener("transitionend", onPhase1End, { once: true });
}

function renderDie(face, text, { animate = true } = {}) {
  // Still base orientation on face->a 1..6 pip pattern.
  const faceForPips = Number.isFinite(face) ? face : 1;
  const pipCount = ((faceForPips - 1) % 6) + 1;

  setDieTextOnFaces(text);
  animateDie3dToPip(pipCount, animate);
}

function renderDieFromLast({ animate = false } = {}) {
  const text = typeof state.lastText === "string" && state.lastText ? state.lastText : (state.labels[0] ?? defaultLabel(0));
  const n = state.labels.length;
  let face = state.lastFace;

  if (!Number.isFinite(face) || face < 1 || face > n) {
    const idx = state.labels.findIndex((l) => l === text);
    if (idx >= 0) {
      face = idx + 1;
    } else if (n > 0) {
      // If the rolled text no longer matches current side labels (user edited),
      // still show a deterministic pip pattern based on text.
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      face = (hash % n) + 1;
    } else {
      face = 1;
    }
  }
  renderDie(face, text, { animate });
}

const TRACKING_MODE_KEY = "random_die_tracking_mode_v1";
let trackingMode = "stats";

function setTrackingMode(mode) {
  trackingMode = mode === "render" ? "render" : "stats";

  const statsPanel = $("statsPanel");
  const renderPanel = $("renderPanel");
  const toggleBtn = $("toggleTrackingPanelBtn");
  if (!statsPanel || !renderPanel || !toggleBtn) return;

  const isRender = trackingMode === "render";
  statsPanel.classList.toggle("hidden", isRender);
  renderPanel.classList.toggle("hidden", !isRender);

  toggleBtn.textContent = isRender ? "Show stats" : "Show render";

  if (isRender) renderDieFromLast({ animate: false });
}

function addSide() {
  state.labels.push(defaultLabel(state.labels.length));
  state.counts.push(0);
  saveState();

  renderSideInputs();
  renderCounts();
  renderHistory();
}

function removeSideAtIndex(removeIdx) {
  const MIN_SIDES = 2;
  if (state.labels.length <= MIN_SIDES) return;

  // Remove label + count. History entries are stored as {ts, text}, so we keep them unchanged.
  state.labels.splice(removeIdx, 1);
  state.counts.splice(removeIdx, 1);

  saveState();
  renderSideInputs();
  renderCounts();
  renderHistory();
  $("resultWrap").textContent = "";
  $("rollMeta").textContent = "";
}

function rollOnce() {
  const n = state.labels.length;
  const face = Math.floor(Math.random() * n) + 1;
  const idx = face - 1;

  const text = state.labels[idx] ?? `Side ${face}`;

  state.counts[idx] = (state.counts[idx] ?? 0) + 1;
  const ts = Date.now();
  state.history.push({ ts, text });
  state.lastFace = face;
  state.lastText = text;

  if (state.history.length > state.maxHistory) {
    state.history = state.history.slice(-state.maxHistory);
  }

  saveState();

  renderResult(face, text);
  renderCounts();
  renderHistory();
  if (trackingMode === "render") renderDie(face, text);
}

function resetRolls() {
  state.counts = state.labels.map(() => 0);
  saveState();

  $("resultWrap").textContent = "";
  $("rollMeta").textContent = "";
  renderCounts();
  renderHistory(); // history kept, but totals may change
}

function resetHistory() {
  state.history = [];
  state.lastFace = null;
  state.lastText = "";
  saveState();
  renderHistory();
  if (trackingMode === "render") renderDieFromLast();
}

function refreshFromStorage() {
  loadState();
  normalizeStateAfterLoad();
  renderSideInputs();
  renderCounts();
  renderHistory();
  if (trackingMode === "render") renderDieFromLast({ animate: false });
}

function init() {
  loadState();
  normalizeStateAfterLoad();

  initDie3dFaces();

  renderSideInputs();
  renderCounts();
  renderHistory();
  $("resultWrap").textContent = "";
  $("rollMeta").textContent = `Roll a face from 1..${state.labels.length}.`;

  trackingMode = localStorage.getItem(TRACKING_MODE_KEY) || "stats";
  setTrackingMode(trackingMode);

  $("addSideBtn").addEventListener("click", addSide);
  const rollStatsBtn = $("rollBtnStats");
  if (rollStatsBtn) rollStatsBtn.addEventListener("click", rollOnce);
  const rollRenderBtn = $("rollBtnRender");
  if (rollRenderBtn) rollRenderBtn.addEventListener("click", rollOnce);
  $("resetCounts").addEventListener("click", resetRolls);
  $("resetHistoryBtn").addEventListener("click", resetHistory);

  $("toggleTrackingPanelBtn").addEventListener("click", () => {
    const next = trackingMode === "render" ? "stats" : "render";
    localStorage.setItem(TRACKING_MODE_KEY, next);
    setTrackingMode(next);
  });
}

window.addEventListener("storage", (e) => {
  if (!e || e.key !== STORAGE_KEY) return;
  refreshFromStorage();
});

document.addEventListener("DOMContentLoaded", init);

