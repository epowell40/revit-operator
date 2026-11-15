@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\opencore\Setup.ps1" %*
set "result=%ERRORLEVEL%"
echo.
if not "%result%"=="0" echo Setup stopped. Read the message above; no need to run as administrator.
pause
exit /b %result%
