/**
 * core.mjs 单元测试。
 *
 *   deno task test
 *
 * 覆盖：矩阵构建语义、最短路（与独立 Dijkstra 交叉验证）、
 * 高斯平滑（与 scipy.ndimage.gaussian_filter1d 的参考值对齐）、端到端流程。
 */
import {
  buildFullMatrix,
  contactsToDistances,
  coordinatesToCsv,
  distancesToCoordinates,
  gaussianSmooth1d,
  matrixToCsv,
  parseMatrixCsv,
  parseSparseMatrix,
  runShrec3d,
} from "../src/core.mjs";

const DATA_URL = new URL("./data/sparseMat_Normalized.metrics", import.meta.url);

/** 断言两个浮点数接近 */
function close(actual, expected, tolerance = 1e-12, message = "") {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}：期望 ${expected}，实际 ${actual}（容差 ${tolerance}）`);
  }
}

/** 断言两个数组逐元素接近 */
function closeAll(actual, expected, tolerance = 1e-12, message = "") {
  if (actual.length !== expected.length) {
    throw new Error(`${message}：长度 ${actual.length} ≠ ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    close(actual[i], expected[i], tolerance, `${message}（第 ${i} 项）`);
  }
}

Deno.test("稀疏三元组解析：兼容制表符 / 空格 / 逗号与注释", () => {
  const sparse = parseSparseMatrix("# 注释\n0\t1000\t5\n2000 3000 7\n4000,5000,9\n\n");
  if (sparse.count !== 3) throw new Error(`期望 3 个三元组，实际 ${sparse.count}`);
  close(sparse.rows[1], 2000, 0, "rows[1]");
  close(sparse.cols[2], 5000, 0, "cols[2]");
  close(sparse.vals[0], 5, 0, "vals[0]");
});

Deno.test("完整矩阵：log10(x+1) 变换 + 对称化 + 同位置取均值", () => {
  const sparse = parseSparseMatrix("0\t0\t1\n0\t1000\t3\n1000\t1000\t9\n");
  const { labels, size, data } = buildFullMatrix(sparse);

  if (size !== 2) throw new Error(`期望 2 个 bin，实际 ${size}`);
  close(labels[0], 0, 0, "labels[0]");
  close(labels[1], 1000, 0, "labels[1]");

  close(data[0], Math.log10(2), 1e-15, "M[0][0]");
  close(data[1], Math.log10(4), 1e-15, "M[0][1]");
  close(data[2], Math.log10(4), 1e-15, "M[1][0]（对称）");
  close(data[3], 1, 1e-15, "M[1][1]");
});

Deno.test("距离矩阵：Floyd–Warshall 与独立 Dijkstra 结果一致", () => {
  const n = 24;
  // 确定性伪随机稀疏接触矩阵
  let seed = 20240913;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const contacts = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const value = rand() < 0.25 ? 0.05 + rand() * 8 : 0;
      contacts[i * n + j] = value;
      contacts[j * n + i] = value;
    }
  }

  const fast = contactsToDistances(contacts, n);
  const reference = dijkstraAllPairs(contacts, n);
  closeAll(fast, reference, 1e-9, "最短路距离矩阵");
});

Deno.test('高斯平滑：与 scipy.ndimage.gaussian_filter1d(mode="reflect") 一致', () => {
  // 参考值由 scipy 1.17 生成
  closeAll(
    gaussianSmooth1d([1, 2, 3, 4, 5], 0.5),
    [
      1.1072423672218035,
      2.0002638650827373,
      2.9999999999999996,
      3.9997361349172627,
      4.8927576327781965,
    ],
    1e-12,
    "sigma=0.5",
  );
  closeAll(
    gaussianSmooth1d([1, 2, 3, 4, 5], 1.0),
    [1.4270409503911736, 2.0678220347792573, 3, 3.932177965220743, 4.572959049608827],
    1e-12,
    "sigma=1.0",
  );
  closeAll(
    gaussianSmooth1d([1, 2, 3, 4, 5], 2.0),
    [2.1397782880572813, 2.4685481649413497, 3, 3.531451835058651, 3.8602217119427187],
    1e-12,
    "sigma=2.0",
  );
  // 核半径 < 1 时不平滑（与 scipy 相同）
  closeAll(gaussianSmooth1d([1, 2, 3, 4, 5], 0.1), [1, 2, 3, 4, 5], 0, "sigma=0.1");
  // 多次反射折叠（sigma 远大于序列长度）
  closeAll(
    gaussianSmooth1d([3, 1, 4, 1, 5, 9, 2, 6], 3.0),
    [
      2.963606868924851,
      3.1068349204005896,
      3.37016600604495,
      3.7102449925071848,
      4.070154656323901,
      4.392347582912291,
      4.630661417622367,
      4.7559835552638665,
    ],
    1e-12,
    "sigma=3.0（多次反射）",
  );
});

