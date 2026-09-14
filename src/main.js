/**
 * 页面主控制器：文件输入 → Worker 计算 → three.js 渲染 → 导出。
 */
import sampleText from "../test/data/sparseMat_Normalized.metrics" with { type: "text" };
import { LINE_WIDTH, MARKER_SIZE, SIGMA, StructureViewer } from "./viewer.js";
import TourGuidePackage from "npm:@sjmc11/tourguidejs@0.0.26";

const { TourGuideClient } = TourGuidePackage;

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(globalThis.location.search);

/** 读取布尔型 URL 参数；未设置或写法不认识时使用默认值。 */
function readBooleanParam(name, fallback) {
  const raw = query.get(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["false", "0", "off"].includes(raw)) return false;
  if (["true", "1", "on"].includes(raw)) return true;
  return fallback;
}

/** 读取并对齐滑块参数，越界值会被限制在对应滑块范围内。 */
function readSliderParam(name, config) {
  const text = query.get(name);
  if (text === null) return config.value;
  const raw = Number(text);
  if (!Number.isFinite(raw)) return config.value;
  const snapped = config.min + Math.round((raw - config.min) / config.step) * config.step;
  return Number(Math.min(config.max, Math.max(config.min, snapped)).toFixed(6));
}

const DISPLAY_KEYS = Object.freeze([
  "sigma",
  "lineWidth",
  "markerSize",
  "border",
  "markers",
  "dark",
  "autoRotate",
  "advanceLight",
  "showLabels",
]);
const DISPLAY_SLIDER_CONFIGS = Object.freeze({
  sigma: SIGMA,
  lineWidth: LINE_WIDTH,
  markerSize: MARKER_SIZE,
});
const DISPLAY_BOOLEAN_KEYS = Object.freeze([
  "border",
  "markers",
  "dark",
  "autoRotate",
  "advanceLight",
  "showLabels",
]);
const DISPLAY_DEFAULTS = Object.freeze({
  sigma: SIGMA.value,
  lineWidth: LINE_WIDTH.value,
  markerSize: MARKER_SIZE.value,
  border: true,
  markers: false,
  dark: false,
  autoRotate: false,
  advanceLight: true,
  showLabels: false,
});
const CUSTOM_STORAGE_KEY = "chromosomal-structure-tools.custom-display";

const PRESETS = Object.freeze({
  raw: {
    label: "Raw",
    summary: "σ 0 · 12px · markers off · labels off",
    options: {
      sigma: 0,
      lineWidth: 12,
      markerSize: 2,
      markers: false,
      advanceLight: true,
      showLabels: false,
    },
  },
  "raw-marker": {
    label: "Raw-marker",
    summary: "σ 0 · 12px · markers on · size 6px · labels off",
    options: {
      sigma: 0,
      lineWidth: 12,
      markerSize: 6,
      markers: true,
      advanceLight: true,
      showLabels: false,
    },
  },
  smooth: {
    label: "Smooth",
    summary: "σ 1 · 12px · markers off · labels off",
    options: {
      sigma: 1,
      lineWidth: 12,
      markerSize: 2,
      markers: false,
      advanceLight: true,
      showLabels: false,
    },
  },
  flat: {
    label: "Flat",
    summary: "σ 1 · 12px · markers off · flat light · labels off",
    options: {
      sigma: 1,
      lineWidth: 12,
      markerSize: 2,
      markers: false,
      advanceLight: false,
      showLabels: false,
    },
  },
  "smooth-marker": {
    label: "Smooth-marker",
    summary: "σ 1 · 12px · markers on · size 6px · labels off",
    options: {
      sigma: 1,
      lineWidth: 12,
      markerSize: 6,
      markers: true,
      advanceLight: true,
      showLabels: false,
    },
  },
});
const PRESET_MATCH_KEYS = Object.freeze([
  "sigma",
  "lineWidth",
  "markerSize",
  "markers",
  "advanceLight",
  "showLabels",
]);

function normalizeSliderValue(value, config) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return config.value;
  const snapped = config.min + Math.round((raw - config.min) / config.step) * config.step;
  return Number(Math.min(config.max, Math.max(config.min, snapped)).toFixed(6));
}

