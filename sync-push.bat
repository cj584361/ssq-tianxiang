@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 同步开奖数据并推送到线上

rem ==================================================================
rem  为什么需要这个文件
rem
rem  福彩官网只对国内 IP 开放。GitHub 的服务器在海外，抓不到，
rem  所以线上那版没法自己更新——这台电脑是唯一能抓到数据的地方。
rem
rem  双击本文件 = 抓官网 → 写 data.json / history.json → 推 GitHub
rem  → 一分钟后 GitHub Pages 自动生效，手机上看也是最新的。
rem
rem  想让它是全自动的，把本文件丢进「任务计划程序」，
rem  设置成每天 21:40 和 22:10 各跑一次即可。
rem ==================================================================

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE goto nonode

echo.
echo   [1/3] 抓最新一期
"%NODE_EXE%" scripts\sync-draw.js
if errorlevel 1 goto failed

echo   [2/3] 抓近 100 期（奖金曲线用）
"%NODE_EXE%" scripts\sync-history.js

echo   [3/3] 推送到 GitHub
git add data.json history.json
git diff --cached --quiet
if not errorlevel 1 goto nochange

git -c user.name="chenj" -c user.email="5194687@qq.com" commit -q -m "chore: 同步开奖数据 %date% %time%"
git push -q origin main
if errorlevel 1 goto pushfail

echo.
echo   已推送。约 1 分钟后线上生效：https://cj584361.github.io/ssq-tianxiang/
echo.
pause
exit /b 0

:nochange
echo.
echo   数据没有变化（官网还是那一期），不提交。
echo.
pause
exit /b 0

:pushfail
echo.
echo   推送失败。检查网络，或在命令行执行 git push 看具体报错。
echo.
pause
exit /b 1

:failed
echo.
echo   抓取失败。官网可能暂时连不上，稍后再试；现有数据没被改动。
echo.
pause
exit /b 1

:nonode
echo.
echo   未找到 Node.js，请先安装 https://nodejs.org 后重新双击本文件。
echo.
pause
exit /b 1
