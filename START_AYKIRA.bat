@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js 18+ required. & pause & exit /b 1)
if not exist node_modules\razorpay (call npm install --no-audit --no-fund || (pause & exit /b 1))

echo Checking AYKIRA server on port 3000...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do (
  echo Stopping old AYKIRA server PID %%P...
  taskkill /F /PID %%P >nul 2>nul
)

echo Starting AYKIRA V21 server...
start "AYKIRA V21 Server" cmd /k "cd /d "%~dp0" && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
endlocal
