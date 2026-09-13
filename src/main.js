/**
 * 页面主控制器：文件输入 → Worker 计算 → three.js 渲染 → 导出。
 */
import sampleText from "../test/data/sparseMat_Normalized.metrics" with { type: "text" };
import { LINE_WIDTH, MARKER_SIZE, SIGMA, StructureViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);

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
    resetView: $("reset-view"),
    exportPng: $("export-png"),
    exportSvg: $("export-svg"),
    exportVideo: $("export-webm"),
    exportCoord: $("export-coord"),
    exportMatrix: $("export-matrix"),
    about: $("about"),
    aboutOpen: $("about-open"),
    aboutOpenFloat: $("about-open-float"),
    aboutClose: $("about-close"),
    format: $("format"),
    formatOpen: $("format-help-open"),
    formatClose: $("format-help-close"),
};

const viewer = new StructureViewer($("viewport"));
const worker = new Worker(WORKER_URL, { type: "module" });

// 调试句柄：浏览器控制台里可直接拿到查看器实例
globalThis.cstViewer = viewer;

worker.addEventListener("error", (event) => {
    setStatus(`Failed to load the computation worker: ${event.message || WORKER_URL}`, "error");
    setEmpty("Worker unavailable", "Open the page over HTTP (deno task dev / preview)");
});

// 滑块的取值范围与默认值以 viewer.js 导出的常量为准，避免两处走样
const SLIDERS = [
    [els.sigma, SIGMA],
    [els.width, LINE_WIDTH],
    [els.markerSize, MARKER_SIZE],
];
for (const [input, config] of SLIDERS) {
    input.min = String(config.min);
    input.max = String(config.max);
    input.step = String(config.step);
    input.value = String(config.value);
}
els.outSigma.textContent = SIGMA.value.toFixed(1);
setWidthLabel(LINE_WIDTH.value);
setMarkerLabel(MARKER_SIZE.value);
setMarkerEnabled(els.markers.checked);

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

/* ------------------------------------------------------------- 事件 */

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
    els.outSigma.textContent = sigma.toFixed(1);
    viewer.setOptions({ sigma });
});
els.width.addEventListener("input", () => {
    const lineWidth = Number(els.width.value);
    setWidthLabel(lineWidth);
    viewer.setOptions({ lineWidth });
});
els.markerSize.addEventListener("input", () => {
    const markerSize = Number(els.markerSize.value);
    setMarkerLabel(markerSize);
    viewer.setOptions({ markerSize });
});
els.border.addEventListener("change", () => viewer.setOptions({ border: els.border.checked }));
els.markers.addEventListener("change", () => {
    setMarkerEnabled(els.markers.checked);
    viewer.setOptions({ markers: els.markers.checked });
});
els.dark.addEventListener("change", () => viewer.setOptions({ dark: els.dark.checked }));
els.rotate.addEventListener("change", () => viewer.setOptions({ autoRotate: els.rotate.checked }));
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

/* ------------------------------------------------------------- 启动 */

viewer.setOptions({
    sigma: Number(els.sigma.value),
    lineWidth: Number(els.width.value),
    markerSize: Number(els.markerSize.value),
    border: els.border.checked,
    markers: els.markers.checked,
    dark: els.dark.checked,
    autoRotate: els.rotate.checked,
});

// 打开页面即加载示例数据，方便直接看到效果
els.statFile.textContent = "sparseMat_Normalized.metrics (sample)";
run(sampleText, "sparseMat_Normalized");