/** 从 localStorage 读取并修正一份可安全应用的自定义显示配置。 */
function normalizeDisplay(candidate) {
  const normalized = { ...DISPLAY_DEFAULTS };
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return normalized;

  for (const [key, config] of Object.entries(DISPLAY_SLIDER_CONFIGS)) {
    normalized[key] = normalizeSliderValue(candidate[key], config);
  }
  for (const key of DISPLAY_BOOLEAN_KEYS) {
    if (typeof candidate[key] === "boolean") normalized[key] = candidate[key];
  }
  return normalized;
}

function loadCustomDisplay() {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return null;
    const candidate = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    return normalizeDisplay(candidate);
  } catch {
    // 隐私模式或禁用存储时，预设功能仍可正常使用，只是不持久化自定义配置。
    return null;
  }
}

// URL 只覆盖 Display 区域；未设置的项目继续使用界面默认值。
const initialDisplay = {
  sigma: readSliderParam("sigma", SIGMA),
  lineWidth: readSliderParam("lineWidth", LINE_WIDTH),
  markerSize: readSliderParam("markerSize", MARKER_SIZE),
  border: readBooleanParam("border", DISPLAY_DEFAULTS.border),
  markers: readBooleanParam("markers", DISPLAY_DEFAULTS.markers),
  dark: readBooleanParam("dark", DISPLAY_DEFAULTS.dark),
  autoRotate: readBooleanParam(
    "autoRotate",
    readBooleanParam("rotate", DISPLAY_DEFAULTS.autoRotate), // 兼容较直观的旧写法 rotate=true
  ),
  advanceLight: readBooleanParam("advanceLight", DISPLAY_DEFAULTS.advanceLight),
  showLabels: readBooleanParam("showLabels", DISPLAY_DEFAULTS.showLabels),
};

// 页面默认状态不写入 URL；第一次交互后，这份状态会作为完整参数集合写入。
const displayState = { ...initialDisplay };
const hasDisplayQuery = DISPLAY_KEYS.some((name) => query.has(name)) || query.has("rotate");
let savedCustomDisplay = loadCustomDisplay();
let activePreset = detectPreset(displayState);

/**
 * 计算 Worker 的地址：与 index.html 同目录（构建产物是 dist/worker.js，
 * 由 tools/build.mjs 从 src/worker.mjs 打包而来）。
 */
const WORKER_URL = "./worker.js";

const els = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  sample: $("load-sample"),
  statFile: $("stat-file"),
  statBins: $("stat-bins"),
  statPairs: $("stat-pairs"),
  statTime: $("stat-time"),
  progress: $("progress"),
  status: $("status"),
  colorLegend: $("color-legend"),
  legendEndpoints: [...document.querySelectorAll(".legend-endpoint")],
  badge: $("badge"),
  empty: $("empty"),
  sigma: $("sigma"),
  outSigma: $("out-sigma"),
  width: $("width"),
  outWidth: $("out-width"),
  markerSize: $("marker-size"),
  outMarker: $("out-marker"),
  markerField: $("marker-field"),
  border: $("opt-border"),
  markers: $("opt-markers"),
  dark: $("opt-dark"),
  rotate: $("opt-rotate"),
  advanceLight: $("opt-advance-light"),
  labels: $("opt-labels"),
  displayPresets: $("display-presets"),
  displayCustom: $("display-custom"),
  presetPanel: $("preset-panel"),
  customPanel: $("custom-panel"),
  presetButtons: [...document.querySelectorAll(".preset-option")],
  presetCustom: $("preset-custom"),
  customPresetSummary: $("custom-preset-summary"),
  presetNote: $("preset-note"),
  saveCustom: $("save-custom"),
  resetView: $("reset-view"),
  exportPng: $("export-png"),
  exportSvg: $("export-svg"),
  exportVideo: $("export-webm"),
  exportCoord: $("export-coord"),
  exportMatrix: $("export-matrix"),
  about: $("about"),
  tourOpen: $("tour-open"),
  aboutOpen: $("about-open"),
  aboutOpenFloat: $("about-open-float"),
  aboutClose: $("about-close"),
  format: $("format"),
  formatOpen: $("format-help-open"),
  formatClose: $("format-help-close"),
};

const viewer = new StructureViewer($("viewport"), {
  advanceLight: initialDisplay.advanceLight,
});
const worker = new Worker(WORKER_URL, { type: "module" });

// 调试句柄：浏览器控制台里可直接拿到查看器实例
globalThis.cstViewer = viewer;

