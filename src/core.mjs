/**
 * Chromosomal Structure Tools · 核心算法（ShRec3D）
 * ============================================================================
 * 纯 ESM、零依赖、无 I/O 副作用 —— 同一份实现同时服务于：
 *   · 浏览器前端   src/worker.mjs  /  src/main.js   （import 本文件）
 *   · Deno CLI     src/cli/*.mjs                    （import 本文件）
 *
 * 流程：
 *   稀疏接触三元组 ──buildFullMatrix──────────▶ 完整对称矩阵 n×n
 *                  ──contactsToDistances─────▶ 距离矩阵（Floyd–Warshall）
 *                  ──distancesToCoordinates──▶ 三维坐标 n×3（经典 MDS）
 *
 * 数值语义与原 Python/PyPI 版（kpj/ShRec3D 的 Python3 移植）保持一致：
 *   · 接触值先做 log10(x + 1) 变换，再与其转置合并取均值（等价于
 *     pandas pivot_table(aggfunc='mean') 对对称化后数据的聚合）
 *   · 图中边权为 1/接触值，Floyd–Warshall 求最短路，不可达记为 1e6
 *   · 质心化后构造 Gram 矩阵，取前 3 大特征对还原坐标
 *
 * @module core
 */

/* ==========================================================================
 * 1. 稀疏接触矩阵 → 完整对称矩阵
 * ========================================================================== */

/**
 * 稀疏接触三元组集合。
 * @typedef {object} SparseContacts
 * @property {Float64Array} rows  接触对左端坐标（bin 位置）
 * @property {Float64Array} cols  接触对右端坐标（bin 位置）
 * @property {Float64Array} vals  归一化接触值
 * @property {number} count       三元组个数
 */

/**
 * 解析稀疏接触矩阵文本。
 *
 * 兼容制表符 / 逗号 / 空白符分隔，忽略空行与 `#` 注释行。
 * 只取前三列（i, j, contact），与原始实现一致。
 *
 * @param {string} text 原始文件内容
 * @returns {SparseContacts}
 * @throws {Error} 当某一行的数值字段无法解析时
 */
export function parseSparseMatrix(text) {
  let cap = 1024;
  let rows = new Float64Array(cap);
  let cols = new Float64Array(cap);
  let vals = new Float64Array(cap);
  let count = 0;

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (line === "" || line.startsWith("#")) continue;

    const fields = line.split(/[\t,;\s]+/).filter((f) => f !== "");
    if (fields.length < 3) {
      throw new Error(`第 ${ln + 1} 行少于 3 列，无法解析：${line.slice(0, 60)}`);
    }
    const i = Number(fields[0]);
    const j = Number(fields[1]);
    const v = Number(fields[2]);
    if (!Number.isFinite(i) || !Number.isFinite(j) || !Number.isFinite(v)) {
      throw new Error(`第 ${ln + 1} 行含非法数值：${line.slice(0, 60)}`);
    }

    if (count === cap) {
      cap *= 2;
      const r2 = new Float64Array(cap);
      const c2 = new Float64Array(cap);
      const v2 = new Float64Array(cap);
      r2.set(rows);
      c2.set(cols);
      v2.set(vals);
      rows = r2;
      cols = c2;
      vals = v2;
    }
    rows[count] = i;
    cols[count] = j;
    vals[count] = v;
    count++;
  }

  return { rows, cols, vals, count };
}

/**
 * 完整（稠密、对称）接触矩阵。
 * @typedef {object} FullMatrix
 * @property {Float64Array} labels 每行/列对应的 bin 坐标（升序）
 * @property {number} size         矩阵边长 n
 * @property {Float64Array} data   行优先存储的 n×n 矩阵
 */

/**
 * 由稀疏三元组构造完整对称矩阵。
 *
 * 步骤：对接触值做 log10(x + 1) 变换 → 与原数据的转置合并（对称化）
 * → 同位置取均值 → 未出现的组合补 0。
 *
 * @param {SparseContacts} sparse
 * @returns {FullMatrix}
 */
