import * as THREE from "three";

const STORAGE_KEY = "random_die_v2";

// Multi-die model:
// - state.dice: [{ labels: string[], counts: number[], lastFace: number|null, lastText: string }]
// - state.history: [{ ts, results: [{ die, face, text }] }]
let state = {
  dice: [],
  history: [],
  maxHistory: 50,
};

const $ = (id) => document.getElementById(id);

const MIN_SIDES = 2;

// Die roll animation tuning (the actual 3D roll)
const DIE_ROLL_DURATION_MULT = 3; // bigger = slower/longer roll
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

/** At full stress u=1, die body lerps this far toward white. */
const ROLL_SPIN_WHITE_BLEND_MAX = 0.5;
/** >1 slows stress buildup toward white. */
const ROLL_SPIN_STRESS_RAMP_POWER = 1.55;
/**
 * After text onset (see ROLL_STRESS_TEXT_OMEGA_START_MULT), full label fade is reached over this fraction
 * of the remaining ω span up to body `hi`. <1 ⇒ labels hit full fade before body goes fully white; >1 ⇒ later.
 */
const ROLL_SPIN_TEXT_THRESHOLD_MULT = 0.5;
/** |dθ/dt| (rad/s) where body whiteness begins rising. */
const ROLL_STRESS_OMEGA_START_RAD_S = 128;
/** |dθ/dt| (rad/s) where body whiteness reaches full (before smoothstep/power). */
const ROLL_STRESS_OMEGA_FULL_RAD_S = 256;
/**
 * Label ramp onset = body onset × this (same rad/s scale). 1 = same lower threshold as whiteness;
 * <1 = text starts fading earlier; >1 = text stays opaque longer at low speed.
 */
const ROLL_STRESS_TEXT_OMEGA_START_MULT = 1;
/** Lerp each frame toward raw u / uText (analytic spin rate is already smooth; keep small for extra stability). */
const ROLL_STRESS_U_SMOOTH_ALPHA = 0.22;
/** Centrifugal warp ramp vs same measured |ω| (rad/s), global — not spin count or duration. */
const ROLL_CENTRIFUGAL_OMEGA_LO_RAD_S = 512;
const ROLL_CENTRIFUGAL_OMEGA_HI_RAD_S = 6400;
/** Chain re-rolls: multiply prior spinVelMul each time (capped). */
const ROLL_CHAIN_VEL_MUL_STEP = 1.1;
const ROLL_CHAIN_VEL_MUL_MAX = 5.5;
/** Each chain re-roll multiplies spinChainAmp (capped). */
const ROLL_CHAIN_SPIN_AMP_STEP = 0.13;
const ROLL_CHAIN_SPIN_AMP_MAX = 1.7;
/**
 * Centrifugal warp: local X/Z (⊥ spin) expand by these fractions at drive=1; local Y is derived so volume stays ~constant.
 * Spin axis maps to local +Y after aligning `spinDeformGroup`; U = local X, V = local Z.
 */
const ROLL_CENTRIFUGAL_TRANSVERSE_U_MAX = 0.5;
const ROLL_CENTRIFUGAL_TRANSVERSE_V_MAX = 0.5;
/** If true, axial scale Y = 1/((1+bu)(1+bv)). If false, use ROLL_CENTRIFUGAL_AXIAL_SCALE_PER_DRIVE instead. */
const ROLL_CENTRIFUGAL_AXIAL_VOLUME_PRESERVE = true;
/** When volume preserve is off: Y scale at drive=1 (typically < 1 squash). Ignored if AXIAL_VOLUME_PRESERVE. */
const ROLL_CENTRIFUGAL_AXIAL_SCALE_AT_FULL = 0.1;

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

function ensureDiceArray() {
  if (!Array.isArray(state.dice)) state.dice = [];
  if (state.dice.length === 0) {
    state.dice = [{ labels: Array.from({ length: 6 }, (_, i) => defaultLabel(i)), counts: [], lastFace: null, lastText: "" }];
  }
}

function normalizeStateAfterLoad() {
  // Migration / defaults from older single-die storage.
  if (!Array.isArray(state.dice) || state.dice.length === 0) {
    const legacyLabels = Array.isArray(state.labels) ? state.labels : [];
    const legacyCounts = Array.isArray(state.counts) ? state.counts : [];
    const legacyLastFace = Number.isFinite(state.lastFace) ? state.lastFace : null;
    const legacyLastText = typeof state.lastText === "string" ? state.lastText : "";

    const labels =
      legacyLabels.length > 0 ? legacyLabels : Array.from({ length: 6 }, (_, i) => defaultLabel(i));

    state.dice = [
      {
        labels,
        counts: legacyCounts,
        lastFace: legacyLastFace,
        lastText: legacyLastText,
      },
    ];
  }

  ensureDiceArray();

  // Normalize each die
  for (const die of state.dice) {
    if (!die || typeof die !== "object") continue;
    if (!Array.isArray(die.labels) || die.labels.length === 0) {
      die.labels = Array.from({ length: 6 }, (_, i) => defaultLabel(i));
    }
    die.labels = die.labels.map((v, i) => {
      const s = typeof v === "string" ? v.trim() : "";
      return s.length ? s : defaultLabel(i);
    });
    while (die.labels.length < MIN_SIDES) die.labels.push(defaultLabel(die.labels.length));

    const counts = Array.isArray(die.counts) ? die.counts : [];
    die.counts = Array.from({ length: die.labels.length }, (_, i) => {
      const c = counts[i];
      return typeof c === "number" && c >= 0 ? c : 0;
    });

    die.lastFace = Number.isFinite(die.lastFace) ? die.lastFace : null;
    die.lastText = typeof die.lastText === "string" ? die.lastText : "";
  }

  // Migrate history entries to {ts, results:[...]} and prune
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history = state.history
    .map((h) => {
      if (!h || typeof h !== "object") return null;

      const ts = typeof h.ts === "number" ? h.ts : Date.now();

      if (Array.isArray(h.results)) {
        const results = h.results
          .map((r) => {
            if (!r || typeof r !== "object") return null;
            const die = typeof r.die === "number" ? r.die : 0;
            const face = typeof r.face === "number" ? r.face : null;
            const text = typeof r.text === "string" ? r.text : "";
            if (!text) return null;
            return { die, face, text };
          })
          .filter(Boolean);
        if (!results.length) return null;
        return { ts, results };
      }

      if (typeof h.text === "string") {
        return { ts, results: [{ die: 0, face: null, text: h.text }] };
      }

      // Backwards-compat for older version: {ts, face}
      if (typeof h.face === "number") {
        const idx = h.face - 1;
        const text = state.dice?.[0]?.labels?.[idx] ?? defaultLabel(idx);
        return { ts, results: [{ die: 0, face: h.face, text }] };
      }

      return null;
    })
    .filter(Boolean)
    .slice(-state.maxHistory);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    // New model
    if (Array.isArray(parsed.dice)) state.dice = parsed.dice;
    if (Array.isArray(parsed.history)) state.history = parsed.history;
    if (typeof parsed.maxHistory === "number") state.maxHistory = parsed.maxHistory;

    // Backwards-compat: keep legacy fields for normalizeStateAfterLoad() migration
    if (Array.isArray(parsed.labels)) state.labels = parsed.labels;
    if (Array.isArray(parsed.counts)) state.counts = parsed.counts;
    if (typeof parsed.lastFace === "number") state.lastFace = parsed.lastFace;
    if (typeof parsed.lastText === "string") state.lastText = parsed.lastText;
    if (typeof parsed.sides === "number" && !Array.isArray(state.labels)) {
      const n = clampInt(parsed.sides, 2, 1000);
      state.labels = Array.from({ length: n }, (_, i) => defaultLabel(i));
    }
  } catch {
    // Corrupted storage: ignore and use defaults
  }
}

