@echo off
setlocal
cd /d "%~dp0"
start "" powershell -ExecutionPolicy Bypass -File "%~dp0scripts\start-morning.ps1"
timeout /t 20 /nobreak >nul
start "" http://localhost:3100/admin
