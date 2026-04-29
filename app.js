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

const MIN_SIDES = 2;

// Die roll animation tuning (the actual 3D roll)
const DIE_ROLL_DURATION_MULT = 2.35; // bigger = slower/longer roll
const DIE_ROLL_SPINS_MIN = 4; // minimum full spins per axis
const DIE_ROLL_SPINS_MAX = 8; // maximum full spins per axis

// Keyframed roll profile (0..1 timeline)
// - peak time: when we hit max speed (early)
// - stop time: when we fully settle; remainder holds still
// - peak speed: higher => snappier ramp-up (visual "faster" peak)
const ROLL_PEAK_TIME_FRAC = 0.16;
const ROLL_STOP_TIME_FRAC = 0.92;
const ROLL_PEAK_SPEED = 1.0;

// Slight randomness so rolls don't look identical.
const ROLL_RANDOM_PEAK_TIME_JITTER = 0.04;
const ROLL_RANDOM_STOP_TIME_JITTER = 0.04;
const ROLL_RANDOM_PEAK_SPEED_JITTER = 0.25;

// Order matches the DOM in index.html: front, right, back, left, top, bottom.
const FACE_INDEX_BY_PIP = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };

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

function parseSidesFromTextarea(textareaValue) {
  const raw = String(textareaValue ?? "");
  const lines = raw
    .split(/\r?\n/g)
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);

  while (lines.length < MIN_SIDES) lines.push(defaultLabel(lines.length));
  return lines;
}

function applyLabels(nextLabels) {
  const prevCounts = Array.isArray(state.counts) ? state.counts : [];

  state.labels = Array.isArray(nextLabels) ? nextLabels : [];
  while (state.labels.length < MIN_SIDES) state.labels.push(defaultLabel(state.labels.length));

  state.counts = Array.from({ length: state.labels.length }, (_, i) => {
    const c = prevCounts[i];
    return typeof c === "number" && c >= 0 ? c : 0;
  });

  // If the previous "lastFace" no longer exists, drop it.
  if (!Number.isFinite(state.lastFace) || state.lastFace < 1 || state.lastFace > state.labels.length) {
    state.lastFace = null;
  }

  syncDieFaceTextsFromState();
}

/** Restore six default numeric side labels (does not clear roll history). */
function resetSidesToDefault() {
  state.labels = Array.from({ length: 6 }, (_, i) => defaultLabel(i));
  applyLabels(state.labels);
  saveState();
  renderSideInputs();
  renderCounts();
  renderHistory();
  $("rollMeta").textContent = `Roll a face from 1..${state.labels.length}.`;
  if (isDieRollView()) renderDieFromLast({ animate: false });
}

function renderSideInputs() {
  const textarea = $("sideLabels");
  if (!textarea) return;

  const n = state.labels.length;
  $("sidesInfo").textContent = `Current sides: ${n} (one per line)`;

  // Avoid clobbering cursor while user is typing.
  if (document.activeElement !== textarea) {
    const nextValue = state.labels.join("\n");
    if (textarea.value !== nextValue) textarea.value = nextValue;
  }

  if (!textarea.dataset.bound) {
    textarea.dataset.bound = "1";
    textarea.addEventListener("input", () => {
      const nonEmptyCount = String(textarea.value ?? "")
        .split(/\r?\n/g)
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => s.length > 0).length;

      const nextLabels = parseSidesFromTextarea(textarea.value);
      applyLabels(nextLabels);
      saveState();
      renderCounts();
      renderHistory();
      if (isDieRollView()) renderDieFromLast({ animate: false });
      $("rollMeta").textContent = `Roll a face from 1..${state.labels.length}.`;

      const note = nonEmptyCount < MIN_SIDES ? " (need at least 2; missing lines filled with defaults)" : "";
      $("sidesInfo").textContent = `Current sides: ${state.labels.length} (one per line)${note}`;
    });
  }
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

let dieFaceTexts = [];

function getDefaultDieFaceTextsFromState() {
  const faces = state.labels
    .slice(0, 6)
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  while (faces.length < 6) faces.push(defaultLabel(faces.length));
  return faces.slice(0, 6);
}

