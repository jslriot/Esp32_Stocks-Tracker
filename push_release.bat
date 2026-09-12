@echo off
echo ===============================================
echo   Pushing Esp32_Stocks-Tracker to GitHub
echo ===============================================

echo.
echo [1/6] Adding files...
git add -A

echo.
echo [2/6] Committing...
git commit -m "Initial commit"

echo.
echo [3/6] Setting branch to main...
git branch -M main

echo.
echo [4/6] Connecting to GitHub...
git remote remove origin 2>nul
git remote add origin https://github.com/jslriot/Esp32_Stocks-Tracker.git

echo.
echo [5/6] Pushing to GitHub (a browser window may pop up asking you to sign in)...
git push -u origin main

echo.
echo [6/6] Tagging and pushing release v2.3.1 (this triggers the build)...
git tag v2.3.1
git push origin v2.3.1

echo.
echo ===============================================
echo   Done! Go to github.com/jslriot/Esp32_Stocks-Tracker
echo   and click the "Actions" tab to watch it build.
echo ===============================================
pause