function parseDiceFromTextarea(textareaValue) {
  const raw = String(textareaValue ?? "");
  const lines = raw.split(/\r?\n/g).map((s) => (typeof s === "string" ? s.trim() : ""));

  const groups = [];
  let cur = [];
  for (const line of lines) {
    if (!line) {
      if (cur.length) {
        groups.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length) groups.push(cur);

  // If user cleared everything, keep one default die.
  if (!groups.length) groups.push([]);

  return groups.map((labels) => {
    const cleaned = labels.filter((s) => s && s.trim().length).map((s) => s.trim());
    while (cleaned.length < MIN_SIDES) cleaned.push(defaultLabel(cleaned.length));
    return cleaned;
  });
}

function applyDiceLabels(nextDiceLabels) {
  if (anyDiceRollingVisual()) cancelInFlightRoll();
  ensureDiceArray();
  const next = Array.isArray(nextDiceLabels) ? nextDiceLabels : [];
  if (!next.length) next.push(Array.from({ length: 6 }, (_, i) => defaultLabel(i)));

  state.dice = next.map((labels, dieIdx) => {
    const prev = state.dice[dieIdx] || {};
    const prevCounts = Array.isArray(prev.counts) ? prev.counts : [];
    const nextLabels = Array.isArray(labels) ? labels : [];
    while (nextLabels.length < MIN_SIDES) nextLabels.push(defaultLabel(nextLabels.length));

    const counts = Array.from({ length: nextLabels.length }, (_, i) => {
      const c = prevCounts[i];
      return typeof c === "number" && c >= 0 ? c : 0;
    });

    const lastFace = Number.isFinite(prev.lastFace) ? prev.lastFace : null;
    const lastText = typeof prev.lastText === "string" ? prev.lastText : "";

    return { labels: nextLabels, counts, lastFace, lastText };
  });

  syncAllDiceFaceTextsFromState();
}

/** Restore to a single default die (Side 1..Side 6). */
function resetSidesToDefault() {
  if (anyDiceRollingVisual()) cancelInFlightRoll();
  state.dice = [{ labels: Array.from({ length: 6 }, (_, i) => defaultLabel(i)), counts: [], lastFace: null, lastText: "" }];
  normalizeStateAfterLoad();
  syncAllDiceFaceTextsFromState();
  saveState();
  renderSideInputs();
  renderCounts();
  renderHistory();
  $("rollMeta").textContent = "";
  if (isDieRollView()) renderDiceFromLast({ animate: false });
}

function renderSideInputs() {
  const textarea = $("sideLabels");
  if (!textarea) return;

  ensureDiceArray();
  const dice = state.dice;
  const sidesSummary = dice.map((d) => d.labels.length).join(", ");
  $("sidesInfo").textContent = `Current dice: ${dice.length} — sides: ${sidesSummary} (blank line = new die; lines starting with "-" are ignored for rolls)`;

  // Avoid clobbering cursor while user is typing.
  if (document.activeElement !== textarea) {
    const nextValue = dice.map((d) => d.labels.join("\n")).join("\n\n");
    if (textarea.value !== nextValue) textarea.value = nextValue;
  }

  if (!textarea.dataset.bound) {
    textarea.dataset.bound = "1";
    textarea.addEventListener("input", () => {
      const nextDice = parseDiceFromTextarea(textarea.value);
      applyDiceLabels(nextDice);
      saveState();
      renderCounts();
      renderHistory();
      if (isDieRollView()) renderDiceFromLast({ animate: false });
      $("rollMeta").textContent = "";

      const summary = state.dice.map((d) => d.labels.length).join(", ");
      $("sidesInfo").textContent = `Current dice: ${state.dice.length} — sides: ${summary} (blank line = new die; lines starting with "-" are ignored for rolls)`;
    });
  }
}

function renderCounts() {
  ensureDiceArray();
  const wrap = $("countsTables");

  let grandTotal = 0;

  if (wrap) {
    wrap.innerHTML = "";

    state.dice.forEach((die, dieIdx) => {
      const total = (die.counts || []).reduce((a, b) => a + (b || 0), 0);
      grandTotal += total;

      const card = document.createElement("div");
      card.className = "counts-table-card";

      const title = document.createElement("div");
      title.className = `counts-table-title die-color-${dieIdx % 8}`;
      title.textContent = `Die ${dieIdx + 1}`;

      const table = document.createElement("table");
      table.innerHTML = `
      <thead>
        <tr>
          <th>Side</th>
          <th>Text</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
      const tbody = table.querySelector("tbody");
      for (let i = 0; i < die.labels.length; i++) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escapeHtml(die.labels[i])}</td>
        <td>${die.counts[i] ?? 0}</td>
      `;
        tbody.appendChild(tr);
      }

      card.appendChild(title);
      card.appendChild(table);
      wrap.appendChild(card);
    });
  } else {
    grandTotal = state.dice.reduce((sum, die) => sum + (die.counts || []).reduce((a, b) => a + (b || 0), 0), 0);
  }

  const totalsEl = $("totals");
  if (totalsEl) totalsEl.textContent = `Total rolls (all dice): ${grandTotal}`;
  renderPerDieRollButtons();
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";

  const historyBlock = box?.closest?.(".mobile-history-block");

  if (!state.history.length) {
    box.innerHTML = `<div class="muted">No rolls yet.</div>`;
    historyBlock?.classList.remove("history-grow-1", "history-grow-2", "history-grow-3");
    historyBlock?.classList.add("history-grow-0");
    syncMobileRemoveSidesBtn();
    return;
  }

  const items = [...state.history].sort((a, b) => b.ts - a.ts);
  const n = items.length;

  // Grow history panel gradually as it accumulates items, instead of immediately
  // claiming its full share of vertical space after the first roll.
  if (historyBlock) {
    historyBlock.classList.remove("history-grow-0", "history-grow-1", "history-grow-2", "history-grow-3");
    if (n <= 3) historyBlock.classList.add("history-grow-1");
    else if (n <= 8) historyBlock.classList.add("history-grow-2");
    else historyBlock.classList.add("history-grow-3");
  }

  for (const h of items) {
    const div = document.createElement("div");
    div.className = "hist-item";
    const results = Array.isArray(h.results) ? h.results : [];
    const msg = results.length
      ? results
          .map((r) => r?.text ?? "")
          .filter(Boolean)
          .join(", ")
      : "";
    div.textContent = `${new Date(h.ts).toLocaleString()} — ${msg || "—"}`;
    box.appendChild(div);
  }
  syncMobileRemoveSidesBtn();
}

function dieName(dieIdx) {
  const names = ["Red", "Blue", "Yellow", "Green", "Purple", "Orange", "Teal", "Pink"];
  return names[dieIdx] ?? `Die ${dieIdx + 1}`;
}

function renderResult(results) {
  const arr = Array.isArray(results) ? results : [];
  if (!arr.length) {
    $("resultWrap").textContent = "";
    $("rollMeta").textContent = "";
    return;
  }

  const multi = Array.isArray(state.dice) && state.dice.length > 1;
  const partial = multi && arr.length < state.dice.length;

  let summaryLine;
  if (partial) {
    const textByDie = new Map(arr.map((r) => [r.die, r.text]));
    summaryLine = state.dice
      .map((die, i) => {
        if (textByDie.has(i)) return textByDie.get(i);
        const labels = Array.isArray(die?.labels) ? die.labels : [];
        const kept =
          typeof die?.lastText === "string" && die.lastText.length ? die.lastText : getLabelTextForMeshFace(labels, 0);
        return kept;
      })
      .join(", ");
  } else {
    summaryLine = arr.map((r) => r.text).join(", ");
  }

  $("resultWrap").textContent = `You rolled: ${summaryLine}`;
  const shouldHideMeta = isMobileLayout() || (Array.isArray(state.dice) && state.dice.length > 2);
  if (shouldHideMeta) {
    $("rollMeta").textContent = "";
  } else {
    $("rollMeta").textContent = arr
      .map((r) => {
        const die = state.dice?.[r.die];
        const idx = (r.face ?? 1) - 1;
        const c = die?.counts?.[idx] ?? 0;
        return `${dieName(r.die)} face ${r.face} — rolled ${c} time(s).`;
      })
      .join("   ");
  }
}

// --- Three.js polyhedral renderer (D4/D6/D8/D10/D12/D20) ---
let threeCtx = null;

/** Mobile roll view: skip bubbling roll-card tap after the canvas handled roll / ignore gesture. */
let suppressMobileRollCardTap = false;

const MOBILE_SWIPE_IGNORE_LAST_SIDE_MIN_PX = 52;
const MOBILE_SWIPE_IGNORE_DOMINANCE_RATIO = 1.15;
/** Tap vs drag: movement within this box counts as tap (die roll target from pointer-down pick). */
const DIE_CANVAS_TAP_MAX_PX = 26;
const DIE_CANVAS_SWIPE_UP_MIN_PX = 52;
const DIE_CANVAS_SWIPE_UP_DOMINANCE_RATIO = 1.15;

const _diePickNdca = new THREE.Vector2();
const _diePickRaycaster = new THREE.Raycaster();

const SUPPORTED_DICE_SIDES = [2, 4, 6, 8, 10, 12, 20];
const DIE_COLORS = [
  0xe14b4b, // red
  0x4b86ff, // blue
  0xf2c94c, // yellow
  0x34c26a, // green
  0xa96bff, // purple
  0xff944b, // orange
  0x2fd2c9, // teal
  0xff5fa2, // pink
];

const FACE_TEXT_SCALE = 1.5; // +50% for all faces
const FACE_TEXT_WIN_SCALE = 1.5; // additional +50% when selected

const labelTextureCache = new Map(); // key -> THREE.Texture

function getDieHexColor(dieIdx) {
  return DIE_COLORS[dieIdx % DIE_COLORS.length] ?? 0x8cafFF;
}

function smoothstep01(x) {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

const _cfYUp = new THREE.Vector3(0, 1, 0);
const _cfInvParentQ = new THREE.Quaternion();
const _cfLocalSpinAxis = new THREE.Vector3();
const _cfAlignTarget = new THREE.Quaternion();
const _cfIdent = new THREE.Quaternion();

function resetDieRollingVisuals(ctx, dieIdx) {
  const d = ctx?.dice?.[dieIdx];
  if (!d?.mesh?.material?.color) return;
  const hex = d.mesh.userData.baseDieColorHex ?? getDieHexColor(dieIdx);
  d.mesh.material.color.setHex(hex);
  if (d.spinDeformGroup) {
    d.spinDeformGroup.scale.set(1, 1, 1);
    d.spinDeformGroup.quaternion.identity();
  }
  for (const plane of d.labelPlanes || []) {
    if (plane?.material) {
      plane.material.opacity = 1;
      plane.material.transparent = true;
    }
  }
}

/**
 * |dθ/dt| for the tumble extra angle θ = (1−e)^1.001 × K with e = easeOutCubic(p), p = t/dur.
 * Analytic derivative avoids finite-difference + wrapToPi noise (wobbling white/warp/text at high speed).
 */
function analyticTumbleSpinRateRadS(anim, nowMs, velMul, chainAmp) {
  const durMs = Math.max(1, anim.dur);
  const p = THREE.MathUtils.clamp((nowMs - anim.t0) / durMs, 0, 1);
  const K = Math.max(0, anim.spins || 0) * (Math.PI * 2) * Math.max(0, velMul) * Math.max(1, chainAmp);
  if (p >= 1 - 1e-9 || K <= 0) return 0;
  const dpdt = 1000 / durMs;
  const oneMinusP = 1 - p;
  const depdp = 3 * oneMinusP * oneMinusP;
  const e = 1 - oneMinusP * oneMinusP * oneMinusP;
  const oneMinusE = 1 - e;
  const dDecayDe = -1.001 * Math.pow(Math.max(1e-12, oneMinusE), 0.001);
  const dThetadt = K * dDecayDe * depdp * dpdt;
  return Math.abs(dThetadt);
}

/** Body + label stress from tumble spin rate (rad/s). */
function computeRollingStressFromOmega(omega, textMult) {
  if (omega == null || !Number.isFinite(omega) || omega <= 0) {
    return { u: 0, uText: 0 };
  }
  const lo = ROLL_STRESS_OMEGA_START_RAD_S;
  const hi = ROLL_STRESS_OMEGA_FULL_RAD_S;
  const span = Math.max(1e-6, hi - lo);
  const loText = THREE.MathUtils.clamp(
    lo * Math.max(0.05, ROLL_STRESS_TEXT_OMEGA_START_MULT),
    1e-6,
    hi - 1e-6
  );
  const spanTextRemain = Math.max(1e-6, hi - loText);
  const hiText = loText + spanTextRemain * Math.max(0.05, textMult);
  const uLinearBody = THREE.MathUtils.clamp((omega - lo) / span, 0, 1);
  const uLinearText = THREE.MathUtils.clamp((omega - loText) / Math.max(1e-6, hiText - loText), 0, 1);
  const u = Math.pow(smoothstep01(uLinearBody), ROLL_SPIN_STRESS_RAMP_POWER);
  const uText = Math.pow(smoothstep01(uLinearText), ROLL_SPIN_STRESS_RAMP_POWER);
  return { u, uText };
}

function centrifugalWarpRampFromOmega(omega) {
  if (omega == null || !Number.isFinite(omega) || omega <= 0) return 0;
  const lo = ROLL_CENTRIFUGAL_OMEGA_LO_RAD_S;
  const hi = ROLL_CENTRIFUGAL_OMEGA_HI_RAD_S;
  return THREE.MathUtils.clamp((omega - lo) / Math.max(1e-6, hi - lo), 0, 1);
}

/**
 * Centrifugal warp: expand local X (U) and Z (V) by bu,bv; shrink local Y (spin axis) for volume or fixed axial curve.
 * Child `spinDeformGroup`: local +Y ↔ spin axis after alignment. Drive = smoothed stress u × warp ramp(|ω|).
 */
function applyRollingCentrifugalDeform(d, anim, precomputed) {
  const g = d?.spinDeformGroup;
  if (!g) return;
  const { u, peakRamp } = precomputed;
  if (u <= 0) {
    g.scale.set(1, 1, 1);
    g.quaternion.identity();
    return;
  }
  const drive = u * peakRamp;
  if (drive <= 0) {
    g.scale.set(1, 1, 1);
    g.quaternion.identity();
    return;
  }
  const bu = ROLL_CENTRIFUGAL_TRANSVERSE_U_MAX * drive;
  const bv = ROLL_CENTRIFUGAL_TRANSVERSE_V_MAX * drive;
  const sx = 1 + bu;
  const sz = 1 + bv;
  let sy;
  if (ROLL_CENTRIFUGAL_AXIAL_VOLUME_PRESERVE) {
    sy = 1 / (sx * sz);
  } else {
    sy = THREE.MathUtils.lerp(1, ROLL_CENTRIFUGAL_AXIAL_SCALE_AT_FULL, drive);
  }

  _cfInvParentQ.copy(anim.obj.quaternion).invert();
  _cfLocalSpinAxis.copy(anim.axis).normalize().applyQuaternion(_cfInvParentQ);
  _cfAlignTarget.setFromUnitVectors(_cfYUp, _cfLocalSpinAxis);
  const kBlend = Math.max(bu, bv);
  const alignRef =
    Math.max(ROLL_CENTRIFUGAL_TRANSVERSE_U_MAX, ROLL_CENTRIFUGAL_TRANSVERSE_V_MAX) * 0.22;
  const alignBlend = THREE.MathUtils.smoothstep(kBlend / alignRef, 0, 1);
  g.quaternion.slerpQuaternions(_cfIdent, _cfAlignTarget, alignBlend);

  g.scale.set(sx, sy, sz);
}

function applyRollingVisualStress(ctx, dieIdx, u, uText) {
  const d = ctx?.dice?.[dieIdx];
  if (!d?.mesh?.material?.color) return;
  const baseHex = d.mesh.userData.baseDieColorHex ?? getDieHexColor(dieIdx);
  const base = new THREE.Color().setHex(baseHex);
  const white = new THREE.Color(0xffffff);
  d.mesh.material.color.copy(base).lerp(white, u * ROLL_SPIN_WHITE_BLEND_MAX);
  const textOpacity = 1 - uText;
  for (const plane of d.labelPlanes || []) {
    if (plane?.material) {
      plane.material.opacity = textOpacity;
      plane.material.transparent = true;
    }
  }
}

/** Vertices 8 and 9 are the two poles (each touches 5 faces). Shorten pole-to-pole only (common tabletop D10 look); kites stay kite-shaped. */
const D10_POLE_SQUASH = 0.66;

function applyD10PoleAxisSquash(positionAttr, poleA, poleB, squash) {
  const pos = positionAttr;
  const n = pos.count;
  if (n <= Math.max(poleA, poleB)) return;

  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  for (const p of pts) {
    p.x -= cx;
    p.y -= cy;
    p.z -= cz;
  }

  const axis = new THREE.Vector3().subVectors(pts[poleB], pts[poleA]);
  if (axis.lengthSq() < 1e-8) return;
  axis.normalize();

  for (let i = 0; i < n; i++) {
    const s = pts[i].dot(axis);
    pts[i].addScaledVector(axis, s * (squash - 1));
  }

  cx = 0;
  cy = 0;
  cz = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    pos.setXYZ(i, p.x - cx, p.y - cy, p.z - cz);
  }
  pos.needsUpdate = true;
}

/** Pentagon trapezohedron (standard D10): 10 congruent kite faces (4 verts each). Vertex data from dmccooey.com/polyhedra/PentagonalTrapezohedron */
function createPentagonalTrapezohedronGeometry() {
  const sqrt5 = Math.sqrt(5);
  const C0 = (sqrt5 - 1) / 4;
  const C1 = (1 + sqrt5) / 4;
  const C2 = (3 + sqrt5) / 4;

  const verts = [
    [0, C0, C1],
    [0, C0, -C1],
    [0, -C0, C1],
    [0, -C0, -C1],
    [0.5, 0.5, 0.5],
    [0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [-0.5, -0.5, -0.5],
    [C2, -C1, 0],
    [-C2, C1, 0],
    [C0, C1, 0],
    [-C0, -C1, 0],
  ];

  const faces = [
    [8, 2, 6, 11],
    [8, 11, 7, 3],
    [8, 3, 1, 5],
    [8, 5, 10, 4],
    [8, 4, 0, 2],
    [9, 0, 4, 10],
    [9, 10, 5, 1],
    [9, 1, 3, 7],
    [9, 7, 11, 6],
    [9, 6, 2, 0],
  ];

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0];
    positions[i * 3 + 1] = verts[i][1];
    positions[i * 3 + 2] = verts[i][2];
  }

  const indices = [];
  for (const f of faces) {
    const [a, b, c, d] = f;
    indices.push(a, b, c, a, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  applyD10PoleAxisSquash(geometry.attributes.position, 8, 9, D10_POLE_SQUASH);
  geometry.computeVertexNormals();
  return geometry;
}

/** Thin cylinder (axis +Y); caps used as the two outcomes for clustering / labels. */
function createCoinGeometry() {
  const geo = new THREE.CylinderGeometry(1, 1, 0.15, 64, 1, false);
  geo.computeVertexNormals();
  return geo;
}

/** Two logical faces (+Y cap / −Y cap) for physics & labels without merging the rim band. */
function computeCoinCapsFeatures(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const inset = Math.max((bb.max.y - bb.min.y) * 0.06, 0.004);
  return [
    { normal: new THREE.Vector3(0, 1, 0), center: new THREE.Vector3(0, bb.max.y - inset, 0) },
    { normal: new THREE.Vector3(0, -1, 0), center: new THREE.Vector3(0, bb.min.y + inset, 0) },
  ];
}

function getGeometryForSides(n) {
  // Return { geometry, faceCount, faceLayout }; clusters except coin caps are analytic.
  switch (n) {
    case 2:
      return { geometry: createCoinGeometry(), faceCount: 2, faceLayout: "coin" };
    case 4:
      return { geometry: new THREE.TetrahedronGeometry(1, 0), faceCount: 4, faceLayout: "clusters" };
    case 6:
      return { geometry: new THREE.BoxGeometry(1, 1, 1), faceCount: 6, faceLayout: "clusters" };
    case 8:
      return { geometry: new THREE.OctahedronGeometry(1, 0), faceCount: 8, faceLayout: "clusters" };
    case 10:
      return {
        geometry: createPentagonalTrapezohedronGeometry(),
        faceCount: 10,
        faceLayout: "clusters",
      };
    case 12:
      return { geometry: new THREE.DodecahedronGeometry(1, 0), faceCount: 12, faceLayout: "clusters" };
    case 20:
      return { geometry: new THREE.IcosahedronGeometry(1, 0), faceCount: 20, faceLayout: "clusters" };
    default:
      return { geometry: new THREE.BoxGeometry(1, 1, 1), faceCount: 6, faceLayout: "clusters" };
  }
}

/** Non-disabled lines only (in config order); "-" prefixes define disabled sides. */
function getActiveFaceSlots(labels) {
  const arr = Array.isArray(labels) ? labels : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (!isSideLabelDisabled(arr[i])) out.push({ origIdx: i, text: arr[i] });
  }
  return out;
}

/**
 * Polyhedron size from number of **eligible** sides (ignored "-" lines do not count).
 * 1–2 → coin (2 faces); 3 → D4; then standard ladder.
 */
function getSidesForDieCount(m) {
  const n = Math.max(0, m | 0);
  if (n >= 20) return 20;
  if (n >= 12) return 12;
  if (n >= 10) return 10;
  if (n >= 8) return 8;
  if (n >= 6) return 6;
  if (n >= 4) return 4;
  if (n >= 3) return 4;
  return 2;
}

function getSidesForDieLabels(labels) {
  const m = getActiveFaceSlots(labels).length;
  const effective = m === 0 ? MIN_SIDES : m;
  return getSidesForDieCount(effective);
}

/** Lines prefixed with "-" in config are excluded from rolls and from die geometry (still stored). */
function isSideLabelDisabled(label) {
  const s = typeof label === "string" ? label.trimStart() : "";
  return s.startsWith("-");
}

/** Label shown on mesh face index (0-based), using only active sides in order. */
function getLabelTextForMeshFace(labels, faceIdx0) {
  const active = getActiveFaceSlots(labels);
  if (active.length === 0) return defaultLabel(faceIdx0);
  const polySides = getSidesForDieCount(active.length);
  const k = Math.min(active.length, polySides);
  if (polySides === 2 && active.length === 1) return active[0].text;
  if (faceIdx0 < k) return active[faceIdx0].text;
  return defaultLabel(faceIdx0);
}

/** Map current top mesh face (1-based) to textarea row index. */
function meshFaceToOrigIdx(labels, face1Based) {
  const active = getActiveFaceSlots(labels);
  if (active.length === 0) return null;
  const f = face1Based - 1;
  const polySides = getSidesForDieCount(active.length);
  const k = Math.min(active.length, polySides);
  if (polySides === 2 && active.length === 1 && f >= 0 && f < 2) return active[0].origIdx;
  if (f < 0 || f >= k) return null;
  return active[f].origIdx;
}

function pickRandomRollOutcome(labels) {
  const active = getActiveFaceSlots(labels);
  const m = active.length;
  if (m === 0) {
    const polySides = getSidesForDieCount(MIN_SIDES);
    const slot = Math.floor(Math.random() * polySides);
    return {
      face: slot + 1,
      origIdx: null,
      text: defaultLabel(slot),
      slot,
    };
  }
  const polySides = getSidesForDieCount(m);
  const k = Math.min(m, polySides);
  const slot = Math.floor(Math.random() * k);
  const entry = active[slot];
  let face1Based = slot + 1;
  if (polySides === 2 && m === 1) face1Based = Math.floor(Math.random() * 2) + 1;
  return {
    face: face1Based,
    origIdx: entry.origIdx,
    text: entry.text,
    slot,
  };
}

function applyDisablePrefixToLastFace(dieIdx) {
  ensureDiceArray();
  const die = state.dice[dieIdx];
  if (!die) return false;
  const face = die.lastFace;
  if (!Number.isFinite(face) || face < 1) return false;
  const labels = die.labels;
  const origIdx = meshFaceToOrigIdx(labels, face);
  if (origIdx == null) return false;
  if (isSideLabelDisabled(labels[origIdx])) return false;
  labels[origIdx] = `-${labels[origIdx]}`;
  return true;
}

function commitSideLabelChanges({ clearRollMeta = false } = {}) {
  saveState();
  renderSideInputs();
  renderCounts();
  renderHistory();
  if (clearRollMeta) $("rollMeta").textContent = "";
  if (isDieRollView()) renderDiceFromLast({ animate: false });
  renderPerDieRollButtons();
  syncMobileRemoveSidesBtn();
}

function disableLastRolledFaceForDieAndSave(dieIdx) {
  if (!applyDisablePrefixToLastFace(dieIdx)) return false;
  commitSideLabelChanges();
  return true;
}

function disableLastRolledFacesAllDice() {
  ensureDiceArray();
  if (!state.history.length) return false;
  let changed = false;
  for (let i = 0; i < state.dice.length; i++) {
    if (applyDisablePrefixToLastFace(i)) changed = true;
  }
  if (!changed) return false;
  commitSideLabelChanges();
  return true;
}

function reenableAllMarkedSides() {
  if (anyDiceRollingVisual()) cancelInFlightRoll();
  ensureDiceArray();
  let changed = false;
  for (const die of state.dice) {
    die.labels = die.labels.map((lab, idx) => {
      const s = typeof lab === "string" ? lab : "";
      const t = s.trimStart();
      if (!t.startsWith("-")) return lab;
      changed = true;
      const rest = t.slice(1).trimStart();
      return rest.length ? rest : defaultLabel(idx);
    });
  }
  if (!changed) return;
  commitSideLabelChanges({ clearRollMeta: true });
}

function syncMobileRemoveSidesBtn() {
  const btn = $("mobileRemoveSidesBtn");
  if (!btn) return;
  btn.disabled = !state.history.length;
}

function makeLabelTexture(text, { glow = false } = {}) {
  const t0 = String(text ?? "").trim();
  const key = `${glow ? "g" : "n"}:${t0}`;
  const cached = labelTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const t = t0;
  const fontSize = 64;
  ctx.font = `800 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (glow) {
    // Outer glow behind the text (single label plane, no duplicate geometry).
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(t, canvas.width / 2, canvas.height / 2);
    ctx.restore();
  }

  // Subtle engraved look drawn in 2D: dark top-left, light bottom-right
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillText(t, canvas.width / 2 - 2, canvas.height / 2 - 2);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillText(t, canvas.width / 2 + 2, canvas.height / 2 + 2);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fillText(t, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.userData = { text: t0, glow: !!glow };
  labelTextureCache.set(key, tex);
  return tex;
}

function quantizeNormalKey(v) {
  // Quantize to cluster coplanar triangles (pentagons on dodeca, etc.)
  const q = (x) => Math.round(x * 1000) / 1000;
  return `${q(v.x)},${q(v.y)},${q(v.z)}`;
}

function computeFaceClusters(geometry) {
  const g = geometry.toNonIndexed();
  g.computeVertexNormals();

  const pos = g.getAttribute("position");
  const clusters = new Map(); // key -> { normal, centerSum, count }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const center = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    const key = quantizeNormalKey(n);

    center.set(0, 0, 0).add(a).add(b).add(c).multiplyScalar(1 / 3);

    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, { normal: n.clone(), centerSum: center.clone(), count: 1 });
    } else {
      existing.centerSum.add(center);
      existing.count += 1;
    }
  }

  const out = [];
  for (const c0 of clusters.values()) {
    const ctr = c0.centerSum.clone().multiplyScalar(1 / c0.count);
    out.push({ normal: c0.normal.clone().normalize(), center: ctr });
  }

  // Deterministic ordering so faceIndex mapping stays stable.
  out.sort((p, q) => (p.normal.z - q.normal.z) || (p.normal.y - q.normal.y) || (p.normal.x - q.normal.x));
  return out;
}

/** @returns {number|null} Die index whose mesh was hit, or null for empty canvas / miss. */
function pickDieIndexUnderPointer(clientX, clientY) {
  const ctx = threeCtx;
  if (!ctx?.renderer?.domElement || !ctx.camera || !ctx.dice?.length) return null;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  _diePickNdca.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _diePickNdca.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _diePickRaycaster.setFromCamera(_diePickNdca, ctx.camera);
  const roots = ctx.dice.map((d) => d.group).filter(Boolean);
  if (!roots.length) return null;
  const hits = _diePickRaycaster.intersectObjects(roots, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o) {
    const idx = ctx.dice.findIndex((d) => d.group === o);
    if (idx >= 0) return idx;
    o = o.parent;
  }
  return null;
}

function triggerRollFromCanvasPick(dieIdxOrNull) {
  ensureDiceArray();
  if (dieIdxOrNull != null && state.dice[dieIdxOrNull]) rollSingleDieWithAnimation(dieIdxOrNull);
  else rollWithAnimation();
}

function bindDieCanvasGestures(canvas) {
  if (!canvas || canvas.dataset.dieCanvasGesturesBound === "1") return;
  canvas.dataset.dieCanvasGesturesBound = "1";

  let activePointerId = null;
  let sx = 0;
  let sy = 0;
  let dieIdxAtDown = null;

  const suppressRollCardIfMobile = () => {
    if (isMobileLayout()) suppressMobileRollCardTap = true;
  };

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (!isDieRollView()) return;
      if (e.button !== 0 && e.pointerType !== "touch" && e.pointerType !== "pen") return;
      activePointerId = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
      dieIdxAtDown = pickDieIndexUnderPointer(e.clientX, e.clientY);
    },
    { passive: true }
  );

  canvas.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId !== activePointerId) return;
      activePointerId = null;
      if (!isDieRollView()) return;

      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      // 1) Mobile: swipe left — ignore last side (global vs picked die).
      if (
        isMobileLayout() &&
        dx <= -MOBILE_SWIPE_IGNORE_LAST_SIDE_MIN_PX &&
        adx >= ady * MOBILE_SWIPE_IGNORE_DOMINANCE_RATIO
      ) {
        const ok =
          dieIdxAtDown != null
            ? disableLastRolledFaceForDieAndSave(dieIdxAtDown)
            : disableLastRolledFacesAllDice();
        if (ok) suppressRollCardIfMobile();
        return;
      }

      // 2) Swipe up — roll picked die only if pointer-down hit that die; else roll all dice.
      if (dy <= -DIE_CANVAS_SWIPE_UP_MIN_PX && ady >= adx * DIE_CANVAS_SWIPE_UP_DOMINANCE_RATIO) {
        triggerRollFromCanvasPick(dieIdxAtDown);
        suppressRollCardIfMobile();
        return;
      }

      // 3) Tap — same targeting rule as swipe up.
      if (adx <= DIE_CANVAS_TAP_MAX_PX && ady <= DIE_CANVAS_TAP_MAX_PX) {
        triggerRollFromCanvasPick(dieIdxAtDown);
        suppressRollCardIfMobile();
        return;
      }
    },
    { passive: true }
  );

  canvas.addEventListener("pointercancel", () => {
    activePointerId = null;
  });
}

function initThree() {
  const root = document.getElementById("threeRoot");
  if (!root) return null;

  if (threeCtx?.root === root && threeCtx?.renderer) return threeCtx;

  // Dispose previous renderer if root changed
  if (threeCtx?.renderer) {
    try {
      threeCtx.renderer.dispose();
    } catch {}
  }

  root.innerHTML = "";
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.appendChild(renderer.domElement);
  bindDieCanvasGestures(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  camera.position.set(0, 0, 800);
  camera.lookAt(0, 0, 0);

  // Lower ambient + stronger key light so each face reads as a flat facet (closer to classic polyhedral dice).
  const ambient = new THREE.AmbientLight(0xffffff, 0.58);
  const dir = new THREE.DirectionalLight(0xffffff, 1.12);
  dir.position.set(1, 1.35, 2);
  scene.add(ambient, dir);

  threeCtx = {
    root,
    renderer,
    scene,
    camera,
    dice: [], // [{ group, mesh, faces:[{normal,center,sprite}], sides, labelSprites:[] }]
    anims: [], // active roll animations
    lastSize: { w: 0, h: 0 },
  };

  const onResize = () => syncDiceMeshesFromState();
  window.addEventListener("resize", onResize);
  threeCtx._onResize = onResize;

  startThreeRenderLoop();
  return threeCtx;
}

let threeRaf = 0;
function startThreeRenderLoop() {
  if (threeRaf) return;
  const tick = (t) => {
    threeRaf = window.requestAnimationFrame(tick);
    if (!threeCtx?.renderer || !threeCtx?.scene || !threeCtx?.camera) return;

    // Animations
    const now = performance.now();
    if (Array.isArray(threeCtx.anims) && threeCtx.anims.length) {
      threeCtx.anims = threeCtx.anims.filter((a) => {
        const p = Math.min(1, (now - a.t0) / a.dur);
        if (p >= 1) {
          // Snap exactly to the target so we land perfectly flat.
          a.obj.quaternion.copy(a.q1);
          if (typeof a.dieIdx === "number") resetDieRollingVisuals(threeCtx, a.dieIdx);
          return false;
        }
        const e = p < 1 ? 1 - Math.pow(1 - p, 3) : 1; // easeOutCubic
        const base = a._tmpQ || (a._tmpQ = new THREE.Quaternion());
        base.slerpQuaternions(a.q0, a.q1, e);

        const extra = a._tmpExtra || (a._tmpExtra = new THREE.Quaternion());
        const decay = Math.pow(1 - e, 1.001);
        const velMul = typeof a.spinVelMul === "number" && a.spinVelMul > 0 ? a.spinVelMul : 1;
        const chainAmp =
          typeof a.spinChainAmp === "number" && a.spinChainAmp > 0 ? a.spinChainAmp : 1;
        const angle = decay * (a.spins || 0) * Math.PI * 2 * velMul * chainAmp;
        extra.setFromAxisAngle(a.axis, angle);

        const omega = analyticTumbleSpinRateRadS(a, now, velMul, chainAmp);

        a.obj.quaternion.copy(base).multiply(extra);
        if (typeof a.dieIdx === "number") {
          const d = threeCtx.dice[a.dieIdx];
          const raw = computeRollingStressFromOmega(omega, ROLL_SPIN_TEXT_THRESHOLD_MULT);
          const sm = ROLL_STRESS_U_SMOOTH_ALPHA;
          const uBody = THREE.MathUtils.lerp(a._stressUBodySmooth ?? 0, raw.u, sm);
          const uText = THREE.MathUtils.lerp(a._stressUTextSmooth ?? 0, raw.uText, sm);
          a._stressUBodySmooth = uBody;
          a._stressUTextSmooth = uText;
          applyRollingVisualStress(threeCtx, a.dieIdx, uBody, uText);
          if (d) {
            const peakRamp = centrifugalWarpRampFromOmega(omega);
            applyRollingCentrifugalDeform(d, a, { u: uBody, peakRamp });
          }
        }
        return p < 1;
      });
    }

    threeCtx.renderer.render(threeCtx.scene, threeCtx.camera);
  };
  threeRaf = window.requestAnimationFrame(tick);
}

function layoutThreeCanvas(diceCount) {
  const ctx = initThree();
  if (!ctx) return;

  const scroll = ctx.root.closest(".dice-scroll");
  const w = (scroll?.clientWidth || ctx.root.clientWidth || 600) | 0;

  // Match previous CSS sizing behavior roughly.
  let diePx = 220;
  if (diceCount <= 1) diePx = 320;
  else if (diceCount === 2) diePx = 280;
  else if (diceCount === 3) diePx = 240;
  else if (diceCount === 4) diePx = 220;
  else if (diceCount <= 8) diePx = 200;
  else diePx = 180;

  const gap = 76; // keep same as CSS gap
  const cols = Math.max(1, Math.min(diceCount, Math.floor((w + gap) / (diePx + gap))));
  const rows = Math.max(1, Math.ceil(diceCount / cols));
  const h = Math.max(1, rows * (diePx + gap) - gap + 40);

  ctx.renderer.setSize(w, h, false);
  ctx.renderer.domElement.style.width = "100%";
  ctx.renderer.domElement.style.height = `${h}px`;

  ctx.camera.left = -w / 2;
  ctx.camera.right = w / 2;
  ctx.camera.top = h / 2;
  ctx.camera.bottom = -h / 2;
  ctx.camera.updateProjectionMatrix();

  return { w, h, diePx, gap, cols, rows };
}

function syncDiceMeshesFromState() {
  ensureDiceArray();
  const ctx = initThree();
  if (!ctx) return;

  const diceCount = state.dice.length;
  const layout = layoutThreeCanvas(diceCount);
  if (!layout) return;

  // Add/remove die groups
  while (ctx.dice.length < diceCount) {
    const group = new THREE.Group();
    ctx.scene.add(group);
    ctx.dice.push({
      group,
      mesh: null,
      faces: [],
      sides: 6,
      labelPlanes: [],
      orientToFace: null,
    });
  }
  while (ctx.dice.length > diceCount) {
    const d = ctx.dice.pop();
    if (d?.group) ctx.scene.remove(d.group);
  }

  // Create/update each die
  for (let i = 0; i < diceCount; i++) {
    const die = state.dice[i];
    const labels = Array.isArray(die?.labels) ? die.labels : [];
    const sides = getSidesForDieLabels(labels);

    const d = ctx.dice[i];
    if (d.sides !== sides || !d.mesh || !d.spinDeformGroup) {
      // Rebuild mesh
      d.group.clear();
      d.spinDeformGroup = null;
      d.labelPlanes = [];
      d.faces = [];

      const { geometry, faceCount, faceLayout } = getGeometryForSides(sides);
      geometry.computeBoundingSphere();
      const baseRadius = geometry.boundingSphere?.radius || 1;

      const dieColorHex = getDieHexColor(i);
      const mat = new THREE.MeshStandardMaterial({
        color: dieColorHex,
        roughness: sides === 2 ? 0.38 : 0.52,
        metalness: sides === 2 ? 0.42 : 0.06,
        flatShading: sides !== 2,
      });

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.baseDieColorHex = dieColorHex;
      d.mesh = mesh;
      d.sides = sides;
      const spinDeformGroup = new THREE.Group();
      d.spinDeformGroup = spinDeformGroup;
      d.group.add(spinDeformGroup);
      spinDeformGroup.add(mesh);

      // Scale to desired size
      const desiredRadius = (layout.diePx * 0.42);
      const s = desiredRadius / baseRadius;
      d.group.scale.setScalar(s);

      if (faceLayout === "coin") {
        d.faces = computeCoinCapsFeatures(geometry);
      } else {
        const clusters = computeFaceClusters(geometry);
        d.faces = clusters.slice(0, faceCount);
      }

      const worldUp = new THREE.Vector3(0, 1, 0);
      const worldRight = new THREE.Vector3(1, 0, 0);
      const zAxis = new THREE.Vector3();
      const yAxis = new THREE.Vector3();
      const xAxis = new THREE.Vector3();
      const rotMat = new THREE.Matrix4();

      const orientToFace = (obj, normal) => {
        // Build an orthonormal basis where Z=normal and Y=projected worldUp.
        zAxis.copy(normal).normalize();
        yAxis.copy(worldUp);
        yAxis.addScaledVector(zAxis, -yAxis.dot(zAxis)); // project onto plane
        if (yAxis.lengthSq() < 1e-6) {
          yAxis.copy(worldRight);
          yAxis.addScaledVector(zAxis, -yAxis.dot(zAxis));
        }
        yAxis.normalize();
        xAxis.crossVectors(yAxis, zAxis).normalize();

        rotMat.makeBasis(xAxis, yAxis, zAxis);
        obj.quaternion.setFromRotationMatrix(rotMat);
      };
      d.orientToFace = orientToFace;

      const labelSizeBySides = (sidesN) => {
        // Base sizes tuned to keep labels inside faces even after scaling.
        // (We apply FACE_TEXT_SCALE below.)
        if (sidesN === 2) return 0.74;
        if (sidesN === 4 || sidesN === 8 || sidesN === 20) return 0.56; // triangles
        if (sidesN === 10) return 0.54; // kite quads (D10)
        if (sidesN === 12) return 0.58; // pentagons
        return 0.66; // squares (cube)
      };

      const makeRegularPolygonGeometry = (k, radius, startAngleRad) => {
        const verts = [];
        const start = typeof startAngleRad === "number" ? startAngleRad : -Math.PI / 2;
        for (let i = 0; i < k; i++) {
          const a = (i / k) * Math.PI * 2 + start;
          verts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
        }
        const shape = new THREE.Shape(verts);
        return new THREE.ShapeGeometry(shape);
      };

      for (let f = 0; f < d.faces.length; f++) {
        const text = getLabelTextForMeshFace(labels, f);
        const tex = makeLabelTexture(text, { glow: false });
        const pm = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const size = labelSizeBySides(sides) * FACE_TEXT_SCALE;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), pm);

        const normal = d.faces[f].normal.clone().normalize();
        const center = d.faces[f].center.clone();
        // Sit on the face plane with a tiny epsilon.
        const eps = 0.02;
        plane.position.copy(center.add(normal.multiplyScalar(eps)));

        // Orient plane to face normal and keep text upright.
        orientToFace(plane, normal);

        spinDeformGroup.add(plane);
        d.labelPlanes.push(plane);
      }
    } else {
      // Update plane textures if labels changed
      const faceCount = d.faces.length;
      for (let f = 0; f < faceCount; f++) {
        const text = getLabelTextForMeshFace(labels, f);
        const plane = d.labelPlanes[f];
        if (!plane) continue;
        const cur = plane.material?.map;
        const curText = cur?.userData?.text;
        const curGlow = !!cur?.userData?.glow;
        if (curText === text && !curGlow) continue;
        const tex = makeLabelTexture(text, { glow: false });
        plane.material.map = tex;
        plane.material.needsUpdate = true;
      }
    }
  }

  // Layout positions in grid
  for (let i = 0; i < diceCount; i++) {
    const d = ctx.dice[i];
    const row = Math.floor(i / layout.cols);
    const col = i % layout.cols;
    const x = (col - (layout.cols - 1) / 2) * (layout.diePx + layout.gap);
    const y = ((layout.rows - 1) / 2 - row) * (layout.diePx + layout.gap);
    d.group.position.set(x, y, 0);
  }
}

function clearWinningEmphasis() {
  const ctx = initThree();
  if (!ctx || !Array.isArray(ctx.dice)) return;
  for (let i = 0; i < ctx.dice.length; i++) clearWinningEmphasisForDie(i);
}

function clearWinningEmphasisForDie(dieIdx) {
  const ctx = initThree();
  if (!ctx || !Array.isArray(ctx.dice)) return;
  const d = ctx.dice[dieIdx];
  if (!d || !Array.isArray(d.labelPlanes)) return;
  for (const p of d.labelPlanes) {
    if (!p) continue;
    p.scale.set(1, 1, 1);
    const text = p.material?.map?.userData?.text ?? "";
    if (text) {
      p.material.map = makeLabelTexture(text, { glow: false });
      p.material.needsUpdate = true;
    }
    p.material.opacity = 1;
    p.material.transparent = true;
  }
}

function rollDiceMeshesToResults(results, { animate = true, emphasisReset = "all" } = {}) {
  const ctx = initThree();
  if (!ctx) return 0;
  if (!Array.isArray(results) || !results.length) return 0;

  const front = new THREE.Vector3(0, 0, 1);
  const screenUp = new THREE.Vector3(0, 1, 0);
  const tmpUp = new THREE.Vector3();
  const tmpZ = new THREE.Vector3();
  const tmpProj = new THREE.Vector3();
  const tmpCross = new THREE.Vector3();
  let maxDur = 0;

  for (const r of results) {
    const dieIdx = r.die ?? 0;
    const face = (r.face ?? 1) - 1;
    const d = ctx.dice[dieIdx];
    if (!d || !d.faces.length) continue;

    const targetNormal = (d.faces[face]?.normal ?? d.faces[0].normal).clone().normalize();
    const qFace = new THREE.Quaternion().setFromUnitVectors(targetNormal, front);

    // After landing, rotate the whole die around the face normal (now aligned to +Z)
    // so the face's local "up" reads upright to the camera.
    // We approximate the face's text-up direction by projecting screenUp into the face plane in local space
    // and then measuring the resulting up direction after applying qFace.
    tmpZ.copy(targetNormal).normalize();
    tmpUp.copy(screenUp).addScaledVector(tmpZ, -screenUp.dot(tmpZ));
    if (tmpUp.lengthSq() < 1e-6) tmpUp.set(1, 0, 0);
    tmpUp.normalize();

    // Rotate that up vector by qFace into world, then project onto screen plane (z=0).
    tmpProj.copy(tmpUp).applyQuaternion(qFace);
    tmpProj.z = 0;
    if (tmpProj.lengthSq() < 1e-6) tmpProj.set(0, 1, 0);
    tmpProj.normalize();

    // Signed angle in the screen plane from tmpProj to screenUp about +Z
    const dot = THREE.MathUtils.clamp(tmpProj.dot(screenUp), -1, 1);
    tmpCross.crossVectors(tmpProj, screenUp);
    const sign = tmpCross.z < 0 ? -1 : 1;
    const angle = Math.acos(dot) * sign;

    const qTwist = new THREE.Quaternion().setFromAxisAngle(front, angle);
    const qTarget = qTwist.multiply(qFace);

    if (!animate) {
      d.group.quaternion.copy(qTarget);
      continue;
    }

    const prevAnim = ctx.anims.find((a) => a.obj === d.group);
    ctx.anims = ctx.anims.filter((a) => a.obj !== d.group);

    let dur = Math.round((1100 + Math.random() * 600) * DIE_ROLL_DURATION_MULT);
    let spins = Math.floor(3 + Math.random() * 4); // 3..6 base
    let spinVelMul = 1;
    let spinChainAmp = 1;
    if (prevAnim) {
      spins = (prevAnim.spins || 0) + Math.floor(4 + Math.random() * 6);
      const prevVm = typeof prevAnim.spinVelMul === "number" && prevAnim.spinVelMul > 0 ? prevAnim.spinVelMul : 1;
      spinVelMul = Math.min(ROLL_CHAIN_VEL_MUL_MAX, prevVm * ROLL_CHAIN_VEL_MUL_STEP);
      const prevAmp =
        typeof prevAnim.spinChainAmp === "number" && prevAnim.spinChainAmp > 0 ? prevAnim.spinChainAmp : 1;
      spinChainAmp = Math.min(ROLL_CHAIN_SPIN_AMP_MAX, prevAmp * (1 + ROLL_CHAIN_SPIN_AMP_STEP));
      dur = Math.round(dur * 1.08 + (160 + Math.random() * 140));
      dur = Math.max(480, Math.min(4200, dur));
    }

    maxDur = Math.max(maxDur, dur);
    let axis;
    if (prevAnim && prevAnim.axis) {
      axis = prevAnim.axis.clone();
      const jit = 0.14;
      axis.x += (Math.random() - 0.5) * jit;
      axis.y += (Math.random() - 0.5) * jit;
      axis.z += (Math.random() - 0.5) * jit;
      axis.normalize();
    } else {
      axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    }
    ctx.anims.push({
      obj: d.group,
      dieIdx,
      q0: d.group.quaternion.clone(),
      q1: qTarget,
      axis,
      spins,
      spinVelMul,
      spinChainAmp,
      t0: performance.now(),
      dur,
    });
  }

  if (!animate) setWinningEmphasis(results, { resetDice: emphasisReset });
  return maxDur;
}

function setWinningEmphasis(results, { resetDice = "all" } = {}) {
  const ctx = initThree();
  if (!ctx) return;
  const res = Array.isArray(results) ? results : [];

  if (resetDice === "all") clearWinningEmphasis();
  else if (resetDice === "partial") {
    const seen = new Set();
    for (const r of res) {
      const di = r.die ?? 0;
      if (seen.has(di)) continue;
      seen.add(di);
      clearWinningEmphasisForDie(di);
    }
  }

  for (const r of res) {
    const dieIdx = r.die ?? 0;
    const faceIdx = Math.max(0, (r.face ?? 1) - 1);
    const d = ctx.dice?.[dieIdx];
    if (!d) continue;

    const p = d.labelPlanes?.[faceIdx];
    if (!p) continue;
    p.scale.set(FACE_TEXT_WIN_SCALE, FACE_TEXT_WIN_SCALE, FACE_TEXT_WIN_SCALE);
    const text = p.material?.map?.userData?.text ?? "";
    p.material.map = makeLabelTexture(text, { glow: true });
    p.material.needsUpdate = true;
  }
}

// (removed legacy CSS-3D cube renderer)

function syncAllDiceFaceTextsFromState() {
  syncDiceMeshesFromState();
}

function initDie3dFaces() {
  syncDiceMeshesFromState();
}

function renderDiceFromLast({ animate = false } = {}) {
  ensureDiceArray();
  syncDiceMeshesFromState();

  const results = state.dice.map((die, dieIdx) => {
    const labels = Array.isArray(die.labels) ? die.labels : [];
    const active = getActiveFaceSlots(labels);
    const defaultTop = getLabelTextForMeshFace(labels, 0);
    const text = typeof die.lastText === "string" && die.lastText ? die.lastText : defaultTop;

    const polySides = getSidesForDieLabels(labels);
    const k =
      active.length === 0 ? polySides : Math.min(active.length, getSidesForDieCount(active.length));

    let face = die.lastFace;

    if (!Number.isFinite(face) || face < 1 || face > k) {
      const idx = active.findIndex((e) => e.text === text);
      if (idx >= 0) {
        face = Math.min(k, idx + 1);
      } else {
        let hash = 0;
        for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
        face = (hash % k) + 1;
      }
    }

    return { die: dieIdx, face, text };
  });

  rollDiceMeshesToResults(results, { animate });
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
  el.textContent = anyDiceRollingVisual()
    ? "Rolling…"
    : "Tap or swipe ↑ on a die for that die only · Else all dice · Swipe ← ignores last side";
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
    renderDiceFromLast({ animate: false });
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

  if (isRender) renderDiceFromLast({ animate: false });
}

/** Bumped whenever all in-flight rolls should abort (full-table roll, reset, etc.). */
let rollWaveId = 0;
/** Pending completion timeouts keyed by die index (single-die rolls). */
const timeoutByDie = new Map();
const pendingRollTimeouts = new Set();
let batchRollTimeoutId = 0;
/** Supersedes older per-die completion handlers when the same die is rolled again. */
const dieRollEpoch = new Map();

function stopAllAnimationsAndTimers() {
  cancelPendingRollTimersOnly();
  if (threeCtx?.anims) threeCtx.anims = [];
}

/** Cancel scheduled roll completions without stopping active spin animations (stack / chain rolls). */
function cancelPendingRollTimersOnly() {
  rollWaveId++;
  pendingRollTimeouts.forEach((id) => window.clearTimeout(id));
  pendingRollTimeouts.clear();
  timeoutByDie.clear();
  if (batchRollTimeoutId) {
    window.clearTimeout(batchRollTimeoutId);
    batchRollTimeoutId = 0;
  }
}

/** Invalidate pending onRollDone for this die only (does not remove in-flight spin animation). */
function cancelDieRollFinishTimer(dieIdx) {
  const tid = timeoutByDie.get(dieIdx);
  if (tid != null) {
    window.clearTimeout(tid);
    pendingRollTimeouts.delete(tid);
    timeoutByDie.delete(dieIdx);
  }
  dieRollEpoch.set(dieIdx, (dieRollEpoch.get(dieIdx) || 0) + 1);
}

function stopAnimationsForDie(dieIdx) {
  const ctx = threeCtx;
  if (!ctx?.dice?.[dieIdx]) return;
  const g = ctx.dice[dieIdx].group;
  ctx.anims = ctx.anims.filter((a) => a.obj !== g);
  cancelDieRollFinishTimer(dieIdx);
  resetDieRollingVisuals(ctx, dieIdx);
}

function scheduleSingleDieRollFinish(dieIdx, settleMs, onDone) {
  const waveAtSchedule = rollWaveId;
  const epochAtSchedule = dieRollEpoch.get(dieIdx) || 0;
  const tid = window.setTimeout(() => {
    pendingRollTimeouts.delete(tid);
    timeoutByDie.delete(dieIdx);
    if (waveAtSchedule !== rollWaveId) return;
    if (epochAtSchedule !== (dieRollEpoch.get(dieIdx) || 0)) return;
    onDone();
  }, settleMs);
  pendingRollTimeouts.add(tid);
  timeoutByDie.set(dieIdx, tid);
}

function scheduleBatchRollFinish(settleMs, onDone) {
  const waveAtSchedule = rollWaveId;
  if (batchRollTimeoutId) {
    window.clearTimeout(batchRollTimeoutId);
    batchRollTimeoutId = 0;
  }
  batchRollTimeoutId = window.setTimeout(() => {
    batchRollTimeoutId = 0;
    if (waveAtSchedule !== rollWaveId) return;
    onDone();
  }, settleMs);
}

function anyDiceRollingVisual() {
  return (
    (threeCtx?.anims?.length ?? 0) > 0 || timeoutByDie.size > 0 || !!batchRollTimeoutId
  );
}

function cancelInFlightRoll() {
  stopAllAnimationsAndTimers();
  dieRollEpoch.clear();
  const ctx0 = initThree();
  if (ctx0?.dice) {
    for (let i = 0; i < ctx0.dice.length; i++) resetDieRollingVisuals(ctx0, i);
  }
  setRollButtonsDisabled(false);
  syncMobileTapHint();
  clearWinningEmphasis();
}

function renderPerDieRollButtons() {
  ensureDiceArray();
  const statsEl = $("perDieRollStats");
  const renderEl = $("perDieRollRender");
  const containers = [statsEl, renderEl].filter(Boolean);
  const n = state.dice.length;

  for (const el of containers) {
    el.className = "per-die-actions-wrap";
    el.innerHTML = "";
    el.hidden = false;

    const grid = document.createElement("div");
    grid.className = "per-die-actions-grid";
    grid.style.setProperty("--per-die-cols", String(Math.max(1, n)));

    for (let i = 0; i < n; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn-small die-per-action die-per-action-roll die-color-${i % 8}`;
      btn.dataset.perDieRoll = String(i);
      btn.textContent = "Roll";
      btn.title = `Roll only ${dieName(i)}`;
      btn.addEventListener("click", () => rollSingleDieWithAnimation(i));
      grid.appendChild(btn);
    }

    for (let i = 0; i < n; i++) {
      const die = state.dice[i];
      const canRemove =
        Number.isFinite(die?.lastFace) && die.lastFace >= 1 && !!state.history.length;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn-small die-per-action die-per-action-remove die-color-${i % 8}`;
      btn.dataset.perDieDisable = String(i);
      btn.textContent = "Remove Choice";
      btn.title = `Prefix "-" on ${dieName(i)}'s current top face`;
      btn.disabled = !canRemove;
      btn.addEventListener("click", () => disableLastRolledFaceForDieAndSave(i));
      grid.appendChild(btn);
    }

    el.appendChild(grid);
  }
}

