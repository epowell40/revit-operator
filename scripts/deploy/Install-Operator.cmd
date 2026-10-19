@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Operator.ps1"
set "OperatorInstallExit=%ERRORLEVEL%"
echo.
if not "%OperatorInstallExit%"=="0" echo Installation stopped. Keep the output above for support.
pause
exit /b %OperatorInstallExit%
