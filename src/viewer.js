/**
 * three.js 三维结构查看器。
 *
 * 与旧版「伪 3D」SVG 的关键差别：
 *   · 真正的三维场景，带透视投影与 z-buffer 深度遮挡
 *   · 染色质链用「圆柱段 + 球形连接处」组成的 3D 胶囊链，逐段彩虹着色
 *   · 描边 / 节点标记分别用「下层放大一档的副本」实现，与原视觉一致
 *   · 相机固定在参考系里不动，拖动直接旋转模型：四元数累积，可以转过 360°
 *     以上也不会翻面；自转轴取屏幕竖直方向，永远落在视平面内
 *   · 可导出 PNG 截图与自转一周的 WebM 视频
 */
import * as THREE from "npm:three@0.186.0";
import { gaussianSmooth1d } from "./core.mjs";

/** 画布背景色 */
const BACKGROUND = { light: 0xf2f5fa, dark: 0x0b0e13 };
/** 5' / 3' 标注文字颜色，随背景反转 */
const LABEL_COLOR = { light: "#101828", dark: "#e8edf6" };
/** 描边与节点外圈颜色：深色背景下用浅色，否则黑边会融进背景 */
const BORDER_COLOR = { light: 0x000000, dark: 0xe8edf6 };

/** 线宽的取值范围（像素）：默认 12px，与原实现的基准一致 */
export const LINE_WIDTH = { min: 1, max: 36, step: 1, value: 12 };
/** 平滑 σ 的默认值与滑块范围；0 表示完全不平滑 */
export const SIGMA = { min: 0, max: 4, step: 0.1, value: 1 };
/**
 * 节点标记尺寸（像素）：在链宽之外多加这么多，0 表示与线一样宽。
 * 即标记直径 = 线宽 + 该值。
 */
export const MARKER_SIZE = { min: 0, max: 24, step: 1, value: 2 };
/** 描边比链本身宽出的像素数 */
const BORDER_EXTRA_PIXELS = 2.5;
/** 拖动一像素对应的旋转弧度 */
const ROTATE_SPEED = 0.008;
/** 自动旋转角速度（弧度/秒） */
const AUTO_ROTATE_SPEED = 0.5;
/** 初始取景的留白系数：略大于 1，给两端的 5' / 3' 标注留出位置 */
const FIT_MARGIN = 1.18;

/** 5' / 3' 标注：文字像素高度 = 该倍数 × 线宽像素（线越粗，字越大） */
const LABEL_PIXELS_PER_LINE = 2;
/** 字号下限：线宽最细只有 1px，此时文字仍需可读 */
const LABEL_MIN_FONT_PX = 10;
/** 字形在文字贴图里的半高占比（贴图上下留白），用于把字紧贴在节点球外侧 */
const LABEL_GLYPH_HALF = 0.25;
/** 文字与端点之间的空隙（像素） */
const LABEL_GAP_PIXELS = 2;
/** 文字贴图的绘制字号：画得比屏幕尺寸大再缩小，保证任何线宽下都清晰 */
const LABEL_FONT_PX = 128;
/** 贴图里字形（em 框）占整张图高度的比例，SVG 导出时据此换算 font-size */
const LABEL_FONT_RATIO = 1 / 1.42;
/** 标注文字的字族（WebGL 贴图用，canvas 里双引号合法） */
const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** SVG 属性里改用单引号，否则双引号会把 XML 属性提前截断 */
const LABEL_FONT_FAMILY_SVG = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** 复用的临时四元数，避免每帧分配 */
const SCRATCH_QUATERNION = new THREE.Quaternion();
/** 圆柱侧面的分段数；12 段已经能看出圆柱明暗，又不会给每个 bin 造成过多三角形 */
const CAPSULE_RADIAL_SEGMENTS = 12;
/** 球形节点的纵向分段数 */
const CAPSULE_SPHERE_SEGMENTS = 8;
const UNIT_Y = new THREE.Vector3(0, 1, 0);

export class StructureViewer {
  /**
   * @param {HTMLElement} container 承载画布的容器
   * @param {{advanceLight?: boolean, showLabels?: boolean}} [config]
   *   是否启用高级光照与 5'/3' 标注
   */
  constructor(container, config = {}) {
    this.container = container;
    this.options = {
      sigma: SIGMA.value, // 平滑 σ，默认 1
      lineWidth: LINE_WIDTH.value, // 线宽（像素），默认 12
      markerSize: MARKER_SIZE.value, // 节点标记比线宽多出的像素，0 = 与线同宽
      border: true,
      markers: false, // 节点标记默认关闭
      dark: false, // 浅色背景
      autoRotate: false,
      advanceLight: config.advanceLight ?? true,
      showLabels: config.showLabels ?? false,
    };

    this.raw = null;
    this.centered = null;
    this.count = 0;
    this._scale = 1;
    this._materials = [];
    this._geometries = [];

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true, // 便于 canvas.toBlob / captureStream 取帧
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND.light);

