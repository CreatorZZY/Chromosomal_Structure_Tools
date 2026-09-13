#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * CLI · 由完整接触矩阵计算三维坐标（ShRec3D，CSV 输出）。
 *
 * 核心计算全部来自 ../core.mjs，与浏览器前端共用同一份实现。
 *
 *   deno task coords -f out/mat.csv -o out/coord.csv
 *
 * @module cli/coordinates
 */

import {
  contactsToDistances,
  coordinatesToCsv,
  distancesToCoordinates,
  parseMatrixCsv,
} from "../core.mjs";

const USAGE = `由完整接触矩阵计算染色体三维坐标（ShRec3D）。

用法：
  deno run --allow-read --allow-write src/cli/coordinates.mjs -f <输入> -o <输出>

参数：
  -f, --file    <path>  完整（对称）接触矩阵 CSV（由 fullsize-matrix.mjs 生成）
  -o, --output  <path>  输出坐标 CSV（n 行 3 列）
  -h, --help            显示本帮助

示例：
  deno task coords -f out/mat.csv -o out/coord.csv
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
    const { data, size } = parseMatrixCsv(await Deno.readTextFile(input));

    const tDist = performance.now();
    const distances = contactsToDistances(data, size, (ratio) => {
      if (Math.round(ratio * 100) % 25 === 0) {
        console.error(`[coordinates] 最短路 ${(ratio * 100).toFixed(0)}%`);
      }
    });
    const tMds = performance.now();

    const coordinates = distancesToCoordinates(distances, size);
    await Deno.writeTextFile(output, coordinatesToCsv(coordinates, size));
    const tEnd = performance.now();

    console.error(
      `[coordinates] ${size} 个 bin · 最短路 ${(tMds - tDist).toFixed(1)} ms` +
        ` · MDS ${(tEnd - tMds).toFixed(1)} ms · 合计 ${(tEnd - t0).toFixed(1)} ms`,
    );
    console.error(`[coordinates] 已写入 ${output}`);
  } catch (err) {
    console.error(`[coordinates] 失败：${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}