export function buildFullMatrix(sparse) {
  const { rows, cols, vals, count } = sparse;

  // 收集全部 bin 坐标，升序作为矩阵的行列标签
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    seen.add(rows[k]);
    seen.add(cols[k]);
  }
  const labels = Float64Array.from(seen).sort();
  const n = labels.length;

  const index = new Map();
  for (let i = 0; i < n; i++) index.set(labels[i], i);

  const sum = new Float64Array(n * n);
  const hits = new Float64Array(n * n);
  for (let k = 0; k < count; k++) {
    const z = Math.log10(vals[k] + 1);
    const a = index.get(rows[k]);
    const b = index.get(cols[k]);
    sum[a * n + b] += z;
    hits[a * n + b] += 1;
    if (a !== b) {
      // 对称化：转置项与原项取均值
      sum[b * n + a] += z;
      hits[b * n + a] += 1;
    } else {
      // 对角项在原始实现中出现两次（原数据 + 转置副本），需计两次
      sum[a * n + b] += z;
      hits[a * n + b] += 1;
    }
  }

  const data = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (hits[k] > 0) data[k] = sum[k] / hits[k];
  }

  return { labels, size: n, data };
}

/* ==========================================================================
 * 2. 接触矩阵 → 距离矩阵
 * ========================================================================== */

/**
 * 由接触矩阵推断距离矩阵。
 *
 * 建图为完全赋权图：接触值非 0 处连边，边权 = 1 / 接触值；
 * 用 Floyd–Warshall 求所有点对最短路；不可达点对记为 1e6。
 *
 * @param {Float64Array} data 行优先 n×n 接触矩阵
 * @param {number} n
 * @param {(ratio: number) => void} [onProgress] 进度回调（0→1）
 * @returns {Float64Array} 行优先 n×n 距离矩阵
 */
export function contactsToDistances(data, n, onProgress) {
  const INF = Infinity;
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        dist[i * n + j] = 0;
      } else {
        const freq = data[i * n + j];
        dist[i * n + j] = freq !== 0 ? 1 / freq : INF;
      }
    }
  }

  const tick = onProgress ? Math.max(1, Math.floor(n / 50)) : 0;
  for (let k = 0; k < n; k++) {
    const kOff = k * n;
    for (let i = 0; i < n; i++) {
      const iOff = i * n;
      const dik = dist[iOff + k];
      if (dik === INF) continue;
      for (let j = 0; j < n; j++) {
        const alt = dik + dist[kOff + j];
        if (alt < dist[iOff + j]) dist[iOff + j] = alt;
      }
    }
    if (onProgress && k % tick === 0) onProgress(k / n);
  }
  if (onProgress) onProgress(1);

  const distances = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) {
    distances[k] = dist[k] === INF ? 1e6 : dist[k];
  }
  return distances;
}

/* ==========================================================================
 * 3. 距离矩阵 → 三维坐标（经典 MDS）
 * ========================================================================== */

/**
 * 由距离矩阵还原三维坐标（经典多维标度 / Torgerson MDS）。
 *
 * 计算各点到质心的距离平方 → 构造 Gram 矩阵 → 取前 3 大特征对，
 * 坐标 = 特征向量 × √特征值（负特征值截断为 0，避免出现 NaN）。
 *
 * 与上游实现的差异：Gram 矩阵使用极化恒等式（见下方注释），修正了上游
 * 「对 d₀ 二次平方」导致的非尺度不变性。
 *
 * @param {Float64Array} distances 行优先 n×n 距离矩阵
 * @param {number} n
 * @returns {Float64Array} 行优先 n×3 坐标
 */
