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

rem Check GitHub for a newer version (set NO_UPDATE_CHECK=1 to skip). Exit code 10 = updated: restart
rem so the new version of this script runs. Keep both lines in one block: cmd reads the whole block
rem before running it, so the update can safely replace this file.
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Repo thatBiologyStudent/alembic-generative-studio
  if errorlevel 10 ( set "NO_UPDATE_CHECK=1" & "%~f0" & exit /b )
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