Deno.test("端到端：示例数据 94 个 bin，输出稳定且有限", async () => {
  const text = await Deno.readTextFile(DATA_URL);

  const first = runShrec3d(text);
  const second = runShrec3d(text);

  if (first.size !== 94) throw new Error(`期望 94 个 bin，实际 ${first.size}`);
  if (first.pairs !== 4019) throw new Error(`期望 4019 个接触对，实际 ${first.pairs}`);
  close(first.labels[1] - first.labels[0], 1000, 0, "bin 步长");

  // 同一输入必须给出完全相同的输出（确定性：固定初始向量 + 符号规约）
  const a = coordinatesToCsv(first.coordinates, first.size);
  const b = coordinatesToCsv(second.coordinates, second.size);
  if (a !== b) throw new Error("两次运行的坐标输出不一致");

  let min = Infinity;
  let max = -Infinity;
  for (const value of first.coordinates) {
    if (!Number.isFinite(value)) throw new Error("坐标中出现非有限值");
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (max - min <= 0) throw new Error("坐标退化为单点");
});

Deno.test("CSV 序列化与解析可往返", async () => {
  const text = await Deno.readTextFile(DATA_URL);
  const { matrix, coordinates, size } = runShrec3d(text);

  const matrixBack = parseMatrixCsv(matrixToCsv(matrix.data, size));
  if (matrixBack.size !== size || matrixBack.cols !== size) throw new Error("矩阵维度丢失");
  closeAll(matrixBack.data, matrix.data, 0, "矩阵往返");

  const coordsBack = parseMatrixCsv(coordinatesToCsv(coordinates, size));
  if (coordsBack.size !== size || coordsBack.cols !== 3) throw new Error("坐标维度丢失");
  closeAll(coordsBack.data, coordinates, 0, "坐标往返");
});

Deno.test("MDS：对欧氏构型可精确还原两两距离", () => {
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 2], [1, 2, 2]];
  const n = points.length;
  const distances = distanceMatrix(points);

  const coordinates = distancesToCoordinates(distances, n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      close(
        pointDistance(coordinates, i, j),
        distances[i * n + j],
        1e-10,
        `还原距离 d(${i},${j})`,
      );
    }
  }
});

Deno.test("MDS：重建结果对距离整体缩放保持不变", () => {
  // 螺旋构型的距离尺度远大于 1，正是上游「二次平方」写法失效的场景
  const points = Array.from({ length: 32 }, (_, i) => [
    Math.cos(i * 0.6) * 1.5,
    i * 0.35,
    Math.sin(i * 0.6) * 1.5,
  ]);
  const n = points.length;
  const base = distanceMatrix(points);

  const reference = shapeSignature(distancesToCoordinates(base, n), n);
  for (const factor of [2, 7, 100]) {
    const scaled = Float64Array.from(base, (v) => v * factor);
    const signature = shapeSignature(distancesToCoordinates(scaled, n), n);
    closeAll(signature, reference, 1e-12, `缩放 ×${factor} 后形状发生改变`);
  }
});

/**
 * 由点坐标构造距离矩阵。
 * @param {number[][]} points
 * @returns {Float64Array}
 */
function distanceMatrix(points) {
  const n = points.length;
  const distances = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      distances[i * n + j] = Math.hypot(
        points[i][0] - points[j][0],
        points[i][1] - points[j][1],
        points[i][2] - points[j][2],
      );
    }
  }
  return distances;
}

/**
 * 两点间欧氏距离。
 * @param {Float64Array} coordinates @param {number} i @param {number} j
 * @returns {number}
 */
function pointDistance(coordinates, i, j) {
  return Math.hypot(
    coordinates[i * 3] - coordinates[j * 3],
    coordinates[i * 3 + 1] - coordinates[j * 3 + 1],
    coordinates[i * 3 + 2] - coordinates[j * 3 + 2],
  );
}

/**
 * 形状签名：归一化点对距离，对刚体变换与整体缩放均不敏感。
 * @param {Float64Array} coordinates @param {number} n
 * @returns {number[]}
 */
function shapeSignature(coordinates, n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) values.push(pointDistance(coordinates, i, j));
  }
  const max = Math.max(...values);
  return values.map((v) => v / max);
}

/**
 * 独立的 Dijkstra 参考实现，用于交叉验证 Floyd–Warshall。
 * @param {Float64Array} contacts 行优先 n×n 接触矩阵
 * @param {number} n
 * @returns {Float64Array} 行优先距离矩阵
 */
function dijkstraAllPairs(contacts, n) {
  const result = new Float64Array(n * n);
  for (let source = 0; source < n; source++) {
    const dist = new Float64Array(n).fill(Infinity);
    const settled = new Uint8Array(n);
    dist[source] = 0;

    for (let step = 0; step < n; step++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!settled[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u === -1) break;
      settled[u] = 1;
      for (let v = 0; v < n; v++) {
        if (settled[v]) continue;
        const freq = contacts[u * n + v];
        if (freq === 0) continue;
        const candidate = dist[u] + 1 / freq;
        if (candidate < dist[v]) dist[v] = candidate;
      }
    }

    for (let i = 0; i < n; i++) {
      result[source * n + i] = dist[i] === Infinity ? 1e6 : dist[i];
    }
  }
  return result;
}
