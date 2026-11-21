@echo off
title Discord Raw Recording Merger
cd /d "%~dp0"
echo =======================================================
echo     Starting Raw Recording Merge ^& Silence Removal     
echo =======================================================
echo.

node scripts\merge_raw.js %*

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [Error] Processing encountered an issue.
  pause
) else (
  echo.
  echo Done! You can close this window.
  timeout /t 5 >nul
)