worker.addEventListener("error", (event) => {
  setStatus(`Failed to load the computation worker: ${event.message || WORKER_URL}`, "error");
  setEmpty("Worker unavailable", "Open the page over HTTP (deno task dev / preview)");
  els.colorLegend.hidden = true;
});

// 滑块的取值范围与默认值以 viewer.js 导出的常量为准，避免两处走样
const SLIDERS = [
  [els.sigma, SIGMA, initialDisplay.sigma],
  [els.width, LINE_WIDTH, initialDisplay.lineWidth],
  [els.markerSize, MARKER_SIZE, initialDisplay.markerSize],
];
for (const [input, config, value] of SLIDERS) {
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);
  input.value = String(value);
}
els.outSigma.textContent = initialDisplay.sigma.toFixed(1);
setWidthLabel(initialDisplay.lineWidth);
setMarkerLabel(initialDisplay.markerSize);
els.border.checked = initialDisplay.border;
els.markers.checked = initialDisplay.markers;
els.dark.checked = initialDisplay.dark;
els.rotate.checked = initialDisplay.autoRotate;
els.advanceLight.checked = initialDisplay.advanceLight;
els.labels.checked = initialDisplay.showLabels;
setMarkerEnabled(initialDisplay.markers);

/** 各阶段在进度条上的区间占比 */
const STAGES = {
  parse: { label: "Parsing file", range: [0, 0.06] },
  matrix: { label: "Building full matrix", range: [0.06, 0.16] },
  distance: { label: "Shortest-path distances", range: [0.16, 0.72] },
  mds: { label: "MDS coordinates", range: [0.72, 0.98] },
};

const state = {
  name: "structure",
  coordinatesCsv: "",
  matrixCsv: "",
  busy: false,
  startedAt: 0,
};

let requestId = 0;
let tourPreviewLegend = false;

/* ------------------------------------------------------------- 计算 */

/**
 * 提交一份稀疏接触矩阵文本给 Worker。
 * @param {string} text
 * @param {string} name 用于导出文件名
 */
function run(text, name) {
  if (state.busy) return;
  state.busy = true;
  state.name = name.replace(/\.[^.]+$/, "") || "structure";
  state.startedAt = performance.now();
  setBusy(true);
  setProgress(0);
  setStatus("Parsing file…", "busy");
  els.colorLegend.hidden = true;
  setEmpty("Computing…", "Progress is shown in the panel");
  worker.postMessage({ id: ++requestId, text });
}

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.id !== requestId) return;

  if (message.type === "progress") {
    const stage = STAGES[message.stage];
    if (!stage) return;
    const [from, to] = stage.range;
    setProgress(from + (to - from) * message.ratio);
    setStatus(`${stage.label}…`, "busy");
    return;
  }

  if (message.type === "error") {
    state.busy = false;
    setBusy(false);
    setProgress(0);
    setStatus(`Computation failed: ${message.message}`, "error");
    els.colorLegend.hidden = true;
    setEmpty("Computation failed", "Check the file: every line needs i, j and contact");
    return;
  }

  const { size, pairs, coordinates, matrixCsv, coordinatesCsv } = message.payload;
  const elapsed = performance.now() - state.startedAt;

  state.coordinatesCsv = coordinatesCsv;
  state.matrixCsv = matrixCsv;
  state.busy = false;

  viewer.setStructure(coordinates, size);
  setProgress(1);
  setBusy(false);
  setStatus(`Done: ${size} bins in ${elapsed.toFixed(0)} ms`, "ok");
  els.colorLegend.hidden = false;
  tourPreviewLegend = false;

  els.statBins.textContent = String(size);
  els.statPairs.textContent = pairs.toLocaleString("en-US");
  els.statTime.textContent = `${elapsed.toFixed(0)} ms`;
  els.badge.innerHTML = `<b>${size}</b> bins × <b>${pairs.toLocaleString("en-US")}</b> contacts`;
  els.badge.hidden = false;
  setEmpty(null);
});

/* ------------------------------------------------------------- 界面 */

function setStatus(text, tone = "idle") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function setProgress(ratio) {
  els.progress.style.width = `${Math.min(1, Math.max(0, ratio)) * 100}%`;
}

/** 线宽滑块直接以像素为单位 */
function setWidthLabel(pixels) {
  els.outWidth.textContent = `${Math.round(pixels)}px`;
}

