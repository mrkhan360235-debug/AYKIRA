@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer first.
  pause
  exit /b 1
)
node setup.js
if errorlevel 1 (pause & exit /b 1)
echo Open http://localhost:3000 after the server starts.
echo Admin: http://localhost:3000/admin.html
echo Keep this window open. Press Ctrl+C to stop your server.
node server.js
pause
endlocal