export function distancesToCoordinates(distances, n) {
  // 上三角各行平方和（原实现中的 cache），其总和对应 ½·ΣΣd²，
  // 正是「到质心距离」公式里的常数项系数。
  const upperRowSq = new Float64Array(n);
  let upperTotal = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * n;
    for (let j = i + 1; j < n; j++) {
      const d = distances[off + j];
      s += d * d;
    }
    upperRowSq[i] = s;
    upperTotal += s;
  }

  // 各点到质心距离的平方：|xᵢ-x̄|² = (Σₖdᵢₖ²)/N − (ΣΣd²)/(2N²)
  const meanSq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = upperRowSq[i];
    for (let j = 0; j < i; j++) {
      const d = distances[j * n + i];
      s += d * d;
    }
    meanSq[i] = s / n - upperTotal / (n * n);
  }

  const gram = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = distances[i * n + j];
      // 极化恒等式：⟨xᵢ−x̄, xⱼ−x̄⟩ = ½(aᵢ² + aⱼ² − dᵢⱼ²)
      //
      // 注意：上游 Python/C++ 实现写作 `d_0[row]**2 + d_0[col]**2 − d²`，
      // 而 d_0 本身已经是到质心距离的平方，等于把平方量又平方了一次。
      // 该写法不具备尺度不变性：距离整体放大 2 倍时重建形状会变化约 17%
      // （本实现已修正）。对 test/data 中的示例数据，两种写法的结构相似度
      // 为 0.9993、应力基本一致，因此与旧版输出仍可直接比较。
      gram[i * n + j] = 0.5 * (meanSq[i] + meanSq[j] - d * d);
    }
  }

  const { values, vectors } = topEigenpairs(gram, n, 3);

  // 轴序与原实现一致：numpy.linalg.eigh 返回升序特征值，原实现取末尾 3 个后
  // 依次作为 x、y、z 轴，故第 1 轴对应三者中最小的特征值。
  const coordinates = new Float64Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const source = 2 - c;
    const scale = Math.sqrt(Math.max(values[source], 0));
    const vec = vectors[source];
    for (let i = 0; i < n; i++) coordinates[i * 3 + c] = vec[i] * scale;
  }
  return coordinates;
}

/**
 * 对称矩阵前 k 大代数特征对。
 *
 * Lanczos 迭代（完全重正交保证数值稳定）+ 三对角矩阵 Jacobi 分解。
 * 相比整矩阵特征分解，复杂度从 O(n³) 降到 O(m·n²)（m 为 Krylov 维数），
 * 使浏览器端也能处理上千 bin 的接触矩阵。
 *
 * @param {Float64Array} a 行优先对称矩阵
 * @param {number} n
 * @param {number} k 需要的特征对个数
 * @returns {{values: number[], vectors: Float64Array[]}} 按特征值降序
 */
function topEigenpairs(a, n, k) {
  const want = Math.min(k, n);
  // 二维 MDS 的 Gram 矩阵谱密集，Krylov 维数偏小会让顶端特征值收敛不足，
  // 这里固定给到 60 步（n 本身更小时即退化为完整的 Krylov 子空间，结果精确）。
  const m = Math.min(n, Math.max(60, 6 * want));

  const basis = [normalize(deterministicUnitVector(n))];
  const alpha = new Float64Array(m);
  const beta = new Float64Array(m);
  let len = m;

  for (let j = 0; j < m; j++) {
    const w = matVec(a, n, basis[j]);
    if (j > 0) addScaled(w, basis[j - 1], -beta[j - 1]);

    const aj = dot(w, basis[j]);
    alpha[j] = aj;
    addScaled(w, basis[j], -aj);

    // 两遍完全重正交，抑制浮点误差导致的伪特征值
    for (let pass = 0; pass < 2; pass++) {
      for (let t = 0; t <= j; t++) addScaled(w, basis[t], -dot(w, basis[t]));
    }

    const bj = norm(w);
    beta[j] = bj;
    if (bj <= 1e-14 * Math.max(1, Math.abs(aj)) || j === m - 1) {
      len = j + 1;
      break;
    }
    basis.push(scaleVec(w, 1 / bj));
  }

  // 三对角化投影矩阵 T = VᵀAV
  const tri = new Float64Array(len * len);
  for (let i = 0; i < len; i++) {
    tri[i * len + i] = alpha[i];
    if (i + 1 < len) {
      tri[i * len + i + 1] = beta[i];
      tri[(i + 1) * len + i] = beta[i];
    }
  }

  const { values: ritz, vectors: ritzVec } = jacobiEigen(tri, len);
  const order = Array.from({ length: len }, (_, i) => i).sort((p, q) => ritz[q] - ritz[p]);

  const values = [];
  const vectors = [];
  for (let c = 0; c < want; c++) {
    const col = order[c];
    const x = new Float64Array(n);
    for (let i = 0; i < len; i++) {
      const y = ritzVec[i * len + col];
      if (y === 0) continue;
      const b = basis[i];
      for (let r = 0; r < n; r++) x[r] += y * b[r];
    }
    normalize(x);
    fixSign(x);
    values.push(ritz[col]);
    vectors.push(x);
  }

  // 退化情形（n < 3）用零补齐，保证返回值恒为 3 组
  while (values.length < 3) {
    values.push(0);
    vectors.push(new Float64Array(n));
  }

  return { values, vectors };
}

