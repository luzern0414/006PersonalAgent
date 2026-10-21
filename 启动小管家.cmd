@echo off
rem PersonalAgent launcher (no console window). Runs npm install on first launch.
cd /d "%~dp0apps\desktop"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" .
