@echo off
setlocal
cd /d "%~dp0"
title Alembic Generative Studio

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this only happens once...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo  Alembic Generative Studio is starting at http://localhost:5178
echo  A browser window opens automatically. Close this window to stop the server.
echo.
call npx vite --port 5178 --strictPort --open
pause