/**
 * 节点标记尺寸：标记直径 = 线宽 + 该值，0 就表示与线一样宽。
 * @param {number} extra
 */
function setMarkerLabel(extra) {
  els.outMarker.textContent = extra === 0 ? "0px · same as line" : `${extra}px`;
}

/** 标记关掉时把尺寸滑块淡下去，提示它当前不生效 */
function setMarkerEnabled(enabled) {
  els.markerField.classList.toggle("is-inactive", !enabled);
}

function displaysMatch(left, right, keys) {
  return keys.every((key) => left[key] === right[key]);
}

/** 根据当前 Display 状态决定应该高亮哪个预设。 */
function detectPreset(options) {
  // 有完整 URL 且正好等于已保存配置时，优先显示 Custom，方便刷新后保持选择。
  if (
    savedCustomDisplay &&
    hasDisplayQuery &&
    displaysMatch(options, savedCustomDisplay, DISPLAY_KEYS)
  ) {
    return "custom";
  }
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (displaysMatch(options, preset.options, PRESET_MATCH_KEYS)) return id;
  }
  if (savedCustomDisplay && displaysMatch(options, savedCustomDisplay, DISPLAY_KEYS)) {
    return "custom";
  }
  return null;
}

/** 把一份 Display 状态同步回 Custom 面板中的控件。 */
function updateDisplayControls(options) {
  if ("sigma" in options) {
    els.sigma.value = String(options.sigma);
    els.outSigma.textContent = Number(options.sigma).toFixed(1);
  }
  if ("lineWidth" in options) {
    els.width.value = String(options.lineWidth);
    setWidthLabel(options.lineWidth);
  }
  if ("markerSize" in options) {
    els.markerSize.value = String(options.markerSize);
    setMarkerLabel(options.markerSize);
  }
  if ("border" in options) els.border.checked = options.border;
  if ("markers" in options) {
    els.markers.checked = options.markers;
    setMarkerEnabled(options.markers);
  }
  if ("dark" in options) els.dark.checked = options.dark;
  if ("autoRotate" in options) els.rotate.checked = options.autoRotate;
  if ("advanceLight" in options) els.advanceLight.checked = options.advanceLight;
  if ("showLabels" in options) els.labels.checked = options.showLabels;
}

function setDisplayMode(mode) {
  const presets = mode === "presets";
  els.displayPresets.classList.toggle("is-active", presets);
  els.displayCustom.classList.toggle("is-active", !presets);
  els.displayPresets.setAttribute("aria-selected", String(presets));
  els.displayCustom.setAttribute("aria-selected", String(!presets));
  els.presetPanel.hidden = !presets;
  els.customPanel.hidden = presets;
}

function displaySummary(options) {
  const sigma = Number.isInteger(options.sigma) ? String(options.sigma) : options.sigma.toFixed(1);
  const marker = options.markers ? `markers on · size ${options.markerSize}px` : "markers off";
  const labels = options.showLabels ? "labels on" : "labels off";
  return `σ ${sigma} · ${options.lineWidth}px · ${marker} · ${labels}`;
}

function renderPresetState() {
  for (const button of els.presetButtons) {
    const active = button.dataset.preset === activePreset;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  const hasCustom = Boolean(savedCustomDisplay);
  els.presetCustom.hidden = !hasCustom;
  if (hasCustom) els.customPresetSummary.textContent = displaySummary(savedCustomDisplay);

  if (activePreset === "custom" && savedCustomDisplay) {
    els.presetNote.textContent = `Custom · ${displaySummary(savedCustomDisplay)} · saved locally`;
  } else if (activePreset && PRESETS[activePreset]) {
    const preset = PRESETS[activePreset];
    els.presetNote.textContent = `${preset.label} · ${preset.summary}`;
  } else {
    els.presetNote.textContent =
      "Current settings are custom; open Custom to adjust and save them.";
  }
}

/** 应用设置、刷新控件、同步 URL，并重新计算预设高亮。 */
function applyDisplayOptions(patch, presetId = null) {
  viewer.setOptions(patch);
  updateDisplayControls(patch);
  syncDisplayUrl(patch);
  activePreset = presetId ?? detectPreset(displayState);
  renderPresetState();
}

function saveCustomDisplay() {
  const custom = normalizeDisplay(displayState);
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("localStorage unavailable");
    storage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(custom));
  } catch {
    setStatus("Could not save custom preset in this browser", "error");
    return;
  }

  savedCustomDisplay = custom;
  syncDisplayUrl(custom);
  activePreset = "custom";
  renderPresetState();
  setDisplayMode("presets");
  setStatus("Custom preset saved locally", "ok");
}

