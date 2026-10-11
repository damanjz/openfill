@echo off
rem Installs OpenFill for Photoshop without the Creative Cloud app. Close Photoshop first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" -Source "%~dp0plugin"
pause