    // 真实 3D 网格需要光照才能显出圆柱和球体的体积感。
    this._hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x172033, 1.35);
    this._keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this._keyLight.position.set(3, 4, 5);
    this._setAdvancedLight(this.options.advanceLight);

    // 相机固定在参考系里：朝向与方向永不改变，只沿视线前后移动做缩放。
    this._direction = new THREE.Vector3(0.52, 0.38, 1).normalize();
    this._distance = 3.6;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    this._screenRight = new THREE.Vector3(1, 0, 0);
    this._screenUp = new THREE.Vector3(0, 1, 0);

    // 5' / 3' 标注：位置每帧按屏幕投影重算，所以不挂在 group 上
    this._labels = [];
    this._forward = new THREE.Vector3();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._applyCamera();

    // 模型的旋转与平移都作用在这个组上；组的局部原点即点云质心（见 _center）
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._recording = false;
    this._raf = 0;
    this._last = performance.now();

    this._attachControls();
    this._observer = new ResizeObserver(() => this._resize());
    this._observer.observe(container);
    this._resize();
    this._loop();
  }

  /* ------------------------------------------------------------ 视角 */

  /**
   * 把相机放到固定方向的给定距离上，并刷新屏幕坐标系。
   * 方向与 up 恒定 ⇒ 相机相对参考系的姿态不变，只有距离在变。
   */
  _applyCamera() {
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(this._direction).multiplyScalar(this._distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    // 屏幕水平 / 竖直方向（两者都落在视平面内）：自转轴取竖直方向
    this._screenRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    this._screenUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();

    this._updateLabels(); // 标注尺寸与世界→像素换算都依赖当前相机
  }

  /**
   * 绕屏幕竖直轴自转模型。轴承落在视平面内，因此不论拖过多少圈，
   * 画面都不会出现翻面或角度塌陷。
   * @param {number} angle 旋转弧度
   */
  spin(angle) {
    if (!angle) return;
    this.group.quaternion
      .premultiply(SCRATCH_QUATERNION.setFromAxisAngle(this._screenUp, angle))
      .normalize();
  }

  /**
   * 拖动：横向绕屏幕竖直轴自转，纵向绕屏幕水平轴俯仰。
   * 都是世界空间的前乘，可以累积超过 360°。
   * @param {number} deltaX 指针横向位移（像素）
   * @param {number} deltaY 指针纵向位移（像素）
   */
  rotate(deltaX, deltaY) {
    const quaternion = this.group.quaternion;
    if (deltaX) {
      quaternion
        .premultiply(SCRATCH_QUATERNION.setFromAxisAngle(this._screenUp, deltaX * ROTATE_SPEED))
        .normalize();
    }
    if (deltaY) {
      quaternion
        .premultiply(SCRATCH_QUATERNION.setFromAxisAngle(this._screenRight, deltaY * ROTATE_SPEED))
        .normalize();
    }
  }

  /**
   * 平移：模型沿屏幕平面移动，旋转中心仍是模型自身质心。
   * @param {number} deltaX
   * @param {number} deltaY
   */
  pan(deltaX, deltaY) {
    const scale = this._distance * 0.0022; // 与相机距离挂钩，缩放手感一致
    this.group.position
      .addScaledVector(this._screenRight, deltaX * scale)
      .addScaledVector(this._screenUp, -deltaY * scale);
  }

  /**
   * 缩放：相机只沿视线方向前后移动。
   * @param {number} factor >1 拉远，<1 拉近
   */
  zoom(factor) {
    const radius = this._radius();
    this._distance = Math.min(
      radius * 14,
      Math.max(radius * 0.35, this._distance * factor),
    );
    this._applyCamera();
  }

  /** 安装指针交互：左键旋转模型、右键（或 Shift）平移、滚轮/双指缩放 */
  _attachControls() {
    const element = this.renderer.domElement;
    element.style.touchAction = "none";
    element.addEventListener("contextmenu", (event) => event.preventDefault());

    /** @type {Map<number, {x: number, y: number}>} */
    const pointers = new Map();
    let mode = null;
    let pinchDistance = 0;

    element.addEventListener("pointerdown", (event) => {
      element.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        mode = "pinch";
        return;
      }
      mode = event.button === 2 || event.shiftKey ? "pan" : "rotate";
      element.classList.add("dragging");
    });

    element.addEventListener("pointermove", (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const deltaX = event.clientX - previous.x;
      const deltaY = event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;

      if (mode === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance > 0 && distance > 0) this.zoom(pinchDistance / distance);
        pinchDistance = distance;
        return;
      }
      if (mode === "pan") this.pan(deltaX, deltaY);
      else if (mode === "rotate") this.rotate(deltaX, deltaY);
    });

    const release = (event) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size === 0) {
        mode = null;
        element.classList.remove("dragging");
      } else if (pointers.size === 1) {
        mode = "rotate";
      }
    };
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);

    element.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoom(Math.exp(event.deltaY * 0.0012));
      },
      { passive: false },
    );
  }

  /* ------------------------------------------------------------ 数据 */

  /**
   * 载入新的坐标集。
   * @param {Float64Array} coordinates 行优先 n×3 坐标
   * @param {number} count 点个数
   */
  setStructure(coordinates, count) {
    this.raw = coordinates;
    this.count = count;
    this._center();
    this._build();
    this.resetView();
  }

  /** 是否已有可视化的结构 */
  get hasStructure() {
    return this.count > 1;
  }

  /**
   * 更新显示选项。
   * @param {Partial<{sigma: number, lineWidth: number, markerSize: number, border: boolean,
   *   markers: boolean, dark: boolean, autoRotate: boolean, advanceLight: boolean,
   *   showLabels: boolean}>} patch
   */
  setOptions(patch) {
    // 深色背景同时影响描边、节点外圈与 5'/3' 标注的取色，因此也要重建
    const rebuildKeys = [
      "sigma",
      "lineWidth",
      "markerSize",
      "border",
      "markers",
      "dark",
      "advanceLight",
      "showLabels",
    ];
    const needsRebuild = rebuildKeys.some(
      (key) => key in patch && patch[key] !== this.options[key],
    );
    const lightingChanged = "advanceLight" in patch &&
      patch.advanceLight !== this.options.advanceLight;
    Object.assign(this.options, patch);

    if (lightingChanged) this._setAdvancedLight(this.options.advanceLight);

    if ("dark" in patch) {
      this.scene.background = new THREE.Color(
        this.options.dark ? BACKGROUND.dark : BACKGROUND.light,
      );
    }
    if (needsRebuild && this.raw) this._build();
  }

  /** 重置模型姿态与相机距离，回到能完整容纳当前结构的视角 */
  resetView() {
    const radius = this._radius();
    const fov = (this.camera.fov * Math.PI) / 180;

    this.group.quaternion.identity();
    this.group.position.set(0, 0, 0);
    this._distance = (radius / Math.sin(fov / 2)) * FIT_MARGIN;
    this._applyCamera();
  }

  /* ------------------------------------------------------------ 渲染 */

  /** 渲染一帧并取 PNG Blob */
  async snapshot() {
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))),
        "image/png",
      );
    });
  }

  /**
   * 导出当前视图为 SVG 矢量图。
   *
   * WebGL 端的链现在由实例化的圆柱和球体组成，带有真正的光照和三维遮挡；
   * SVG 是平面矢量格式，不能直接复现 WebGL 的光照，因此这里按屏幕投影生成
   * 一个轻量的二维矢量近似：
   *
   *   · 链：逐段带 round cap/join 的 <line>，颜色取自 jet 色带，按深度由远及近绘制
   *   · 描边：一条比链宽 2.5px 的黑色（深色背景下为浅色）路径垫在链下方
   *   · 节点标记：逐点 <circle>，直径为「线宽 + 标记尺寸」
   *   · 5' / 3'：<text>，位置与字号和屏幕上看到的一致
   *
   * @returns {string} 完整的 SVG 文档
   */
  toSvg() {
    const canvas = this.renderer.domElement;
    const width = Math.round(canvas.clientWidth || 1);
    const height = Math.round(canvas.clientHeight || 1);

    const dark = this.options.dark;
    const lineWidth = this.options.lineWidth;
    const segments = [];
    const points = [];

    if (this.count >= 2) {
      this._projectCurve(this._curve(), this.count, width, height, segments, points);
      // 由远及近（画家算法）：后画的近处链段盖住远处的，模拟 z-buffer 遮挡
      segments.sort((a, b) => b.depth - a.depth);
      points.sort((a, b) => b.depth - a.depth);
    }

    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
      ` viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" fill="${
        hexString(dark ? BACKGROUND.dark : BACKGROUND.light)
      }"/>`,
      '<g stroke-linecap="round" stroke-linejoin="round" fill="none">',
    ];

    if (this.options.border && segments.length > 0) {
      // 描边是一整条路径：同色同宽，且必须整体垫在彩色链下方
      const d = segments
        .map((s) => `M${round(s.x1)} ${round(s.y1)}L${round(s.x2)} ${round(s.y2)}`)
        .join("");
      parts.push(
        `<path stroke="${
          hexString(
            dark ? BORDER_COLOR.dark : BORDER_COLOR.light,
          )
        }" stroke-width="${round(lineWidth + BORDER_EXTRA_PIXELS)}" d="${d}"/>`,
      );
    }

    for (const s of segments) {
      parts.push(
        `<line x1="${round(s.x1)}" y1="${round(s.y1)}" x2="${round(s.x2)}" y2="${
          round(
            s.y2,
          )
        }" stroke="${s.color}" stroke-width="${round(lineWidth)}"/>`,
      );
    }
    parts.push("</g>");

    if (this.options.markers) {
      const diameter = lineWidth + this.options.markerSize;
      const outer = round((diameter + BORDER_EXTRA_PIXELS) / 2);
      const inner = round(diameter / 2);
      const stroke = hexString(dark ? BORDER_COLOR.dark : BORDER_COLOR.light);
      for (const p of points) {
        parts.push(
          `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${outer}" fill="${stroke}"/>`,
        );
      }
      for (const p of points) {
        parts.push(
          `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${inner}" fill="${p.color}"/>`,
        );
      }
    }

    for (const item of this._labelLayout(width, height)) {
      parts.push(
        `<text x="${round(item.x)}" y="${round(item.y)}" fill="${
          dark ? LABEL_COLOR.dark : LABEL_COLOR.light
        }" font-family="${LABEL_FONT_FAMILY_SVG}" font-size="${round(item.fontPx)}"` +
          ` font-weight="600" text-anchor="middle" dominant-baseline="central">${item.text}</text>`,
      );
    }

    parts.push("</svg>");
    return parts.join("\n");
  }

  /**
   * 把平滑后的链投影成屏幕上的线段与节点（供 SVG 导出使用）。
   *
   * @param {Float64Array} curve 行优先 n×3 坐标（已平滑、已缩放）
   * @param {number} n
   * @param {number} width
   * @param {number} height
   * @param {Array<{x1: number, y1: number, x2: number, y2: number, depth: number, color: string}>}
   *   segments 输出：逐段线段
   * @param {Array<{x: number, y: number, depth: number, color: string}>} points 输出：逐点节点
   */
  _projectCurve(curve, n, width, height, segments, points) {
    const dark = this.options.dark;
    const quaternion = this.group.quaternion;
    const position = this.group.position;
    const margin = this.options.lineWidth * 2; // 视口外的段落整段丢弃

    let px = 0;
    let py = 0;
    let depth = 0;
    let visible = false;

    for (let i = 0; i < n; i++) {
      const world = this._tmpA
        .set(curve[i * 3], curve[i * 3 + 1], curve[i * 3 + 2])
        .applyQuaternion(quaternion)
        .add(position);
      const z = world.distanceTo(this.camera.position);
      const ndc = this._tmpB.copy(world).project(this.camera);
      const x = (ndc.x * 0.5 + 0.5) * width;
      const y = (1 - (ndc.y * 0.5 + 0.5)) * height;
      const color = jetHex(1 - i / (n - 1), dark);
      const onScreen = x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;

      points.push({ x, y, depth: z, color });
      if (i > 0 && (onScreen || visible)) {
        segments.push({ x1: px, y1: py, x2: x, y2: y, depth: (depth + z) / 2, color });
      }

      px = x;
      py = y;
      depth = z;
      visible = onScreen;
    }
  }

  /**
   * 录制模型自转一周的视频。
   *
   * 旋转的是模型而不是相机，自转轴取屏幕竖直方向（落在视平面内），
   * 所以整段视频里轴承始终平行于视平面，结尾回到起始姿态、可无缝循环。
   *
   * @param {{duration?: number, fps?: number, onProgress?: (ratio: number) => void}} [config]
   * @returns {Promise<Blob>}
   */
  async recordRotation({ duration = 6, fps = 30, onProgress } = {}) {
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not available in this browser; cannot record video.");
    }
    const canvas = this.renderer.domElement;
    const stream = canvas.captureStream(fps);
    const mimeType = pickVideoMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined,
    );
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve));

    this._recording = true;
    cancelAnimationFrame(this._raf);
    recorder.start();

    const turn = Math.PI * 2;
    let turned = 0;

    await new Promise((resolve) => {
      const started = performance.now();
      const total = duration * 1000;
      const step = () => {
        const t = Math.min(1, (performance.now() - started) / total);
        this.spin(t * turn - turned);
        turned = t * turn;
        this._updateLabels();
        this.renderer.render(this.scene, this.camera);
        if (onProgress) onProgress(t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });

    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());

    this._recording = false;
    this._last = performance.now();
    this._loop();

    return new Blob(chunks, { type: mimeType || "video/webm" });
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._observer.disconnect();
    this._clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ------------------------------------------------------------ 内部 */

  _loop() {
    this._raf = requestAnimationFrame(() => {
      if (this._recording) return;
      const now = performance.now();
      const elapsed = Math.min(0.1, (now - this._last) / 1000); // 掉帧时限制步长
      this._last = now;

      // 自动旋转同样绕屏幕竖直轴自转，轴承不会离开视平面
      if (this.options.autoRotate && this.hasStructure) this.spin(AUTO_ROTATE_SPEED * elapsed);

      this._updateLabels();
      this.renderer.render(this.scene, this.camera);
      this._loop();
    });
  }

  _resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    // 必须同时更新 CSS 尺寸与绘图缓冲区，否则画布会按缓冲区尺寸撑开容器
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this._updateLabels();
  }

  /** 去质心并计算统一缩放，使点云落在半径约 1 的球内 */
  _center() {
    const n = this.count;
    const raw = this.raw;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += raw[i * 3];
      cy += raw[i * 3 + 1];
      cz += raw[i * 3 + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;

    this.centered = new Float64Array(n * 3);
    let span = 0;
    for (let i = 0; i < n; i++) {
      const x = raw[i * 3] - cx;
      const y = raw[i * 3 + 1] - cy;
      const z = raw[i * 3 + 2] - cz;
      this.centered[i * 3] = x;
      this.centered[i * 3 + 1] = y;
      this.centered[i * 3 + 2] = z;
      span = Math.max(span, Math.abs(x), Math.abs(y), Math.abs(z));
    }
    this._scale = span > 0 ? 1 / span : 1;
  }

  /** 平滑后（并已缩放）的坐标 */
  _curve() {
    const n = this.count;
    const out = new Float64Array(n * 3);
    const axis = new Float64Array(n);
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < n; i++) axis[i] = this.centered[i * 3 + a];
      const smoothed = gaussianSmooth1d(axis, this.options.sigma);
      for (let i = 0; i < n; i++) out[i * 3 + a] = smoothed[i] * this._scale;
    }
    return out;
  }

  _radius() {
    if (!this.centered) return 1;
    let max = 0;
    for (let i = 0; i < this.count; i++) {
      const x = this.centered[i * 3] * this._scale;
      const y = this.centered[i * 3 + 1] * this._scale;
      const z = this.centered[i * 3 + 2] * this._scale;
      max = Math.max(max, Math.hypot(x, y, z));
    }
    return Math.max(max, 0.2);
  }

  /**
   * 以「重置视角」为基准，计算一个屏幕像素对应的世界空间长度。
   *
   * 旧的 Line2 线宽是固定屏幕像素；改成真实网格后，粗细必须变成世界空间
   * 半径，才能随着相机远近产生真实透视变化。这里让重置视角下的直径仍大致
   * 等于界面滑块设置的像素值。
   */
  _worldPerPixelAtFit() {
    const height = this.container.clientHeight || 1;
    const halfFov = Math.tan((this.camera.fov * Math.PI) / 360);
    const fitDistance = (this._radius() / Math.sin((this.camera.fov * Math.PI) / 360)) * FIT_MARGIN;
    return (2 * fitDistance * halfFov) / height;
  }

  _clear() {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const label of this._labels) {
      this.scene.remove(label.sprite); // 标注挂在场景上，单独回收
      label.sprite.material.map?.dispose();
      label.sprite.material.dispose();
    }
    this._labels = [];
    for (const geometry of this._geometries) geometry.dispose();
    this._geometries = [];
    for (const material of this._materials) material.dispose();
    this._materials = [];
  }

  /**
   * 开关两盏高级光源。关闭时改用 MeshBasicMaterial，保证没有光源时模型仍然
   * 显示基础颜色，而不是像 MeshStandardMaterial 那样因没有入射光而变黑。
   * @param {boolean} enabled
   */
  _setAdvancedLight(enabled) {
    this.scene.remove(this._hemisphereLight, this._keyLight);
    if (enabled) this.scene.add(this._hemisphereLight, this._keyLight);
  }

  _material(options) {
    const material = this.options.advanceLight
      ? new THREE.MeshStandardMaterial({
        roughness: 0.72,
        metalness: 0,
        ...options,
      })
      : new THREE.MeshBasicMaterial(options);
    this._materials.push(material);
    return material;
  }

  _build() {
    this._clear();
    const n = this.count;
    if (n < 2) return;

    const dark = this.options.dark;
    const borderColor = dark ? BORDER_COLOR.dark : BORDER_COLOR.light;

    const curve = this._curve();
    const colors = new Array(n);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = jetColor(1 - i / (n - 1), dark); // 与原实现一致：jet 反向
      colors[i] = new THREE.Color().setRGB(r, g, b);
    }

    // 所有 segment 共用同一个单位圆柱，长度和方向通过每个实例的矩阵设置。
    // 圆柱的局部轴是 Y 轴，半径先设为 1，真正的半径在实例矩阵里缩放。
    const cylinderGeometry = new THREE.CylinderGeometry(
      1,
      1,
      1,
      CAPSULE_RADIAL_SEGMENTS,
      1,
      false,
    );
    const sphereGeometry = new THREE.SphereGeometry(
      1,
      CAPSULE_RADIAL_SEGMENTS,
      CAPSULE_SPHERE_SEGMENTS,
    );
    this._geometries.push(cylinderGeometry, sphereGeometry);

    const worldPerPixel = this._worldPerPixelAtFit();
    const lineRadius = Math.max(1e-4, (this.options.lineWidth * worldPerPixel) / 2);
    const borderExtra = (BORDER_EXTRA_PIXELS * worldPerPixel) / 2;
    const nodeRadius = lineRadius +
      (this.options.markers ? (this.options.markerSize * worldPerPixel) / 2 : 0);

    // InstancedMesh 的 instanceColor 会自动启用实例颜色通道；这里不能再打开
    // vertexColors，否则几何体没有逐顶点 color 属性时，shader 会把默认顶点色
    // 当成黑色与 instanceColor 相乘，最终整条彩色链都会变黑。
    const lineMaterial = this._material({ color: 0xffffff });
    const borderMaterial = this.options.border ? this._material({ color: borderColor }) : null;

    if (borderMaterial) {
      // 描边是更大的同形网格，先画但不写深度；随后由彩色网格写入正确深度并盖住中间。
      borderMaterial.depthWrite = false;
      this._addCylinders(
        curve,
        n,
        cylinderGeometry,
        borderMaterial,
        lineRadius + borderExtra,
        0,
      );
      this._addSpheres(
        curve,
        n,
        sphereGeometry,
        borderMaterial,
        nodeRadius + borderExtra,
        0.25,
      );
    }

    this._addCylinders(
      curve,
      n,
      cylinderGeometry,
      lineMaterial,
      lineRadius,
      1,
      colors,
    );
    this._addSpheres(curve, n, sphereGeometry, lineMaterial, nodeRadius, 1.25, colors);
    if (this.options.showLabels) this._addLabels(curve, n);
  }

  /**
   * 创建一批真正的 3D 圆柱段。
   *
   * 每个 bin 间的相邻坐标是一段圆柱；圆柱两端会被下面的球形节点覆盖，
   * 所以外轮廓看起来是半球封口的胶囊，而不是带平面端盖的裸圆柱。
   * @param {Float64Array} curve
   * @param {number} n
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {number} radius 世界空间半径
   * @param {number} renderOrder
   * @param {THREE.Color[]} [colors]
   */
  _addCylinders(curve, n, geometry, material, radius, renderOrder, colors = null) {
    const mesh = new THREE.InstancedMesh(geometry, material, n - 1);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;

    const midpoint = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (let i = 0; i < n - 1; i++) {
      const a = new THREE.Vector3(curve[i * 3], curve[i * 3 + 1], curve[i * 3 + 2]);
      const b = new THREE.Vector3(
        curve[(i + 1) * 3],
        curve[(i + 1) * 3 + 1],
        curve[(i + 1) * 3 + 2],
      );
      direction.subVectors(b, a);
      const length = Math.max(direction.length(), 1e-5);
      direction.normalize();
      midpoint.addVectors(a, b).multiplyScalar(0.5);
      quaternion.setFromUnitVectors(UNIT_Y, direction);
      scale.set(radius, length, radius);
      matrix.compose(midpoint, quaternion, scale);
      mesh.setMatrixAt(i, matrix);

      if (colors) {
        color.copy(colors[i]).lerp(colors[i + 1], 0.5);
        mesh.setColorAt(i, color);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 创建真正的 3D 球形连接点。
   *
   * markerSize 为 0 时，球与主线等粗，只负责把圆柱端盖成圆头；打开节点标记
   * 后，球会额外变大，并继续使用对应 bin 的颜色。
   * @param {Float64Array} curve
   * @param {number} n
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   * @param {number} radius 世界空间半径
   * @param {number} renderOrder
   * @param {THREE.Color[]} [colors]
   */
  _addSpheres(curve, n, geometry, material, radius, renderOrder, colors = null) {
    const mesh = new THREE.InstancedMesh(geometry, material, n);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;

    const identity = new THREE.Quaternion();
    const scale = new THREE.Vector3(radius, radius, radius);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const color = new THREE.Color();

    for (let i = 0; i < n; i++) {
      position.set(curve[i * 3], curve[i * 3 + 1], curve[i * 3 + 2]);
      matrix.compose(position, identity, scale);
      mesh.setMatrixAt(i, matrix);
      if (colors) {
        mesh.setColorAt(i, color.copy(colors[i]));
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 创建 5' / 3' 标注。两端的文字精灵放在场景里（不随 group 旋转），
   * 具体位置由 _updateLabels 每帧按屏幕投影决定。
   */
  _addLabels(curve, n) {
    const color = this.options.dark ? LABEL_COLOR.dark : LABEL_COLOR.light;
    const first = new THREE.Vector3(curve[0], curve[1], curve[2]);
    const second = new THREE.Vector3(curve[3], curve[4], curve[5]);
    const last = new THREE.Vector3(
      curve[(n - 1) * 3],
      curve[(n - 1) * 3 + 1],
      curve[(n - 1) * 3 + 2],
    );
    const beforeLast = new THREE.Vector3(
      curve[(n - 2) * 3],
      curve[(n - 2) * 3 + 1],
      curve[(n - 2) * 3 + 2],
    );

    // outward = 末端那一段的射线方向（从倒数第二节指向端点）
    const endpoints = [
      { text: "5'", local: first, outward: first.clone().sub(second).normalize() },
      { text: "3'", local: last, outward: last.clone().sub(beforeLast).normalize() },
    ];

    this._labels = endpoints.map(({ text, local, outward }) => {
      const { sprite, aspect } = makeLabelSprite(text, color);
      this.scene.add(sprite);
      return { text, sprite, aspect, local, outward };
    });
    this._updateLabels();
  }

  /**
   * 把 5' / 3' 放在链两端「最后一段的射线方向」上。
   *
   * 沿末端方向往外延伸，文字自然落在染色体外侧，并且紧跟着端点：
   * 不论模型怎么转、相机怎么缩放都会保持这个相对关系，字号固定为线宽的倍数。
   */
  _updateLabels() {
    const canvas = this.renderer.domElement;
    const layout = this._labelLayout(canvas.clientWidth || 1, canvas.clientHeight || 1);

    for (const item of layout) {
      item.sprite.position.copy(item.world);
      item.sprite.scale.set(
        item.heightPx * item.aspect * item.worldPerPixel,
        item.heightPx * item.worldPerPixel,
        1,
      );
    }
  }

  /**
   * 计算两个 5' / 3' 标注的屏幕位置与尺寸。
   *
   * WebGL 端用它摆放 Sprite，SVG 导出用它写 <text>，两边共用同一份布局。
   *
   * @param {number} width 画布像素宽
   * @param {number} height 画布像素高
   * @returns {{text: string, sprite: THREE.Sprite, aspect: number, world: THREE.Vector3,
   *   x: number, y: number, heightPx: number, fontPx: number, worldPerPixel: number}[]}
   */
  _labelLayout(width, height) {
    const labels = this._labels;
    if (labels.length === 0) return [];

    const halfFov = Math.tan((this.camera.fov * Math.PI) / 360);
    const forward = this.camera.getWorldDirection(this._forward);

    const lineWidth = this.options.lineWidth;
    // 贴图像素高度：随线宽变化，但不小于字号下限（线可以细到 1px）
    const labelHeight = Math.max(
      LABEL_PIXELS_PER_LINE * lineWidth,
      LABEL_MIN_FONT_PX / LABEL_FONT_RATIO,
    );
    // 让开的基准距离：节点球半径 + 半个字形高 + 细小空隙
    const markerRadius = (lineWidth + this.options.markerSize) / 2;
    const nodeRadius = this.options.markers ? markerRadius : lineWidth / 2;
    const offsetPixels = nodeRadius + labelHeight * LABEL_GLYPH_HALF + LABEL_GAP_PIXELS;

    const layout = [];
    for (const label of labels) {
      // 端点在世界空间的位置（group 只做旋转与平移）
      const world = this._tmpA
        .copy(label.local)
        .applyQuaternion(this.group.quaternion)
        .add(this.group.position);

      // 该深度处「一个像素等于多少世界单位」，用于把像素尺寸换算回世界尺寸。
      // 注意 forward 是相机看向场景的方向，所以要用「端点 − 相机」去点乘它。
      const depth = Math.max(1e-4, this._tmpB.copy(world).sub(this.camera.position).dot(forward));
      const worldPerPixel = (2 * depth * halfFov) / height;

      // 端点像素坐标（y 向下）
      const ndc = this._tmpB.copy(world).project(this.camera);
      const px = (ndc.x * 0.5 + 0.5) * width;
      const py = (1 - (ndc.y * 0.5 + 0.5)) * height;

      const angle = this._outwardAngle(label, world, px, py, width, height);
      const distance = offsetPixels * worldPerPixel;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // 把屏幕方向换回世界位移：像素 y 向下，故 screenUp 取负
      layout.push({
        text: label.text,
        sprite: label.sprite,
        aspect: label.aspect,
        world: new THREE.Vector3()
          .copy(world)
          .addScaledVector(this._screenRight, cos * distance)
          .addScaledVector(this._screenUp, -sin * distance),
        x: px + cos * offsetPixels,
        y: py + sin * offsetPixels,
        heightPx: labelHeight,
        fontPx: labelHeight * LABEL_FONT_RATIO,
        worldPerPixel,
      });
    }
    return layout;
  }

  /**
   * 末端射线方向在屏幕上的角度。
   * 射线正对/背对相机时投影会退化，此时退回「背离模型中心」，再不行用屏幕正上方。
   *
   * @param {{outward: THREE.Vector3}} label
   * @param {THREE.Vector3} world 端点世界坐标
   * @param {number} px 端点像素 x
   * @param {number} py 端点像素 y（y 向下）
   * @param {number} width 画布像素宽
   * @param {number} height 画布像素高
   * @returns {number} 角度（弧度，像素坐标系）
   */
  _outwardAngle(label, world, px, py, width, height) {
    const probe = this._tmpC
      .copy(label.outward)
      .multiplyScalar(0.05)
      .add(world)
      .project(this.camera);
    const dx = (probe.x * 0.5 + 0.5) * width - px;
    const dy = (1 - (probe.y * 0.5 + 0.5)) * height - py;
    if (dx * dx + dy * dy > 1e-10) return Math.atan2(dy, dx);

    // 退化：改用「背离模型中心」（模型中心即 group 原点）
    const center = this._tmpC.copy(this.group.position).project(this.camera);
    const cx = (center.x * 0.5 + 0.5) * width - px;
    const cy = (1 - (center.y * 0.5 + 0.5)) * height - py;
    if (cx * cx + cy * cy > 1e-10) return Math.atan2(cy, cx);

    return -Math.PI / 2; // 屏幕正上方
  }
}

/* ------------------------------------------------------------ 工具 */

/**
 * 文字精灵（5' / 3' 标注，始终朝向相机且不被遮挡）。
 * 贴图按固定大字号绘制，实际屏幕尺寸由 _updateLabels 每帧按线宽设定。
 * @param {string} text
 * @param {string} color
 * @returns {{sprite: THREE.Sprite, aspect: number}}
 */
function makeLabelSprite(text, color) {
  const font = `600 ${LABEL_FONT_PX}px ${LABEL_FONT_FAMILY}`;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + Math.round(LABEL_FONT_PX * 0.42);
  const height = Math.round(LABEL_FONT_PX * 1.42);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sprite.renderOrder = 4;
  return { sprite, aspect: width / height };
}

/** matplotlib `jet` 的解析式，输入输出均为 sRGB [0,1] */
function jet(t) {
  const x = Math.min(Math.max(t, 0), 1);
  return [
    clamp01(1.5 - Math.abs(4 * x - 3)),
    clamp01(1.5 - Math.abs(4 * x - 2)),
    clamp01(1.5 - Math.abs(4 * x - 1)),
  ];
}

/** sRGB → 线性（与 WebGL 端保持一致的取色链路） */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 线性 → sRGB */
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * jet 颜色并转换到线性空间，保证渲染观感与 matplotlib 一致。
 * @param {number} t
 * @param {boolean} [bright=false] 深色背景时提亮，避免 jet 低端的深蓝/深红融进背景
 */
function jetColor(t, bright = false) {
  return jet(t).map((c) => {
    const linear = srgbToLinear(c);
    return bright ? Math.min(1, linear * 1.3 + 0.06) : linear;
  });
}

/**
 * jet 颜色（SVG 用的 #rrggbb）。走与 WebGL 相同的「线性空间提亮」链路，
 * 所以导出的矢量图颜色与屏幕上的完全一致。
 * @param {number} t
 * @param {boolean} dark
 * @returns {string}
 */
function jetHex(t, dark) {
  const hex = jet(t).map((c) => {
    const linear = srgbToLinear(c);
    const out = dark ? Math.min(1, linear * 1.3 + 0.06) : linear;
    return Math.round(linearToSrgb(out) * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${hex.join("")}`;
}

/** 数值 → 十六进制颜色字串，如 0x0b0e13 → "#0b0e13" */
function hexString(value) {
  return `#${value.toString(16).padStart(6, "0")}`;
}

/** SVG 坐标保留两位小数，避免文件里出现一长串浮点尾数 */
function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 选择浏览器支持的视频封装格式 */
function pickVideoMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export { pickVideoMimeType };