/**
 * 对称矩阵的循环 Jacobi 特征分解（用于维数很小的三对角矩阵）。
 *
 * @param {Float64Array} a 行优先对称矩阵（不会被修改）
 * @param {number} m 阶数
 * @returns {{values: Float64Array, vectors: Float64Array}} 列向量为特征向量
 */
function jacobiEigen(a, m) {
  const A = Float64Array.from(a);
  const V = new Float64Array(m * m);
  for (let i = 0; i < m; i++) V[i * m + i] = 1;

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < m; p++) {
      for (let q = p + 1; q < m; q++) off += A[p * m + q] * A[p * m + q];
    }
    if (off <= 1e-30) break;

    for (let p = 0; p < m; p++) {
      for (let q = p + 1; q < m; q++) {
        const apq = A[p * m + q];
        if (apq === 0) continue;
        const theta = (A[q * m + q] - A[p * m + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let i = 0; i < m; i++) {
          const aip = A[i * m + p];
          const aiq = A[i * m + q];
          A[i * m + p] = c * aip - s * aiq;
          A[i * m + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < m; i++) {
          const api = A[p * m + i];
          const aqi = A[q * m + i];
          A[p * m + i] = c * api - s * aqi;
          A[q * m + i] = s * api + c * aqi;
        }
        for (let i = 0; i < m; i++) {
          const vip = V[i * m + p];
          const viq = V[i * m + q];
          V[i * m + p] = c * vip - s * viq;
          V[i * m + q] = s * vip + c * viq;
        }
      }
    }
  }

  const values = new Float64Array(m);
  for (let i = 0; i < m; i++) values[i] = A[i * m + i];
  return { values, vectors: V };
}

/* ==========================================================================
 * 4. 全流程封装
 * ========================================================================== */

/**
 * @typedef {object} Shrec3dResult
 * @property {Float64Array} labels       bin 坐标
 * @property {number} size               bin 数
 * @property {number} pairs              输入三元组个数
 * @property {FullMatrix} matrix         完整接触矩阵
 * @property {Float64Array} distances    距离矩阵
 * @property {Float64Array} coordinates  行优先 n×3 坐标
 */

/**
 * 稀疏接触文本 → 三维坐标（完整流程）。
 *
 * @param {string} text 稀疏接触矩阵文本
 * @param {{onStage?: (stage: string, ratio: number) => void}} [options]
 * @returns {Shrec3dResult}
 */
export function runShrec3d(text, options = {}) {
  const { onStage = () => {} } = options;

  onStage("parse", 0);
  const sparse = parseSparseMatrix(text);

  onStage("matrix", 0);
  const matrix = buildFullMatrix(sparse);

  onStage("distance", 0);
  const distances = contactsToDistances(
    matrix.data,
    matrix.size,
    (ratio) => onStage("distance", ratio),
  );

  onStage("mds", 0);
  const coordinates = distancesToCoordinates(distances, matrix.size);
  onStage("mds", 1);

  return {
    labels: matrix.labels,
    size: matrix.size,
    pairs: sparse.count,
    matrix,
    distances,
    coordinates,
  };
}

/* ==========================================================================
 * 5. 平滑与序列化
 * ========================================================================== */

/**
 * 一维高斯平滑，等价于 `scipy.ndimage.gaussian_filter1d(x, sigma, mode='reflect')`。
 *
 * @param {ArrayLike<number>} src 输入序列
 * @param {number} sigma 标准差
 * @param {number} [truncate=4.0] 核截断倍数（scipy 同款默认值）
 * @returns {Float64Array} 平滑后的新序列
 */
