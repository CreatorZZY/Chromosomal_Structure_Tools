/**
 * 静态文件服务器：零依赖，只用 Deno.serve。
 *
 *   deno task preview        # 托管 dist/（http://127.0.0.1:4173）
 *   deno run --allow-read --allow-net tools/serve.mjs --root dist --port 4173
 *
 * @module tools/serve
 */
import { dirname, extname, join, normalize, resolve } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".metrics": "text/plain; charset=utf-8",
};

/**
 * 启动静态服务器。
 * @param {{root: string, port: number, hostname?: string}} options
 * @returns {Deno.HttpServer}
 */
export function serve({ root, port, hostname = "127.0.0.1" }) {
  const base = resolve(root);

  return Deno.serve({ port, hostname, onListen: () => {} }, async (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    // 归一化后必须仍在 root 之内，避免 ../ 越权读取
    const target = resolve(join(base, normalize(path)));
    if (target !== base && !target.startsWith(base + "/")) {
      return new Response("403 Forbidden", { status: 403 });
    }

    const file = path.endsWith("/") ? join(target, "index.html") : target;
    try {
      const body = await Deno.readFile(file);
      const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, {
        headers: { "content-type": type, "cache-control": "no-cache" },
      });
    } catch {
      return new Response("404 Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }
  });
}

if (import.meta.main) {
  const options = { root: join(dirname(import.meta.dirname), "dist"), port: 4173 };
  const args = Deno.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") options.root = args[++i];
    else if (args[i] === "--port") options.port = Number(args[++i]);
    else if (args[i] === "-h" || args[i] === "--help") {
      console.log(
        `用法：deno run --allow-read --allow-net tools/serve.mjs [--root dist] [--port 4173]`,
      );
      Deno.exit(0);
    }
  }

  const server = serve(options);
  console.log(`静态服务器已启动：http://127.0.0.1:${server.addr.port}/  （托管 ${options.root}）`);
}