function setRollButtonsDisabled(disabled) {
  const rollStatsBtn = $("rollBtnStats");
  const rollRenderBtn = $("rollBtnRender");
  if (rollStatsBtn) rollStatsBtn.disabled = !!disabled;
  if (rollRenderBtn) rollRenderBtn.disabled = !!disabled;
  document.querySelectorAll("[data-per-die-roll]").forEach((btn) => {
    btn.disabled = !!disabled;
  });
  document.querySelectorAll("[data-per-die-disable]").forEach((btn) => {
    btn.disabled = !!disabled;
  });
}

function rollOnce() {
  ensureDiceArray();
  const ts = Date.now();

  const results = state.dice.map((die, dieIdx) => {
    const out = pickRandomRollOutcome(die.labels);
    while ((die.counts?.length ?? 0) < die.labels.length) die.counts.push(0);
    if (out.origIdx != null) die.counts[out.origIdx] = (die.counts[out.origIdx] ?? 0) + 1;
    die.lastFace = out.face;
    die.lastText = out.text;
    return { die: dieIdx, face: out.face, text: out.text };
  });

  state.history.push({ ts, results });
  if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);

  saveState();
  renderResult(results);
  renderCounts();
  renderHistory();
  if (isDieRollView()) {
    syncDiceMeshesFromState();
    rollDiceMeshesToResults(results, { animate: false, emphasisReset: "all" });
  }
}

