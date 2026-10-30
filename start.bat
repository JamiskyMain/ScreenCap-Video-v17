@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
 echo Node.js is required. Install Node.js LTS from https://nodejs.org/ and try again.
 pause
 exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
 echo npm was not found. Repair your Node.js installation.
 pause
 exit /b 1
)
if not exist "node_modules\electron" (
 echo Installing ScreenCap Video dependencies for the first launch...
 call npm install
 if errorlevel 1 goto fail
)
call npm start
if errorlevel 1 goto fail
exit /b 0
:fail
echo ScreenCap Video could not start. Review the errors above.
pause
exit /b 1
