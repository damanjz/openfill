@echo off
rem Removes a manual OpenFill install. Close Photoshop first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\uninstall.ps1"
pause