function rollSingleDieOnce(dieIdx) {
  ensureDiceArray();
  const die = state.dice[dieIdx];
  if (!die) return;

  const ts = Date.now();
  const out = pickRandomRollOutcome(die.labels);
  while ((die.counts?.length ?? 0) < die.labels.length) die.counts.push(0);
  if (out.origIdx != null) die.counts[out.origIdx] = (die.counts[out.origIdx] ?? 0) + 1;
  die.lastFace = out.face;
  die.lastText = out.text;

  const results = [{ die: dieIdx, face: out.face, text: out.text }];
  state.history.push({ ts, results });
  if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);

  saveState();
  renderResult(results);
  renderCounts();
  renderHistory();
  if (isDieRollView()) {
    syncDiceMeshesFromState();
    rollDiceMeshesToResults(results, { animate: false, emphasisReset: "partial" });
  }
}

function rollSingleDieWithAnimation(dieIdx) {
  ensureDiceArray();
  const die = state.dice[dieIdx];
  if (!die) return;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reduceMotion || !isDieRollView()) {
    rollSingleDieOnce(dieIdx);
    syncMobileTapHint();
    return;
  }

  if (batchRollTimeoutId) {
    cancelPendingRollTimersOnly();
  }

  syncDiceMeshesFromState();
  cancelDieRollFinishTimer(dieIdx);
  clearWinningEmphasisForDie(dieIdx);

  const out = pickRandomRollOutcome(die.labels);
  const face = out.face;
  const text = out.text;

  syncMobileTapHint();

  const maxDuration = rollDiceMeshesToResults([{ die: dieIdx, face, text }], { animate: true });
  const settleMs = Math.max(0, Number(maxDuration) || 0) + 30;

  scheduleSingleDieRollFinish(dieIdx, settleMs, () => {
    const ts = Date.now();
    if (out.origIdx != null) {
      while (die.counts.length <= out.origIdx) die.counts.push(0);
      die.counts[out.origIdx] = (die.counts[out.origIdx] ?? 0) + 1;
    }
    die.lastFace = face;
    die.lastText = text;
    const finalResults = [{ die: dieIdx, face, text }];
    state.history.push({ ts, results: finalResults });
    if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);
    saveState();

    renderResult(finalResults);
    renderCounts();
    renderHistory();
    setWinningEmphasis(finalResults, { resetDice: "none" });

    syncMobileTapHint();
  });
}

