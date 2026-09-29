@echo off
title SVM 3D Analyzer Pro - dev server
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 5 /nobreak >nul && start http://127.0.0.1:5188/"
echo Starting SVM 3D Analyzer Pro on http://127.0.0.1:5188/
echo Close this window to stop the server.
echo.
npm run dev -- --port 5188 --host 127.0.0.1 --strictPort