/**
 * 舞台浮层提示（未载入数据 / 计算中 / 计算失败），传 null 表示隐藏。
 * @param {string|null} title
 * @param {string} [hint]
 */
function setEmpty(title, hint = "") {
  els.empty.hidden = !title;
  if (title) els.empty.innerHTML = `<strong>${title}</strong><span>${hint}</span>`;
}

/** 计算期间禁用会触发新计算或导出的按钮 */
function setBusy(busy) {
  const buttons = [
    els.sample,
    els.exportPng,
    els.exportSvg,
    els.exportVideo,
    els.exportCoord,
    els.exportMatrix,
  ];
  for (const button of buttons) {
    button.disabled = busy || (button !== els.sample && !state.coordinatesCsv);
  }
  els.dropzone.style.pointerEvents = busy ? "none" : "";
  els.dropzone.style.opacity = busy ? "0.6" : "";
}

/**
 * 触发浏览器下载。
 * @param {Blob} blob
 * @param {string} filename
 */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 读取用户选择的文件并开始计算。
 * @param {File} file
 */
async function loadFile(file) {
  els.statFile.textContent = file.name;
  try {
    run(await file.text(), file.name);
  } catch (error) {
    setStatus(`Cannot read the file: ${error.message}`, "error");
  }
}

/**
 * 把发生变化的 Display 选项同步到地址栏。
 * 任意选项第一次变化后，完整写入所有 Display 参数，便于复制链接后精确复现。
 * @param {Partial<typeof initialDisplay>} patch
 */
function syncDisplayUrl(patch) {
  Object.assign(displayState, patch);
  const url = new URL(globalThis.location.href);
  for (const [name, value] of Object.entries(displayState)) {
    url.searchParams.set(name, String(value));
  }
  // 统一使用 autoRotate 作为规范参数名，避免留下兼容用的 rotate 别名。
  if ("autoRotate" in patch) url.searchParams.delete("rotate");
  globalThis.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/* ------------------------------------------------------------- 事件 */

els.displayPresets.addEventListener("click", () => setDisplayMode("presets"));
els.displayCustom.addEventListener("click", () => setDisplayMode("custom"));
for (const button of els.presetButtons) {
  button.addEventListener("click", () => {
    const id = button.dataset.preset;
    if (id === "custom") {
      if (!savedCustomDisplay) return;
      applyDisplayOptions(savedCustomDisplay, "custom");
    } else if (id && PRESETS[id]) {
      applyDisplayOptions(PRESETS[id].options, id);
    }
    setDisplayMode("presets");
  });
}
els.saveCustom.addEventListener("click", saveCustomDisplay);

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) loadFile(file);
  els.fileInput.value = "";
});

els.sample.addEventListener("click", () => {
  els.statFile.textContent = "sparseMat_Normalized.metrics (sample)";
  run(sampleText, "sparseMat_Normalized");
});

for (const type of ["dragenter", "dragover"]) {
  globalThis.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  globalThis.addEventListener(type, (event) => {
    if (type === "dragleave" && event.relatedTarget) return;
    els.dropzone.classList.remove("dragging");
  });
}
globalThis.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

els.sigma.addEventListener("input", () => {
  const sigma = Number(els.sigma.value);
  applyDisplayOptions({ sigma });
});
els.width.addEventListener("input", () => {
  const lineWidth = Number(els.width.value);
  applyDisplayOptions({ lineWidth });
});
els.markerSize.addEventListener("input", () => {
  const markerSize = Number(els.markerSize.value);
  applyDisplayOptions({ markerSize });
});
els.border.addEventListener("change", () => {
  const border = els.border.checked;
  applyDisplayOptions({ border });
});
els.markers.addEventListener("change", () => {
  const markers = els.markers.checked;
  applyDisplayOptions({ markers });
});
els.dark.addEventListener("change", () => {
  const dark = els.dark.checked;
  applyDisplayOptions({ dark });
});
els.rotate.addEventListener("change", () => {
  const autoRotate = els.rotate.checked;
  applyDisplayOptions({ autoRotate });
});
els.advanceLight.addEventListener("change", () => {
  const enabled = els.advanceLight.checked;
  applyDisplayOptions({ advanceLight: enabled });
});
els.labels.addEventListener("change", () => {
  const showLabels = els.labels.checked;
  applyDisplayOptions({ showLabels });
});
for (const endpoint of els.legendEndpoints) {
  let hovering = false;
  let focused = false;
  const updateFocus = () => {
    viewer.setEndpointFocus(hovering || focused ? endpoint.dataset.endpoint : null);
  };
  endpoint.addEventListener("pointerenter", () => {
    hovering = true;
    updateFocus();
  });
  endpoint.addEventListener("pointerleave", () => {
    hovering = false;
    updateFocus();
  });
  endpoint.addEventListener("focus", () => {
    focused = true;
    updateFocus();
  });
  endpoint.addEventListener("blur", () => {
    focused = false;
    updateFocus();
  });
}
els.resetView.addEventListener("click", () => viewer.resetView());