function setDieFaceTexts(texts) {
  const els = document.querySelectorAll("[data-die3d-text]");
  const arr = Array.isArray(texts) ? texts : [];
  for (let i = 0; i < els.length; i++) {
    els[i].textContent = arr[i] ?? "";
  }
}

function setDieFaceTextAt(faceIdx, text) {
  if (!Number.isFinite(faceIdx) || faceIdx < 0 || faceIdx > 5) return;
  dieFaceTexts[faceIdx] = String(text ?? "");
  setDieFaceTexts(dieFaceTexts);
}

function syncDieFaceTextsFromState() {
  dieFaceTexts = getDefaultDieFaceTextsFromState();
  setDieFaceTexts(dieFaceTexts);
}

function initDie3dFaces() {
  // Set initial per-face text (helps avoid flash of empty faces)
  syncDieFaceTextsFromState();
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

function easeInOutSine(t) {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function clamp01(t) {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  return t;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function makeRollProfileParams() {
  // Randomize slightly per-roll to avoid identical looking rolls.
  const randSigned = () => Math.random() * 2 - 1;

  const peakTime = clamp01(ROLL_PEAK_TIME_FRAC + randSigned() * ROLL_RANDOM_PEAK_TIME_JITTER);
  const stopTime = clamp01(ROLL_STOP_TIME_FRAC + randSigned() * ROLL_RANDOM_STOP_TIME_JITTER);
  const peakSpeed = Math.max(0.15, ROLL_PEAK_SPEED + randSigned() * ROLL_RANDOM_PEAK_SPEED_JITTER);

  // Keep sensible ordering: peak happens before stop.
  const peakTimeClamped = Math.min(0.45, Math.max(0.05, peakTime));
  const stopTimeClamped = Math.min(0.995, Math.max(peakTimeClamped + 0.15, stopTime));

  // How far through the rotation we are by the time we hit peak speed.
  // Higher peakSpeed => reach more progress earlier.
  const peakProgress = clamp01(0.62 + 0.12 * (peakSpeed - 1)); // ~0.50..0.80 typical

  return { peakTime: peakTimeClamped, stopTime: stopTimeClamped, peakSpeed, peakProgress };
}

function rollAngleProgressAt(t, { peakTime, stopTime, peakSpeed, peakProgress }) {
  // 0..1 time -> 0..1 rotation progress
  t = clamp01(t);
  if (t >= stopTime) return 1;

  if (t <= peakTime) {
    const u = t / peakTime; // 0..1
    // peakSpeed > 1 => ramps faster
    const ramp = Math.pow(u, 1 / peakSpeed);
    return peakProgress * ramp;
  }

  const v = (t - peakTime) / (stopTime - peakTime); // 0..1
  // Long slow-down into the final value.
  const easeOut = 1 - Math.pow(1 - v, 3.2);
  return lerp(peakProgress, 1, easeOut);
}

function rollSpeedFracAt(t, { peakTime, stopTime }) {
  // 0..1 time -> 0..1 "speed fraction" (peaks early, decays long)
  t = clamp01(t);
  if (t >= stopTime) return 0;

  const u = t / stopTime; // normalize to the active portion
  const peakU = peakTime / stopTime;

  if (u <= peakU) {
    const a = u / peakU; // 0..1
    return 1 - Math.pow(1 - a, 2.4); // fast rise
  }

  const b = (u - peakU) / (1 - peakU); // 0..1
  return Math.pow(1 - b, 1.35); // long decay
}

function stopDieAnimationIfAny(die3dEl) {
  if (!die3dEl || typeof die3dEl.getAnimations !== "function") return;
  for (const anim of die3dEl.getAnimations()) {
    try {
      anim.cancel();
    } catch {
      // ignore
    }
  }
}

function animateDie3dToPip(pipCount, animate = true) {
  const die3dEl = $("die3d");
  if (!die3dEl) return 0;

  const rot = CUBE_ROTATIONS_BY_PIP[pipCount] || CUBE_ROTATIONS_BY_PIP[1];
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const { rx: startRx, ry: startRy, scale: startScale } = parseCurrentTransformRotation(die3dEl);
  const MIN_SPINS_SUM = DIE_ROLL_SPINS_MIN + DIE_ROLL_SPINS_MIN;
  const MAX_SPINS_SUM = DIE_ROLL_SPINS_MAX + DIE_ROLL_SPINS_MAX;

  if (!animate || reduceMotion) {
    // No toss: keep current scale, snap rotation (no user tracking anyway).
    stopDieAnimationIfAny(die3dEl);
    die3dEl.style.transition = "transform 0ms";
    die3dEl.style.transform = `rotateX(${rot.rx}deg) rotateY(${rot.ry}deg) scale3d(${startScale}, ${startScale}, ${startScale})`;
    die3dCurrent = { rx: rot.rx, ry: rot.ry, scale: startScale };
    return 0;
  }

  // Start from current rotation (smooth), then toss through extra spins.
  const spinsX =
    Math.floor(Math.random() * (DIE_ROLL_SPINS_MAX - DIE_ROLL_SPINS_MIN + 1)) + DIE_ROLL_SPINS_MIN; // min..max
  const spinsY =
    Math.floor(Math.random() * (DIE_ROLL_SPINS_MAX - DIE_ROLL_SPINS_MIN + 1)) + DIE_ROLL_SPINS_MIN; // min..max
  const spinsSum = spinsX + spinsY;
  const speedNorm = (spinsSum - MIN_SPINS_SUM) / (MAX_SPINS_SUM - MIN_SPINS_SUM); // 0..1

  // More speed => slightly faster settle.
  const durationTotal = Math.round((1050 - 420 * speedNorm) * DIE_ROLL_DURATION_MULT); // slower/longer roll

  // Ensure final orientation lands exactly on the selected side (no "snap" settle).
  const endRx = rot.rx + spinsX * 360;
  const endRy = rot.ry + spinsY * 360;

  // Continuous keyframed animation so scale updates dynamically with speed.
  // speedFrac: 0..1 (0 start/end, 1 near mid). scale maps 1..0.5.
  stopDieAnimationIfAny(die3dEl);
  die3dEl.style.transition = "none";

  const steps = 28; // more = smoother dynamic scaling
  const jitterAmp = 70 * (0.4 + 0.6 * speedNorm);
  const profile = makeRollProfileParams();
  const keyframes = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const angleT = rollAngleProgressAt(p, profile);
    const speedFrac = rollSpeedFracAt(p, profile);
    const scale = 1 - 0.5 * speedFrac; // 1x at rest, 0.5x at max "speed"

    // Small wobble that fades out towards the end so we still land exactly.
    const wobbleFade = 1 - p;
    const wobbleX = Math.sin(p * Math.PI * 6) * jitterAmp * wobbleFade;
    const wobbleY = Math.cos(p * Math.PI * 5) * jitterAmp * wobbleFade;

    const rx = startRx + (endRx - startRx) * angleT + wobbleX;
    const ry = startRy + (endRy - startRy) * angleT + wobbleY;

    keyframes.push({
      transform: `rotateX(${rx}deg) rotateY(${ry}deg) scale3d(${scale}, ${scale}, ${scale})`,
      offset: p,
    });
  }

  const anim = die3dEl.animate(keyframes, {
    duration: durationTotal,
    easing: "linear",
    fill: "forwards",
  });

  anim.onfinish = () => {
    // Ensure we end exactly at the target orientation and 1x scale.
    die3dEl.style.transform = `rotateX(${rot.rx}deg) rotateY(${rot.ry}deg) scale3d(1, 1, 1)`;
    die3dCurrent = { rx: rot.rx, ry: rot.ry, scale: 1 };
  };

  return durationTotal;
}

function renderDie(face, text, { animate = true } = {}) {
  // Still base orientation on face->a 1..6 pip pattern.
  const faceForPips = Number.isFinite(face) ? face : 1;
  const pipCount = ((faceForPips - 1) % 6) + 1;

  // Ensure the landing side text appears on the face that ends up at the front.
  const faceIdx = FACE_INDEX_BY_PIP[pipCount] ?? 0;
  setDieFaceTextAt(faceIdx, text);
  return animateDie3dToPip(pipCount, animate);
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

function queryToggleButtons() {
  return document.querySelectorAll("[data-toggle-panel]");
}

function setToggleButtonsText(text) {
  queryToggleButtons().forEach((btn) => {
    btn.textContent = text;
  });
}

function syncMobileTapHint() {
  const el = $("mobileTapToRollHint");
  if (!el) return;
  if (!isMobileLayout() || !document.body.classList.contains("mobile-roll-view")) {
    el.textContent = "Tap to Roll!";
    return;
  }
  el.textContent = isRolling ? "Rolling…" : "Tap to Roll!";
}

const MOBILE_MQ = window.matchMedia("(max-width: 900px)");

function isMobileLayout() {
  return MOBILE_MQ.matches;
}

/** Mobile: false = roll (die), true = configure + history only */
let mobileConfigOpen = false;

/** Config + history nodes live in #mobileConfigSheet while on mobile layout */
let mobileDomMigrated = false;

function restoreDesktopDomLayout() {
  if (!mobileDomMigrated) return;
  const layout = document.querySelector(".layout");
  const sheet = $("mobileConfigSheet");
  const cfg = document.querySelector(".config-card");
  const hist = document.querySelector(".mobile-history-block");
  const statsPanel = $("statsPanel");
  const rollCard = document.querySelector(".roll-card");
  if (!layout || !sheet || !cfg || !hist || !statsPanel || !rollCard) return;

  if (cfg.parentElement !== layout) layout.insertBefore(cfg, rollCard);
  if (hist.parentElement !== statsPanel) statsPanel.appendChild(hist);
  mobileDomMigrated = false;
  sheet.setAttribute("aria-hidden", "true");
}

function ensureMobileDomLayout() {
  if (!isMobileLayout() || mobileDomMigrated) return;
  const sheet = $("mobileConfigSheet");
  const cfg = document.querySelector(".config-card");
  const hist = document.querySelector(".mobile-history-block");
  if (!sheet || !cfg || !hist) return;
  sheet.append(cfg, hist);
  mobileDomMigrated = true;
}

function isDieRollView() {
  return (isMobileLayout() && !mobileConfigOpen) || (!isMobileLayout() && trackingMode === "render");
}

function applyMobileShell() {
  if (!isMobileLayout()) {
    restoreDesktopDomLayout();
    document.body.classList.remove("mobile-roll-view", "mobile-config-view");
    return;
  }

  ensureMobileDomLayout();

  const statsPanel = $("statsPanel");
  const renderPanel = $("renderPanel");
  const sheet = $("mobileConfigSheet");
  if (!statsPanel || !renderPanel || !sheet) return;

  statsPanel.classList.add("hidden");

  if (!mobileConfigOpen) {
    document.body.classList.add("mobile-roll-view");
    document.body.classList.remove("mobile-config-view");
    renderPanel.classList.remove("hidden");
    setToggleButtonsText("Configure");
    renderDieFromLast({ animate: false });
    syncMobileTapHint();
    sheet.setAttribute("aria-hidden", "true");
  } else {
    document.body.classList.remove("mobile-roll-view");
    document.body.classList.add("mobile-config-view");
    renderPanel.classList.add("hidden");
    setToggleButtonsText("View die");
    syncMobileTapHint();
    sheet.setAttribute("aria-hidden", "false");
  }
}

function setTrackingMode(mode) {
  trackingMode = mode === "render" ? "render" : "stats";

  const statsPanel = $("statsPanel");
  const renderPanel = $("renderPanel");
  if (!statsPanel || !renderPanel) return;

  const isRender = trackingMode === "render";
  statsPanel.classList.toggle("hidden", isRender);
  renderPanel.classList.toggle("hidden", !isRender);

  setToggleButtonsText(isRender ? "Show stats" : "Show render");

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

let isRolling = false;

function setRollButtonsDisabled(disabled) {
  const rollStatsBtn = $("rollBtnStats");
  const rollRenderBtn = $("rollBtnRender");
  if (rollStatsBtn) rollStatsBtn.disabled = !!disabled;
  if (rollRenderBtn) rollRenderBtn.disabled = !!disabled;
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
  if (isDieRollView()) renderDie(face, text);
}

function rollWithAnimation() {
  if (isRolling) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reduceMotion || !isDieRollView()) {
    rollOnce();
    syncMobileTapHint();
    return;
  }

  // Pick final outcome first; the die roll animation is what takes time.
  const n = state.labels.length;
  const face = Math.floor(Math.random() * n) + 1;
  const idx = face - 1;
  const text = state.labels[idx] ?? `Side ${face}`;

  isRolling = true;
  setRollButtonsDisabled(true);
  syncMobileTapHint();

  $("resultWrap").textContent = "Rolling…";
  $("rollMeta").textContent = "";

  // If this side isn't currently shown on any of the 6 cube faces, swap it in on a random face
  // while rolling, so you can actually see it.
  if (!dieFaceTexts.includes(text)) {
    const randomFaceIdx = Math.floor(Math.random() * 6);
    setDieFaceTextAt(randomFaceIdx, text);
  }

  // Animate the die landing on the chosen face.
  const durationMs = renderDie(face, text, { animate: true });
  const settleMs = Math.max(0, Number(durationMs) || 0) + 30;

  window.setTimeout(() => {
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

    setRollButtonsDisabled(false);
    isRolling = false;
    syncMobileTapHint();
  }, settleMs);
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
  if (isDieRollView()) renderDieFromLast();
}

function refreshFromStorage() {
  loadState();
  normalizeStateAfterLoad();
  renderSideInputs();
  renderCounts();
  renderHistory();
  if (isMobileLayout()) {
    applyMobileShell();
  } else if (trackingMode === "render") {
    renderDieFromLast({ animate: false });
  }
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

  // Default to the render tab (unless user already chose a preference).
  trackingMode = localStorage.getItem(TRACKING_MODE_KEY) || "render";
  if (isMobileLayout()) {
    mobileConfigOpen = false;
    applyMobileShell();
  } else {
    setTrackingMode(trackingMode);
  }
  syncMobileTapHint();

  MOBILE_MQ.addEventListener("change", () => {
    if (isMobileLayout()) {
      mobileConfigOpen = false;
      applyMobileShell();
    } else {
      restoreDesktopDomLayout();
      document.body.classList.remove("mobile-roll-view", "mobile-config-view");
      setTrackingMode(trackingMode);
    }
    syncMobileTapHint();
  });

  const rollStatsBtn = $("rollBtnStats");
  if (rollStatsBtn) rollStatsBtn.addEventListener("click", rollWithAnimation);
  const rollRenderBtn = $("rollBtnRender");
  if (rollRenderBtn) rollRenderBtn.addEventListener("click", rollWithAnimation);
  $("resetCounts").addEventListener("click", resetRolls);
  $("resetHistoryBtn").addEventListener("click", resetHistory);
  const resetSidesBtn = $("resetSidesBtn");
  if (resetSidesBtn) resetSidesBtn.addEventListener("click", resetSidesToDefault);

  queryToggleButtons().forEach((btn) => {
    btn.addEventListener("click", () => {
      if (isMobileLayout()) {
        mobileConfigOpen = !mobileConfigOpen;
        applyMobileShell();
        return;
      }
      const next = trackingMode === "render" ? "stats" : "render";
      localStorage.setItem(TRACKING_MODE_KEY, next);
      setTrackingMode(next);
    });
  });

  const rollCard = document.querySelector(".roll-card");
  rollCard?.addEventListener("click", (e) => {
    if (!isMobileLayout() || !document.body.classList.contains("mobile-roll-view")) return;
    if (isRolling) return;
    if (e.target.closest("[data-toggle-panel]")) return;
    rollWithAnimation();
  });
}

window.addEventListener("storage", (e) => {
  if (!e || e.key !== STORAGE_KEY) return;
  refreshFromStorage();
});

document.addEventListener("DOMContentLoaded", init);

