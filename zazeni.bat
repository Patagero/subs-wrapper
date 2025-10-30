@echo off
title Subs Wrapper z LocalTunnel
cd /d C:\subs-wrapper
echo Zagon wrapperja...
start "Wrapper" cmd /k "node index.js"
timeout /t 5 >nul
echo Zagon LocalTunnel povezave...
lt --port 7000
pause
