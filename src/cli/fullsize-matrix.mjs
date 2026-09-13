#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * CLI · 由稀疏 Hi-C 归一化接触矩阵生成完整对称矩阵（CSV）。
 *
 * 核心计算全部来自 ../core.mjs，与浏览器前端共用同一份实现。
 *
 *   deno task matrix -f test/data/sparseMat_Normalized.metrics -o out/mat.csv
 *
 * @module cli/fullsize-matrix
 */

import { buildFullMatrix, matrixToCsv, parseSparseMatrix } from "../core.mjs";

const USAGE = `由稀疏 Hi-C 归一化接触矩阵生成完整矩阵（CSV）。

用法：
  deno run --allow-read --allow-write src/cli/fullsize-matrix.mjs -f <输入> -o <输出>

参数：
  -f, --file    <path>  稀疏接触矩阵文件（i, j, contact，制表符/逗号/空白分隔）
  -o, --output  <path>  输出 CSV 路径
  -h, --help            显示本帮助

示例：
  deno task matrix -f test/data/sparseMat_Normalized.metrics -o out/mat.csv
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { input: null, output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "-f":
      case "--file":
      case "--input":
        opts.input = argv[++i];
        break;
      case "-o":
      case "--output":
        opts.output = argv[++i];
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${argv[i]}`);
    }
  }
  return opts;
}

if (import.meta.main) {
  const { input, output, help } = parseArgs(Deno.args);

  if (help || !input || !output) {
    console.log(USAGE);
    Deno.exit(help ? 0 : 1);
  }

  try {
    const t0 = performance.now();
    const text = await Deno.readTextFile(input);
    const sparse = parseSparseMatrix(text);
    const matrix = buildFullMatrix(sparse);
    await Deno.writeTextFile(output, matrixToCsv(matrix.data, matrix.size));
    const ms = (performance.now() - t0).toFixed(1);

    console.error(
      `[fullsize-matrix] ${sparse.count} 个接触对 → ${matrix.size}×${matrix.size} 矩阵` +
        `（bin 步长 ${matrix.size > 1 ? matrix.labels[1] - matrix.labels[0] : 0}） · ${ms} ms`,
    );
    console.error(`[fullsize-matrix] 已写入 ${output}`);
  } catch (err) {
    console.error(`[fullsize-matrix] 失败：${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}
