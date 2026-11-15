@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\opencore\Restore.ps1"
set "result=%ERRORLEVEL%"
pause
exit /b %result%
