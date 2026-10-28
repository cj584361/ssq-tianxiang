@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 双色球天象选号

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE goto nonode

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5173'"
"%NODE_EXE%" server.js
pause
exit /b 0

:nonode
echo.
echo   未找到 Node.js。
echo   请先安装 https://nodejs.org 后重新双击本文件。
echo.
pause
exit /b 1
