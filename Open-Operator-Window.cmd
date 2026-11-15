@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\opencore\Show.ps1"
if not "%ERRORLEVEL%"=="0" pause
