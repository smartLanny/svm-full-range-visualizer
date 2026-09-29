@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem SVM Full-Range Visualizer - quick launcher for Windows (docs/adr/0008).
rem Keep the lines above ASCII: they are parsed before the code page switches to UTF-8.
chcp 65001 >nul
title SVM 全范围可视化
cd /d "%~dp0"

set "SVM_APP=%~dp0release\SVM-Visualizer.html"
if exist "%SVM_APP%" goto open_release
goto dev_server

rem ---------------------------------------------------------------------------
rem Offline single-file build: open it as an app window (Edge / Chrome --app).
rem ---------------------------------------------------------------------------
:open_release
set "SVM_URL="
rem file:/// URL with spaces and non-ASCII characters percent-encoded (Chromium needs ASCII).
for /f "usebackq delims=" %%U in (`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "([System.Uri]$env:SVM_APP).AbsoluteUri" 2^>nul`) do set "SVM_URL=%%U"

set "SVM_BROWSER="
call :find_browser

if not defined SVM_URL goto open_default
if not defined SVM_BROWSER goto open_default
echo 正在以应用窗口打开 SVM 全范围可视化 ...
start "" "%SVM_BROWSER%" --app="%SVM_URL%" --start-maximized
exit /b 0

:open_default
echo 正在用默认浏览器打开 SVM 全范围可视化 ...
start "" "%SVM_APP%"
exit /b 0

rem ---------------------------------------------------------------------------
rem No release file: run the development server (needs Node.js 20.19+ or 22.12+).
rem ---------------------------------------------------------------------------
:dev_server
where node >nul 2>nul
if errorlevel 1 goto no_node
rem Same range as package.json "engines" (@vitejs/plugin-react needs ^20.19 or >=22.12).
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)" >nul 2>nul
if errorlevel 1 goto old_node
if exist "%~dp0node_modules\" goto run_dev
echo 首次运行：正在安装依赖 npm install，可能需要几分钟 ...
call npm install
if errorlevel 1 goto npm_failed

:run_dev
echo 未找到离线版 release\SVM-Visualizer.html，改为启动本地开发服务：
echo     http://127.0.0.1:5188/
echo 关闭此窗口即可停止服务。
echo 提示：运行 npm run build:standalone 可生成双击即用的离线版。
echo.
start "" /min cmd /c "timeout /t 5 /nobreak >nul && start http://127.0.0.1:5188/"
call npm run dev -- --port 5188 --host 127.0.0.1 --strictPort
if errorlevel 1 pause
exit /b 0

:npm_failed
echo.
echo 依赖安装失败，请检查网络后重试，或下载包含 release 文件夹的完整版本。
pause
exit /b 1

:no_node
echo.
echo 未找到离线版文件 release\SVM-Visualizer.html，也没有安装 Node.js。
echo 解决方法任选其一：
echo   1. 下载包含 release 文件夹的完整版本，然后重新双击 start-svm.bat；
echo   2. 安装 Node.js 22 LTS（至少 20.19 或 22.12）https://nodejs.org/ 后重新运行本脚本。
pause
exit /b 1

:old_node
set "SVM_NODE_VERSION=unknown"
for /f "delims=" %%V in ('node -v 2^>nul') do set "SVM_NODE_VERSION=%%V"
echo.
echo 未找到离线版文件 release\SVM-Visualizer.html，而本机的 Node.js %SVM_NODE_VERSION% 版本过旧，无法启动开发服务。
echo 解决方法任选其一：
echo   1. 下载包含 release 文件夹的完整版本，然后重新双击 start-svm.bat；
echo   2. 升级到 Node.js 22 LTS（至少 20.19 或 22.12）https://nodejs.org/ 后重新运行本脚本。
pause
exit /b 1

rem ---------------------------------------------------------------------------
rem Find Microsoft Edge (preinstalled on Windows 10/11), then Google Chrome.
rem ---------------------------------------------------------------------------
:find_browser
for %%P in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
) do if not defined SVM_BROWSER if exist "%%~P" set "SVM_BROWSER=%%~P"
if not defined SVM_BROWSER call :browser_from_registry msedge.exe
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if not defined SVM_BROWSER if exist "%%~P" set "SVM_BROWSER=%%~P"
if not defined SVM_BROWSER call :browser_from_registry chrome.exe
exit /b 0

rem Look the executable up in "App Paths" (per-user first, then machine-wide).
:browser_from_registry
for %%K in (HKCU HKLM) do if not defined SVM_BROWSER (
  for /f "tokens=2,*" %%A in ('reg query "%%K\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%~1" /ve 2^>nul ^| find "REG_SZ"') do (
    if exist "%%~B" set "SVM_BROWSER=%%~B"
  )
)
exit /b 0