globalThis.addEventListener("keydown", (event) => {
  // 弹窗打开时把快捷键让给它：Esc 关弹窗，R 不碰后面的模型
  const sheet = document.querySelector("dialog[open]");
  if (sheet) {
    if (event.key === "Escape") sheet.close();
    return;
  }
  if (event.key.toLowerCase() === "r" && !/input|textarea/i.test(event.target.tagName)) {
    viewer.resetView();
  }
});

/* ------------------------------------------------------------- About */

/** 清掉地址栏里的 #about（replaceState 不会触发 hashchange，不会绕回来） */
function clearAboutHash() {
  if (globalThis.location.hash !== "#about") return;
  globalThis.history.replaceState(
    null,
    "",
    globalThis.location.pathname + globalThis.location.search,
  );
}

/** 打开 About（用 #about 记录，便于分享直达链接） */
function openAbout() {
  if (els.about.open) return;
  els.about.showModal();
  if (globalThis.location.hash !== "#about") globalThis.location.hash = "about";
}

/** 关闭 About，并清掉地址栏里的 #about */
function closeAbout() {
  if (!els.about.open) return;
  els.about.close();
  clearAboutHash();
}

els.aboutOpen.addEventListener("click", openAbout);
els.aboutOpenFloat.addEventListener("click", openAbout);
els.aboutClose.addEventListener("click", closeAbout);

els.about.addEventListener("click", (event) => {
  // 点遮罩关闭：点到 dialog 自身就是点到了内容区外面
  if (event.target === els.about) closeAbout();
});
// Esc 由 <dialog> 原生关闭；这里兜底清理一下 URL，并兼容个别环境不派发 close 的情况
els.about.addEventListener("close", clearAboutHash);
els.about.addEventListener("cancel", clearAboutHash);

// 支持直接打开 …/#about，也支持在地址栏里手动改 hash（同文档导航不会重跑脚本）
if (globalThis.location.hash === "#about") openAbout();
globalThis.addEventListener("hashchange", () => {
  if (globalThis.location.hash === "#about") openAbout();
  else closeAbout();
});

/* ------------------------------------------------------- 输入格式说明 */

/** 打开输入格式弹窗 */
function openFormat() {
  if (els.format.open) return;
  els.format.showModal();
}

els.formatOpen.addEventListener("click", openFormat);
els.formatClose.addEventListener("click", () => els.format.close());
els.format.addEventListener("click", (event) => {
  // 点遮罩关闭：点到 dialog 自身就是点到了内容区外面
  if (event.target === els.format) els.format.close();
});

els.exportPng.addEventListener("click", async () => {
  try {
    download(await viewer.snapshot(), `${state.name}.png`);
    setStatus("PNG image exported", "ok");
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, "error");
  }
});

