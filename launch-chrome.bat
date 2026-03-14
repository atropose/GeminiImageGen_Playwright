@echo off
REM ============================================================
REM  Gemini Image Bot — Chrome Launcher
REM  Run this BEFORE starting "node server.js"
REM ============================================================
REM  Launches Google Chrome with remote debugging enabled on
REM  port 9222. The app auto-connects to this Chrome instance,
REM  reusing your existing Google login session.
REM ============================================================

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"

REM Try 64-bit path first, fall back to 32-bit
if not exist %CHROME% (
  set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

if not exist %CHROME% (
  echo ERROR: Google Chrome not found. Install Chrome or edit this file
  echo to point to your chrome.exe location.
  pause
  exit /b 1
)

echo Starting Chrome with remote debugging on port 9222...
echo.
echo After Chrome opens:
echo   1. Make sure you are logged into Google / Gemini
echo   2. Run: node server.js
echo   3. Open: http://localhost:3000
echo.

start "" %CHROME% --remote-debugging-port=9222

echo Chrome launched. You can now run "node server.js".
