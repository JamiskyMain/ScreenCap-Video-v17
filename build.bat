@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
 echo Install Node.js LTS from https://nodejs.org/ first.
 pause
 exit /b 1
)
call npm install
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail
start "" "%~dp0dist"
exit /b 0
:fail
echo Build failed. Check the console errors above.
pause
exit /b 1
