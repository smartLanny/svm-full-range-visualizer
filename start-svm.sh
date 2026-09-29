#!/usr/bin/env bash
# SVM 全范围可视化 — Linux quick launcher (docs/adr/0008).
# Opens the offline single-file build as an app window (Chromium / Chrome / Edge --app), or with
# xdg-open; without the release file it starts the dev server (needs Node.js 20.19+ or 22.12+).
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"
APP="$ROOT/release/SVM-Visualizer.html"
NODE_OK_JS="const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)"

# Percent-encode a path for a file:// URL (byte-wise; keeps / and unreserved characters).
urlencode_path() {
  local out="" hex
  for hex in $(printf '%s' "$1" | od -An -v -tx1); do
    case "$hex" in
      2d|2e|2f|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e) out+=$(printf "\\x$hex") ;;
      *) out+="%$(printf '%s' "$hex" | tr 'a-f' 'A-F')" ;;
    esac
  done
  printf '%s' "$out"
}

if [ -f "$APP" ]; then
  URL="file://$(urlencode_path "$APP")"
  for BROWSER in chromium chromium-browser google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable brave-browser; do
    if command -v "$BROWSER" >/dev/null 2>&1; then
      echo "正在以应用窗口打开 SVM 全范围可视化（$BROWSER）…"
      nohup "$BROWSER" --app="$URL" >/dev/null 2>&1 &
      exit 0
    fi
  done
  echo "正在用默认浏览器打开 SVM 全范围可视化…"
  xdg-open "$APP" >/dev/null 2>&1 &
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到离线版文件 release/SVM-Visualizer.html，也没有安装 Node.js。"
  echo "请下载包含 release 文件夹的完整版本，或安装 Node.js 22 LTS（至少 20.19 或 22.12，https://nodejs.org/）后重新运行。"
  exit 1
fi
# Same range as package.json "engines" (@vitejs/plugin-react needs ^20.19 or >=22.12).
if ! node -e "$NODE_OK_JS" >/dev/null 2>&1; then
  echo "未找到离线版文件 release/SVM-Visualizer.html，而本机的 Node.js $(node -v 2>/dev/null) 版本过旧，无法启动开发服务。"
  echo "请下载包含 release 文件夹的完整版本，或升级到 Node.js 22 LTS（至少 20.19 或 22.12，https://nodejs.org/）后重新运行。"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖（npm install），可能需要几分钟…"
  npm install || exit 1
fi
echo "未找到离线版，改为启动本地开发服务：http://127.0.0.1:5188/（Ctrl+C 停止）"
echo "提示：运行 npm run build:standalone 可生成双击即用的离线版。"
(sleep 4 && xdg-open "http://127.0.0.1:5188/" >/dev/null 2>&1) &
exec npm run dev -- --port 5188 --host 127.0.0.1 --strictPort
