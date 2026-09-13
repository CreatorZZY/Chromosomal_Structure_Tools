/**
 * 开发服务器：构建 + 监听源码变化自动重建 + 静态托管。
 *
 *   deno task dev          # → http://127.0.0.1:5173
 *
 * 改动源码后保存即会自动重建，刷新浏览器即可看到效果（没有 HMR，
 * 本项目的界面状态很轻，整页刷新足够）。
 *
 * 监听用了两条腿，因为实测 inotify 在长时间运行的进程里可能不再派发事件：
 *   1. `Deno.watchFs` 负责即时响应（若迭代中断会自动重启）；
 *   2. 每 2 秒比对一次 mtime + size 作为兜底，保证再慢也会被发现。
 *
 * @module tools/dev
 */
import { join } from "node:path";
import { build } from "./build.mjs";
import { serve } from "./serve.mjs";

const PORT = 5173;
const ROOT = join(import.meta.dirname, "..");
/** 需要监听变化的目录与单文件 */
const WATCH = [join(ROOT, "src"), join(ROOT, "index.html")];
/** 连续事件合并窗口（毫秒） */
const DEBOUNCE = 120;
/** 兜底轮询间隔（毫秒） */
const POLL_INTERVAL = 2000;

console.log("首次构建…");
await build({ minify: false, quiet: true });

const server = serve({ root: join(ROOT, "dist"), port: PORT });
console.log(`开发服务器已启动：http://127.0.0.1:${server.addr.port}/`);
console.log("监听 src/ 与 index.html，保存后自动重建；刷新浏览器查看效果。");

let timer = 0;
let building = false;
let pending = false;
/** 上次记录的文件指纹，用于兜底轮询 */
let signature = snapshot();

/** 触发重建（带防抖，避免一次保存引发多次构建） */
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, DEBOUNCE);
}

async function rebuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  try {
    const started = performance.now();
    await build({ minify: false, clean: false, quiet: true });
    signature = snapshot(); // 构建后刷新指纹，免得兜底轮询自己触发下一轮
    console.log(`↻ 已重建（${(performance.now() - started).toFixed(0)} ms）`);
  } catch (error) {
    console.error(`✗ 构建失败：${error.message}`);
  } finally {
    building = false;
    if (pending) {
      pending = false;
      rebuild();
    }
  }
}

/** 即时监听：迭代意外结束或抛错时自动重启，不让 watcher 静默失效 */
async function watch() {
  for (;;) {
    try {
      for await (const event of Deno.watchFs(WATCH)) {
        if (event.kind === "access") continue;
        schedule();
      }
      console.error("监视流已结束，1 秒后重启…");
    } catch (error) {
      console.error(`监视出错，1 秒后重启：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

watch();

/** 兜底轮询：inotify 漏事件时也能发现改动 */
setInterval(() => {
  const next = snapshot();
  if (next === signature) return;
  signature = next;
  schedule();
}, POLL_INTERVAL);

/**
 * 采集被监听文件的指纹（mtime + size）。
 * @returns {string}
 */
function snapshot() {
  const parts = [];
  for (const path of listFiles()) {
    try {
      const stat = Deno.statSync(path);
      parts.push(`${path}:${stat.mtime?.getTime() ?? 0}:${stat.size}`);
    } catch {
      // 文件刚被删除或替换，忽略即可
    }
  }
  return parts.join("|");
}

/**
 * 列出被监听的文件（src/ 递归 + 额外单文件）。
 * @returns {string[]}
 */
function listFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) walk(path);
      else if (entry.isFile) files.push(path);
    }
  };
  try {
    walk(join(ROOT, "src"));
  } catch {
    // src/ 暂时不可读时跳过
  }
  files.push(join(ROOT, "index.html"));
  return files;
}
