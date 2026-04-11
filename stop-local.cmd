@echo off
setlocal
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3100 ^| findstr LISTENING') do (
  taskkill /PID %%p /F
)
echo Stopped processes listening on port 3100.