function rollWithAnimation() {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reduceMotion || !isDieRollView()) {
    rollOnce();
    syncMobileTapHint();
    return;
  }

  ensureDiceArray();
  cancelPendingRollTimersOnly();
  syncDiceMeshesFromState();
  clearWinningEmphasis();

  // Pick final outcomes first; animations run in parallel.
  const picked = state.dice.map((die) => pickRandomRollOutcome(die.labels));
  const results = picked.map((out, dieIdx) => ({
    die: dieIdx,
    face: out.face,
    origIdx: out.origIdx,
    text: out.text,
  }));

  syncMobileTapHint();

  $("resultWrap").textContent = "Rolling…";
  $("rollMeta").textContent = "";

  const maxDuration = rollDiceMeshesToResults(
    results.map((r) => ({ die: r.die, face: r.face, text: r.text })),
    { animate: true }
  );
  const settleMs = Math.max(0, Number(maxDuration) || 0) + 30;

  scheduleBatchRollFinish(settleMs, () => {
    const ts = Date.now();
    const finalResults = results.map((r) => {
      const die0 = state.dice[r.die];
      while ((die0.counts?.length ?? 0) < die0.labels.length) die0.counts.push(0);
      if (r.origIdx != null) die0.counts[r.origIdx] = (die0.counts[r.origIdx] ?? 0) + 1;
      die0.lastFace = r.face;
      die0.lastText = r.text;
      return { die: r.die, face: r.face, text: r.text };
    });
    state.history.push({ ts, results: finalResults });
    if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);
    saveState();

    renderResult(finalResults);
    renderCounts();
    renderHistory();
    setWinningEmphasis(finalResults, { resetDice: "all" });

    syncMobileTapHint();
  });
}

