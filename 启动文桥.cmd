@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "release\0.1.5\早日发Paper-win32-x64\早日发Paper.exe" (
  start "" "release\0.1.5\早日发Paper-win32-x64\早日发Paper.exe"
  exit /b
)
if exist "release\0.1.4\早日发Paper-win32-x64\早日发Paper.exe" (
  start "" "release\0.1.4\早日发Paper-win32-x64\早日发Paper.exe"
  exit /b
)
if exist "release\0.1.3\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\0.1.3\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
if exist "release\0.1.2\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\0.1.2\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
if exist "release\0.1.1\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\0.1.1\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
if exist "release\latest\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\latest\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
if exist "release\clean\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\clean\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
if exist "release\PaperBridge-win32-x64\PaperBridge.exe" (
  start "" "release\PaperBridge-win32-x64\PaperBridge.exe"
  exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, or use the packaged PaperBridge.exe.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm.cmd start
if errorlevel 1 pause
