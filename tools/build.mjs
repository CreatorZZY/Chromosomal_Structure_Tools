/**
 * 构建：把前端源码打包成可直接静态托管的 dist/。
 *
 * 全程只用 Deno 自带能力，不需要 package.json，也不会产生 node_modules：
 *   deno bundle --platform browser --node-modules-dir=none
 * 会把 npm:three 之类的依赖从 Deno 全局缓存里读出来、内联进产物。
 *
 *   deno task build              生产构建（压缩 + sourcemap）
 *   deno task dev                开发服务器（监听源码变化并自动重建）
 *   deno run -A tools/build.mjs --dev     仅做一次开发构建（不压缩）
 *
 * @module tools/build
 */
import { basename, dirname, join } from "node:path";

const ROOT = dirname(import.meta.dirname);
const DIST = join(ROOT, "dist");

/** 打包入口 → 产物文件名（两者同目录，main.js 里按相对路径创建 Worker） */
const ENTRIES = [
  { entry: "src/main.js", output: "app.js" },
  { entry: "src/worker.mjs", output: "worker.js" },
];

/** 原样拷贝进 dist 的静态文件 */
const ASSETS = ["index.html", "src/style.css"];

/**
 * 调用 `deno bundle` 打包单个入口。
 * @param {{entry: string, output: string}} target
 * @param {{minify: boolean}} options
 */
async function bundle(target, { minify }) {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: [
      "bundle",
      "--platform",
      "browser",
      "--node-modules-dir=none",
      "--sourcemap",
      "linked",
      ...(minify ? ["--minify"] : []),
      "-o",
      join(DIST, target.output),
      join(ROOT, target.entry),
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(`打包 ${target.entry} 失败：\n${new TextDecoder().decode(stderr)}`);
  }
}

/**
 * 构建整个前端到 dist/。
 *
 * @param {{minify?: boolean, clean?: boolean, quiet?: boolean}} [options]
 * @returns {Promise<string[]>} 产物路径
 */
export async function build({ minify = true, clean = true, quiet = false } = {}) {
  if (clean) await Deno.remove(DIST, { recursive: true }).catch(() => {});
  await Deno.mkdir(DIST, { recursive: true });

  for (const target of ENTRIES) await bundle(target, { minify });
  for (const asset of ASSETS) await Deno.copyFile(join(ROOT, asset), join(DIST, basename(asset)));

  const outputs = [
    ...ENTRIES.map((target) => join(DIST, target.output)),
    ...ASSETS.map((asset) => join(DIST, basename(asset))),
  ];
  if (!quiet) {
    console.log(`✓ 构建完成 → ${DIST}`);
    for (const output of outputs) {
      const size = (await Deno.stat(output)).size;
      console.log(`  ${basename(output).padEnd(12)} ${(size / 1024).toFixed(1)} KiB`);
    }
  }
  return outputs;
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  if (args.has("-h") || args.has("--help")) {
    console.log(`用法：deno run -A tools/build.mjs [--dev]

  --dev    开发构建：不压缩（便于调试）
  --help   显示本帮助`);
    Deno.exit(0);
  }
  await build({ minify: !args.has("--dev") });
}