export function gaussianSmooth1d(src, sigma, truncate = 4.0) {
  const n = src.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i];
  if (n === 0 || !(sigma > 0)) return out;

  const radius = Math.floor(truncate * sigma + 0.5);
  if (radius < 1) return out;

  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  const denom = 2 * sigma * sigma;
  for (let t = -radius; t <= radius; t++) {
    const w = Math.exp(-(t * t) / denom);
    kernel[t + radius] = w;
    sum += w;
  }
  for (let t = 0; t < kernel.length; t++) kernel[t] /= sum;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = 0; t < kernel.length; t++) {
      acc += kernel[t] * src[reflectIndex(i + t - radius, n)];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * scipy `mode='reflect'`（半样本对称）的索引映射：边界样本被复制。
 * @param {number} i 可能越界的索引
 * @param {number} n 序列长度
 * @returns {number} 折叠回 [0, n) 的索引
 */
function reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  const m = ((i % period) + period) % period;
  return m < n ? m : period - m - 1;
}

/**
 * 矩阵 → CSV 文本（每行一条记录，逗号分隔，17 位有效数字）。
 * @param {Float64Array} data 行优先矩阵
 * @param {number} n 行数
 * @param {number} [cols=n] 列数
 * @returns {string}
 */
export function matrixToCsv(data, n, cols = n) {
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(cols);
    for (let j = 0; j < cols; j++) row[j] = formatNumber(data[i * cols + j]);
    lines[i] = row.join(",");
  }
  return lines.join("\n") + "\n";
}

/**
 * 坐标 → CSV 文本（n 行 3 列）。
 * @param {Float64Array} coordinates 行优先 n×3 坐标
 * @param {number} n
 * @returns {string}
 */
export function coordinatesToCsv(coordinates, n) {
  return matrixToCsv(coordinates, n, 3);
}

/**
 * 解析 CSV 数值矩阵文本（用于 CLI 读取上一步产物）。
 * @param {string} text
 * @returns {{data: Float64Array, size: number, cols: number}}
 */
export function parseMatrixCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/[\t,;\s]+/).filter((f) => f !== "");
    if (fields.length === 0) continue;
    const row = fields.map((f) => {
      const v = Number(f);
      if (!Number.isFinite(v)) throw new Error(`矩阵文件中含非法数值：${trimmed.slice(0, 60)}`);
      return v;
    });
    rows.push(row);
  }
  if (rows.length === 0) throw new Error("矩阵文件为空或格式无法识别。");

  const size = rows.length;
  const cols = rows[0].length;
  for (const row of rows) {
    if (row.length !== cols) throw new Error("矩阵行长度不一致，无法解析为矩形矩阵。");
  }

  const data = new Float64Array(size * cols);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < cols; j++) data[i * cols + j] = rows[i][j];
  }
  return { data, size, cols };
}

/** double 需要 17 位有效数字才能精确往返。 */
const EXPONENT_DIGITS = 16;

/**
 * 数值格式化（等价于 numpy 默认的 `%.18e`，这里用 17 位有效数字保证往返精确）。
 * @param {number} x
 * @returns {string}
 */
export function formatNumber(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  return x.toExponential(EXPONENT_DIGITS);
}

/* ==========================================================================
 * 6. 内部数值工具
 * ========================================================================== */

/** @param {Float64Array} a @param {number} n @param {Float64Array} x @returns {Float64Array} */
function matVec(a, n, x) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * n;
    for (let j = 0; j < n; j++) s += a[off + j] * x[j];
    y[i] = s;
  }
  return y;
}

/** @returns {number} */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** @returns {number} */
function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** 就地累加：a += k·b */
function addScaled(a, b, k) {
  for (let i = 0; i < a.length; i++) a[i] += k * b[i];
}

/** @returns {Float64Array} 新向量 */
function scaleVec(a, k) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
  return out;
}

/** 就地归一化并返回同一数组 */
function normalize(a) {
  const len = norm(a);
  if (len > 0) { for (let i = 0; i < a.length; i++) a[i] /= len; }
  return a;
}

/** 固定符号，保证同一输入总是得到同一输出（最大分量取正） */
function fixSign(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) {
    if (Math.abs(a[i]) > Math.abs(a[best])) best = i;
  }
  if (a[best] < 0) { for (let i = 0; i < a.length; i++) a[i] = -a[i]; }
}

/**
 * 确定性初始向量（线性同余发生器），避免随机化导致结果不可复现。
 * @param {number} n
 * @returns {Float64Array}
 */
function deterministicUnitVector(n) {
  const v = new Float64Array(n);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    v[i] = s / 4294967296 - 0.5;
  }
  return v;
}
