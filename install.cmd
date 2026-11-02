@echo off
setlocal
rem Windows convenience wrapper: works even when the PowerShell execution policy
rem blocks unsigned scripts.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
