@echo off
REM Doppelklicken. Startet die Einrichtung in PowerShell.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\install-windows.ps1"
if errorlevel 1 pause
