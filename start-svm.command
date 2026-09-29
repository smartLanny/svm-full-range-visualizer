#!/bin/bash
# SVM 全范围可视化 — macOS quick launcher (docs/adr/0008). Double-click in Finder.
# Opens the offline single-file build as an app window (Chrome / Edge / Chromium --app), or in
# the default browser; without the release file it starts the dev server (needs Node.js 18+).
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"
APP="$ROOT/release/SVM-Visualizer.html"

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
  for BROWSER in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser"; do
    if open -Ra "$BROWSER" >/dev/null 2>&1; then
      echo "正在以应用窗口打开 SVM 全范围可视化（$BROWSER）…"
      open -na "$BROWSER" --args --app="$URL" && exit 0
    fi
  done
  echo "正在用默认浏览器打开 SVM 全范围可视化…"
  open "$APP"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到离线版文件 release/SVM-Visualizer.html，也没有安装 Node.js。"
  echo "请下载包含 release 文件夹的完整版本，或安装 Node.js 18+（https://nodejs.org/）后重新运行。"
  read -r -p "按回车键关闭…" _
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖（npm install），可能需要几分钟…"
  npm install || { read -r -p "依赖安装失败，按回车键关闭…" _; exit 1; }
fi
echo "未找到离线版，改为启动本地开发服务：http://127.0.0.1:5188/（关闭此窗口即可停止）"
echo "提示：运行 npm run build:standalone 可生成双击即用的离线版。"
(sleep 4 && open "http://127.0.0.1:5188/") &
exec npm run dev -- --port 5188 --host 127.0.0.1 --strictPort
