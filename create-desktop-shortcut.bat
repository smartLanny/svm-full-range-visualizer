@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Creates a desktop shortcut that opens the offline build as an app window (docs/adr/0008).
rem Keep the lines above ASCII: they are parsed before the code page switches to UTF-8.
chcp 65001 >nul
title SVM 全范围可视化 - 创建桌面快捷方式
cd /d "%~dp0"

rem Passed through the environment: a trailing backslash inside quotes would break arguments.
set "SVM_ROOT=%~dp0"
if not exist "%SVM_ROOT%release\SVM-Visualizer.html" goto no_release
if not exist "%SVM_ROOT%scripts\windows\create-shortcut.ps1" goto no_script

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SVM_ROOT%scripts\windows\create-shortcut.ps1"
set "SVM_RC=%errorlevel%"
echo.
if "%SVM_RC%"=="0" goto ok_app
if "%SVM_RC%"=="2" goto ok_default
if "%SVM_RC%"=="3" goto ok_ascii
goto failed

:ok_app
echo 已在桌面创建快捷方式“SVM 全范围可视化”。
echo 双击即可以独立应用窗口打开，无需联网。
goto done

:ok_ascii
echo 已在桌面创建快捷方式“SVM Visualizer”。
echo 双击即可以独立应用窗口打开，无需联网。
goto done

:ok_default
echo 已在桌面创建快捷方式“SVM 全范围可视化”。
echo 未找到 Microsoft Edge 或 Google Chrome，快捷方式将用默认浏览器打开。
goto done

:failed
echo 创建快捷方式失败。
echo 也可以手动创建：右键 release\SVM-Visualizer.html，选择“发送到 - 桌面快捷方式”。
goto done

:no_release
echo 未找到离线版文件 release\SVM-Visualizer.html。
echo 请下载包含 release 文件夹的完整版本，或在项目目录运行 npm run build:standalone 生成。
goto done

:no_script
echo 未找到 scripts\windows\create-shortcut.ps1，请下载完整的项目文件。
goto done

:done
echo.
pause
exit /b 0