els.exportSvg.addEventListener("click", () => {
  try {
    const svg = viewer.toSvg();
    download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${state.name}.svg`);
    setStatus("SVG vector exported", "ok");
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, "error");
  }
});

els.exportVideo.addEventListener("click", async () => {
  const restore = els.exportVideo.textContent;
  els.exportVideo.disabled = true;
  els.exportVideo.textContent = "Recording…";
  setStatus("Recording one full rotation (6 s)…", "busy");
  try {
    const blob = await viewer.recordRotation({
      duration: 6,
      fps: 30,
      onProgress: (ratio) => setProgress(ratio),
    });
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    download(blob, `${state.name}_rotation.${extension}`);
    setStatus(`Rotation video exported (${extension.toUpperCase()})`, "ok");
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, "error");
  } finally {
    els.exportVideo.textContent = restore;
    els.exportVideo.disabled = false;
    setProgress(1);
  }
});

els.exportCoord.addEventListener("click", () => {
  download(new Blob([state.coordinatesCsv], { type: "text/csv" }), `${state.name}_coord.csv`);
  setStatus("Coordinates CSV exported", "ok");
});

els.exportMatrix.addEventListener("click", () => {
  download(new Blob([state.matrixCsv], { type: "text/csv" }), `${state.name}_matrix.csv`);
  setStatus("Full matrix CSV exported", "ok");
});

/* ---------------------------------------------------------- 引导 tour */

// 数据尚未加载时 legend 会隐藏；进入对应步骤时临时展示一份图例预览，避免引导指向空白位置。

function showTourLegendPreview() {
  if (tourPreviewLegend || !els.colorLegend.hidden) return;
  els.colorLegend.hidden = false;
  tourPreviewLegend = true;
}

function restoreTourLegendPreview() {
  if (!tourPreviewLegend) return;
  els.colorLegend.hidden = true;
  tourPreviewLegend = false;
}

const tour = new TourGuideClient({
  steps: [
    {
      order: 1,
      title: "About",
      target: "#about-open",
      content:
        "<p>Open <strong>About</strong> to read what this viewer does, how the Hi-C data becomes a 3D chromosome, and where the project comes from.</p>",
    },
    {
      order: 2,
      title: "Load data",
      target: "#dropzone",
      content:
        "<p>Drop a sparse contact file here, or click this area to choose one. You can also use <strong>Load sample data</strong> below it to try chromosome 1 immediately.</p>",
    },
    {
      order: 3,
      title: "Input format",
      target: "#format-help-open",
      content:
        "<p>The <strong>?</strong> button explains the accepted <code>i&nbsp;&nbsp;j&nbsp;&nbsp;contact</code> columns, separators, comments, and example rows.</p>",
    },
    {
      order: 4,
      title: "Chromosome direction",
      target: ".legend-bar",
      beforeEnter: showTourLegendPreview,
      afterLeave: restoreTourLegendPreview,
      content:
        "<p>This colour bar follows the chromosome from <strong>5′</strong> to <strong>3′</strong>. Hover either endpoint label to keep that end bright and fade the rest of the structure.</p>",
    },
    {
      order: 5,
      title: "Reset view",
      target: "#reset-view",
      content:
        "<p><strong>Reset view</strong> restores the model's starting rotation, zoom, and pan when you want to get back to a clear overview.</p>",
    },
    {
      order: 6,
      title: "Presets",
      target: "#preset-panel",
      beforeEnter: () => setDisplayMode("presets"),
      content:
        "<p><strong>Presets</strong> are quick display modes such as Raw, Smooth, Flat, and marker variants. Use <strong>Custom</strong> when you want to tune the sliders and switches yourself.</p>",
    },
    {
      order: 7,
      title: "Export",
      target: "#export-block",
      content:
        "<p>When data is ready, export a PNG, SVG, rotation video, coordinates CSV, or full matrix CSV from this section.</p>",
    },
  ],
  dialogClass: "cst-tour-dialog",
  dialogZ: 10000,
  backdropColor: "rgba(13, 16, 21, 0.78)",
  targetPadding: 10,
  dialogMaxWidth: 360,
  nextLabel: "Next",
  prevLabel: "Back",
  finishLabel: "Done",
  progressBar: "#5aa9ff",
  completeOnFinish: false,
  rememberStep: false,
  debug: false,
  autoScroll: true,
  autoScrollSmooth: true,
  activeStepInteraction: true,
});

tour.onBeforeExit(restoreTourLegendPreview);

function startTour() {
  tour.start().catch((error) => {
    console.warn("Could not start the guided tour", error);
  });
}

els.tourOpen.addEventListener("click", startTour);
globalThis.cstTour = tour;

/* ------------------------------------------------------------- 启动 */

renderPresetState();
setDisplayMode(activePreset ? "presets" : "custom");

viewer.setOptions({
  ...initialDisplay,
});

// 打开页面即加载示例数据，方便直接看到效果
els.statFile.textContent = "sparseMat_Normalized.metrics (sample)";
run(sampleText, "sparseMat_Normalized");
