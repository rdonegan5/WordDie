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
  if (isRolling) cancelInFlightRoll();
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
  if (isRolling) cancelInFlightRoll();
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
  $("sidesInfo").textContent = `Current dice: ${dice.length} — sides: ${sidesSummary} (blank line = new die)`;

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
      $("sidesInfo").textContent = `Current dice: ${state.dice.length} — sides: ${summary} (blank line = new die)`;
    });
  }
}

function renderCounts() {
  ensureDiceArray();
  const wrap = $("countsTables");
  if (!wrap) return;
  wrap.innerHTML = "";

  let grandTotal = 0;

  state.dice.forEach((die, dieIdx) => {
    const total = (die.counts || []).reduce((a, b) => a + (b || 0), 0);
    grandTotal += total;

    const card = document.createElement("div");
    card.className = "counts-table-card";

    const title = document.createElement("div");
    title.className = `counts-table-title die-color-${dieIdx % 4}`;
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

  const totalsEl = $("totals");
  if (totalsEl) totalsEl.textContent = `Total rolls (all dice): ${grandTotal}`;
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";

  const historyBlock = box?.closest?.(".mobile-history-block");

  if (!state.history.length) {
    box.innerHTML = `<div class="muted">No rolls yet.</div>`;
    historyBlock?.classList.remove("history-grow-1", "history-grow-2", "history-grow-3");
    historyBlock?.classList.add("history-grow-0");
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

  $("resultWrap").textContent = `You rolled: ${arr.map((r) => r.text).join(", ")}`;
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

// --- Three.js polyhedral renderer (D4/D6/D8/D12/D20) ---
let threeCtx = null;

const SUPPORTED_DICE_SIDES = [4, 6, 8, 12, 20];
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

function getGeometryForSides(n) {
  // Return { geometry, faceCount } where faceCount is the logical face count (not triangles)
  switch (n) {
    case 4:
      return { geometry: new THREE.TetrahedronGeometry(1, 0), faceCount: 4 };
    case 6:
      return { geometry: new THREE.BoxGeometry(1, 1, 1), faceCount: 6 };
    case 8:
      return { geometry: new THREE.OctahedronGeometry(1, 0), faceCount: 8 };
    case 12:
      return { geometry: new THREE.DodecahedronGeometry(1, 0), faceCount: 12 };
    case 20:
      return { geometry: new THREE.IcosahedronGeometry(1, 0), faceCount: 20 };
    default:
      return { geometry: new THREE.BoxGeometry(1, 1, 1), faceCount: 6 };
  }
}

function getSidesForDieLabels(labels) {
  const n = Array.isArray(labels) ? labels.length : 0;
  // Use the largest supported die whose face count is <= provided labels.
  // This matches "only use larger-sided die if there are enough sides available for it".
  if (n >= 20) return 20;
  if (n >= 12) return 12;
  if (n >= 8) return 8;
  if (n >= 6) return 6;
  if (n >= 4) return 4;
  return 6;
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

  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  camera.position.set(0, 0, 800);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.85);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 1.3, 2);
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
          return false;
        }
        const e = p < 1 ? (1 - Math.pow(1 - p, 3)) : 1; // easeOutCubic
        // Base slerp to target
        const base = a._tmpQ || (a._tmpQ = new THREE.Quaternion());
        base.slerpQuaternions(a.q0, a.q1, e);

        // Add extra spins that decay to 0 by the end (for a real roll feel)
        const extra = a._tmpExtra || (a._tmpExtra = new THREE.Quaternion());
        const decay = Math.pow(1 - e, 1.15); // fade-out
        const angle = decay * a.spins * Math.PI * 2;
        extra.setFromAxisAngle(a.axis, angle);

        a.obj.quaternion.copy(base).multiply(extra);
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
    if (d.sides !== sides || !d.mesh) {
      // Rebuild mesh
      d.group.clear();
      d.labelPlanes = [];
      d.faces = [];

      const { geometry, faceCount } = getGeometryForSides(sides);
      geometry.computeBoundingSphere();
      const baseRadius = geometry.boundingSphere?.radius || 1;

      const mat = new THREE.MeshStandardMaterial({
        color: getDieHexColor(i),
        roughness: 0.45,
        metalness: 0.08,
      });

      const mesh = new THREE.Mesh(geometry, mat);
      d.mesh = mesh;
      d.sides = sides;
      d.group.add(mesh);

      // Scale to desired size
      const desiredRadius = (layout.diePx * 0.42);
      const s = desiredRadius / baseRadius;
      d.group.scale.setScalar(s);

      // Face clusters + label planes (flush to face)
      const clusters = computeFaceClusters(geometry);
      d.faces = clusters.slice(0, faceCount);

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
        if (sidesN === 4 || sidesN === 8 || sidesN === 20) return 0.56; // triangles
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
        const text = labels[f] ?? defaultLabel(f);
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

        d.group.add(plane);
        d.labelPlanes.push(plane);
      }
    } else {
      // Update plane textures if labels changed
      const faceCount = d.faces.length;
      for (let f = 0; f < faceCount; f++) {
        const text = labels[f] ?? defaultLabel(f);
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
  for (const d of ctx.dice) {
    if (Array.isArray(d?.labelPlanes)) {
      for (const p of d.labelPlanes) {
        if (!p) continue;
        p.scale.set(1, 1, 1);
        const text = p.material?.map?.userData?.text ?? "";
        if (text) {
          p.material.map = makeLabelTexture(text, { glow: false });
          p.material.needsUpdate = true;
        }
      }
    }
  }
}

function rollDiceMeshesToResults(results, { animate = true } = {}) {
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

    const dur = Math.round((1100 + Math.random() * 600) * DIE_ROLL_DURATION_MULT);
    maxDur = Math.max(maxDur, dur);
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const spins = Math.floor(3 + Math.random() * 4); // 3..6
    ctx.anims.push({
      obj: d.group,
      q0: d.group.quaternion.clone(),
      q1: qTarget,
      axis,
      spins,
      t0: performance.now(),
      dur,
    });
  }

  if (!animate) setWinningEmphasis(results);
  return maxDur;
}

function setWinningEmphasis(results) {
  const ctx = initThree();
  if (!ctx) return;
  const res = Array.isArray(results) ? results : [];

  clearWinningEmphasis();

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
    const text = typeof die.lastText === "string" && die.lastText ? die.lastText : (labels[0] ?? defaultLabel(0));
    const sides = getSidesForDieLabels(labels);
    const n = Math.max(1, Math.min(labels.length || 1, sides));
    let face = die.lastFace;

    if (!Number.isFinite(face) || face < 1 || face > n) {
      const idx = labels.findIndex((l) => l === text);
      if (idx >= 0) {
        face = Math.min(n, idx + 1);
      } else {
        let hash = 0;
        for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
        face = (hash % n) + 1;
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

let isRolling = false;
let rollToken = 0;
let rollTimeoutId = 0;

function cancelInFlightRoll() {
  rollToken++;
  if (rollTimeoutId) {
    window.clearTimeout(rollTimeoutId);
    rollTimeoutId = 0;
  }
  if (threeCtx?.anims) threeCtx.anims = [];
  isRolling = false;
  setRollButtonsDisabled(false);
  clearWinningEmphasis();
}

function setRollButtonsDisabled(disabled) {
  const rollStatsBtn = $("rollBtnStats");
  const rollRenderBtn = $("rollBtnRender");
  if (rollStatsBtn) rollStatsBtn.disabled = !!disabled;
  if (rollRenderBtn) rollRenderBtn.disabled = !!disabled;
}

function rollOnce() {
  ensureDiceArray();
  const ts = Date.now();

  const results = state.dice.map((die, dieIdx) => {
    const sides = getSidesForDieLabels(die.labels);
    const n = Math.max(1, Math.min(die.labels.length || 1, sides));
    const face = Math.floor(Math.random() * n) + 1;
    const idx = face - 1;
    const text = die.labels[idx] ?? `Side ${face}`;
    while ((die.counts?.length ?? 0) < n) die.counts.push(0);
    die.counts[idx] = (die.counts[idx] ?? 0) + 1;
    die.lastFace = face;
    die.lastText = text;
    return { die: dieIdx, face, text };
  });

  state.history.push({ ts, results });
  if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);

  saveState();
  renderResult(results);
  renderCounts();
  renderHistory();
  if (isDieRollView()) {
    syncDiceMeshesFromState();
    rollDiceMeshesToResults(results, { animate: false });
    setWinningEmphasis(results);
  }
}

function rollWithAnimation() {
  if (isRolling) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reduceMotion || !isDieRollView()) {
    rollOnce();
    syncMobileTapHint();
    return;
  }

  ensureDiceArray();
  syncDiceMeshesFromState();
  clearWinningEmphasis();

  // Pick final outcomes first; animations run in parallel.
  const results = state.dice.map((die, dieIdx) => {
    const sides = getSidesForDieLabels(die.labels);
    const n = Math.max(1, Math.min(die.labels.length || 1, sides));
    const face = Math.floor(Math.random() * n) + 1;
    const idx = face - 1;
    const text = die.labels[idx] ?? `Side ${face}`;
    return { die: dieIdx, face, idx, text };
  });

  isRolling = true;
  const myToken = ++rollToken;
  setRollButtonsDisabled(true);
  syncMobileTapHint();

  $("resultWrap").textContent = "Rolling…";
  $("rollMeta").textContent = "";

  const maxDuration = rollDiceMeshesToResults(
    results.map((r) => ({ die: r.die, face: r.face, text: r.text })),
    { animate: true }
  );
  const settleMs = Math.max(0, Number(maxDuration) || 0) + 30;

  rollTimeoutId = window.setTimeout(() => {
    if (myToken !== rollToken) return; // cancelled/replaced
    const ts = Date.now();
    const finalResults = results.map((r) => {
      const die = state.dice[r.die];
      die.counts[r.idx] = (die.counts[r.idx] ?? 0) + 1;
      die.lastFace = r.face;
      die.lastText = r.text;
      return { die: r.die, face: r.face, text: r.text };
    });
    state.history.push({ ts, results: finalResults });
    if (state.history.length > state.maxHistory) state.history = state.history.slice(-state.maxHistory);
    saveState();

    renderResult(finalResults);
    renderCounts();
    renderHistory();
    setWinningEmphasis(finalResults);

    setRollButtonsDisabled(false);
    isRolling = false;
    syncMobileTapHint();
    rollTimeoutId = 0;
  }, settleMs);
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