function resetRolls() {
  ensureDiceArray();
  state.dice.forEach((die) => {
    die.counts = die.labels.map(() => 0);
  });
  saveState();

  $("resultWrap").textContent = "";
  $("rollMeta").textContent = "";
  renderCounts();
  renderHistory(); // history kept, but totals may change
}

function resetHistory() {
  state.history = [];
  ensureDiceArray();
  state.dice.forEach((die) => {
    die.lastFace = null;
    die.lastText = "";
  });
  saveState();
  renderHistory();
  renderCounts();
  if (isDieRollView()) renderDiceFromLast();
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
    renderDiceFromLast({ animate: false });
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
  $("rollMeta").textContent = "";

  // Default to the render tab (unless user already chose a preference).
  trackingMode = localStorage.getItem(TRACKING_MODE_KEY) || "render";
  if (isMobileLayout()) {
    mobileConfigOpen = false;
    applyMobileShell();
  } else {
    setTrackingMode(trackingMode);
  }
  syncMobileTapHint();
  syncMobileRemoveSidesBtn();

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
  const reenableSidesBtn = $("reenableSidesBtn");
  if (reenableSidesBtn) reenableSidesBtn.addEventListener("click", reenableAllMarkedSides);
  const mobileRemoveSidesBtn = $("mobileRemoveSidesBtn");
  if (mobileRemoveSidesBtn) {
    mobileRemoveSidesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      disableLastRolledFacesAllDice();
    });
  }

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
    if (suppressMobileRollCardTap) {
      suppressMobileRollCardTap = false;
      return;
    }
    if (e.target.closest("[data-toggle-panel]")) return;
    if (e.target.closest("[data-per-die-roll]")) return;
    if (e.target.closest("[data-per-die-disable]")) return;
    if (e.target.closest("#mobileRemoveSidesBtn")) return;
    rollWithAnimation();
  });
}

window.addEventListener("storage", (e) => {
  if (!e || e.key !== STORAGE_KEY) return;
  refreshFromStorage();
});

document.addEventListener("DOMContentLoaded", init);

