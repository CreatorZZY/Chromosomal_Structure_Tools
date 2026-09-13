#!/usr/bin/env bash
# 一键部署到 Cloudflare Workers（静态资源模式，见 wrangler.jsonc）。
#
# 用法：
#   deno task deploy                 # 构建 dist/ 后部署
#   deno task deploy -- --dry-run    # 只校验产物与配置，不上传
#   deno task deploy -- --no-build   # 跳过构建，部署现有 dist/
#
# 鉴权（二选一）：
#   export CLOUDFLARE_API_TOKEN=xxx    # 推荐：控制台创建的长期 Token
#   npx wrangler login                 # OAuth，会过期，过期后重登
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-npx wrangler}"
DRY_RUN=""
SKIP_BUILD=0
EXTRA_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN="--dry-run" ;;
        --no-build) SKIP_BUILD=1 ;;
        --) ;; # deno task 会把分隔符也传进来，忽略
        -h | --help)
            cat <<'USAGE'
一键部署到 Cloudflare Workers（静态资源模式）。

用法：
  deno task deploy                 # 构建 dist/ 后部署
  deno task deploy -- --dry-run    # 只校验产物与配置，不上传
  deno task deploy -- --no-build   # 跳过构建，部署现有 dist/

鉴权（二选一）：
  export CLOUDFLARE_API_TOKEN=xxx    # 推荐：控制台创建的长期 Token
  npx wrangler login                 # OAuth，会过期，过期后重登

环境变量：
  WRANGLER=<命令>   默认 "npx wrangler"，可换成其它 wrangler 调用方式
USAGE
            exit 0
            ;;
        *) EXTRA_ARGS+=("$arg") ;;
    esac
done

echo "==> [1/3] 检查 Cloudflare 凭据"
# 只做非阻塞提醒，不自动登录（OAuth token 会过期，反复弹浏览器很烦）
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_API_KEY:-}" ] &&
    [ ! -f "$HOME/.config/.wrangler/config/default.toml" ] &&
    [ ! -f "$HOME/.wrangler/config/default.toml" ]; then
    echo "    警告：未检测到 CLOUDFLARE_API_TOKEN，也没找到 wrangler 登录凭据。"
    echo "    若部署报鉴权错误，请设置 CLOUDFLARE_API_TOKEN，或执行 npx wrangler login。"
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "==> [2/3] 构建 dist/"
    deno task build
else
    echo "==> [2/3] 跳过构建，使用现有 dist/"
fi

echo "==> [3/3] 部署到 Cloudflare Workers"
# shellcheck disable=SC2086  # WRANGLER 需要按空格拆成命令与子命令
$WRANGLER deploy $DRY_RUN ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

if [ -z "$DRY_RUN" ]; then
    echo ""
    echo "✅ 部署完成（站点地址见上面的 wrangler 输出）"
fi
