#!/usr/bin/env bash
# Intra setup for macOS + Chrome. Each step only runs when you invoke it explicitly.
#   ./scripts/setup.sh                       check prerequisites, install deps, build, create extension manifest
#   ./scripts/setup.sh register --extension-id ID [--chrome-dir DIR]
#                                            generate the Native Host launcher and install it for Chrome
#   ./scripts/setup.sh mcp-config [--profile ALIAS]
#                                            print MCP client configuration snippets
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTRA_HOME="${INTRA_HOME:-$HOME/.intra}"
CHROME_DIR_DEFAULT="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

node_bin() {
  local node; node="$(command -v node || true)"
  [[ -n "$node" ]] || die "未找到 node。请先安装 Node.js 22 或更高版本。"
  # Resolve symlinks so Chrome and MCP clients get a stable absolute executable path.
  "$node" -e 'process.stdout.write(require("fs").realpathSync(process.execPath))'
}

check_prerequisites() {
  [[ "$(uname -s)" == "Darwin" ]] || die "目前只支持 macOS（凭据保存在 macOS Keychain）。"
  local node major; node="$(node_bin)"
  major="$("$node" -p 'process.versions.node.split(".")[0]')"
  (( major >= 22 )) || die "需要 Node.js >= 22，当前是 $("$node" -v)。"
  command -v npm >/dev/null || die "未找到 npm。"
  if ! xcrun --find clang >/dev/null 2>&1; then
    die "未找到 Xcode 命令行工具：首次读写 Keychain 时要用 clang 编译一个小助手程序。请运行 xcode-select --install 后重试。"
  fi
  say "环境检查通过：macOS，Node $("$node" -v)，clang 可用"
}

cmd_install() {
  check_prerequisites
  say "安装依赖并构建"
  (cd "$ROOT" && npm ci --no-audit --no-fund && npm run build)
  if [[ -f "$ROOT/apps/extension/manifest.json" ]]; then
    say "扩展 manifest 已存在，跳过生成"
  else
    (cd "$ROOT" && node apps/extension/build.mjs)
  fi
  cat <<EOF

下一步：
  1. 打开 chrome://extensions，开启右上角“开发者模式”。
  2. 点“加载已解压的扩展程序”，选择目录：
       $ROOT/apps/extension
  3. 复制扩展卡片上的 ID（32 个小写字母），然后运行：
       ./scripts/setup.sh register --extension-id <扩展ID>
EOF
}

cmd_register() {
  local extension_id="" chrome_dir="$CHROME_DIR_DEFAULT"
  while (( $# )); do
    case "$1" in
      --extension-id) extension_id="${2:-}"; shift 2 ;;
      --chrome-dir) chrome_dir="${2:-}"; shift 2 ;;
      *) die "未知参数：$1" ;;
    esac
  done
  [[ "$extension_id" =~ ^[a-p]{32}$ ]] || die "--extension-id 必须是 chrome://extensions 上显示的 32 位扩展 ID。"
  local node host; node="$(node_bin)"; host="$ROOT/dist/apps/native-host/src/index.js"
  [[ -f "$host" ]] || die "未找到构建产物 $host，请先运行 ./scripts/setup.sh"

  mkdir -p -m 700 "$INTRA_HOME" "$INTRA_HOME/native-host"
  local staging="$INTRA_HOME/native-host/$(date +%Y%m%d-%H%M%S)"
  say "生成 Native Host 启动器：$staging"
  node "$ROOT/packaging/native-host/generate.mjs" --extension-id "$extension_id" --node "$node" \
    --host "$host" --output "$staging" --home "$INTRA_HOME" >/dev/null

  mkdir -p "$chrome_dir"
  local target="$chrome_dir/com.intra.bridge.json"
  if [[ -e "$target" ]]; then
    local backup="$target.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$target" "$backup"; warn "已有注册文件，已备份到 $backup"
  fi
  cp "$staging/com.intra.bridge.json" "$target"; chmod 600 "$target"
  say "已注册到 Chrome：$target"
  cat <<EOF

下一步：
  1. 在 chrome://extensions 重新加载 Intra 扩展，然后点工具栏里的扩展图标。
  2. 在弹窗中填入要同步登录态的域名（例如 example.com），勾选确认，点“授权并连接”，并在 Chrome 弹框里允许。
  3. 配对 CLI 别名：
       node dist/apps/cli/src/main.js auth profiles
       node dist/apps/cli/src/main.js auth pair --profile work --profile-id <上一步输出的profileId>
  4. 打印 MCP 配置：
       ./scripts/setup.sh mcp-config --profile work

启动器目录 $staging 不要删除，Chrome 通过它启动宿主。
EOF
}

cmd_mcp_config() {
  local profile=""
  while (( $# )); do
    case "$1" in
      --profile) profile="${2:-}"; shift 2 ;;
      *) die "未知参数：$1" ;;
    esac
  done
  local node main; node="$(node_bin)"; main="$ROOT/dist/apps/mcp/src/main.js"
  [[ -f "$main" ]] || warn "尚未构建 $main，请先运行 ./scripts/setup.sh"
  local profile_yaml="" profile_json=""
  if [[ -n "$profile" ]]; then
    profile_yaml=$'\n'"          INTRA_DEFAULT_PROFILE: $profile"
    profile_json=", \"INTRA_DEFAULT_PROFILE\": \"$profile\""
  fi
  cat <<EOF
# —— DeepSeek Harness：追加到 ~/.dsh/profiles/<profile>/cordis.patch.yml ——
- insert:
    - id: mcp-intra
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: intra
        transport: stdio
        command: $node
        args:
          - $main
        env:
          HOME: $HOME
          INTRA_HOME: $INTRA_HOME$profile_yaml
        toolCallTimeoutMs: 120000

# —— Claude Code ——
claude mcp add intra -e INTRA_HOME=$INTRA_HOME${profile:+ -e INTRA_DEFAULT_PROFILE=$profile} -- $node $main

# —— 通用 mcpServers JSON（Cursor、Claude Desktop 等）——
{ "mcpServers": { "intra": { "command": "$node", "args": ["$main"], "env": { "INTRA_HOME": "$INTRA_HOME"$profile_json } } } }
EOF
}

case "${1:-install}" in
  install) shift || true; cmd_install "$@" ;;
  register) shift; cmd_register "$@" ;;
  mcp-config) shift; cmd_mcp_config "$@" ;;
  -h|--help|help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "未知命令：$1（可用：install、register、mcp-config）" ;;
esac
