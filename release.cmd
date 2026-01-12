@echo off
setlocal enabledelayedexpansion

for /f "usebackq tokens=*" %%v in (`powershell -NoProfile -Command "$pj = Get-Content -Raw 'package.json' | ConvertFrom-Json; $v=$pj.version; if (-not $v) { throw 'Missing version in package.json' }; $v"`) do set VERSION=%%v

for /f "tokens=1-3 delims=." %%a in ("%VERSION%") do (
  set MAJOR=%%a
  set MINOR=%%b
  set PATCH=%%c
)

if "%MAJOR%"=="" (
  echo Failed to parse version: %VERSION%
  exit /b 1
)

set /a PATCH=%PATCH%+1
set NEW_VERSION=%MAJOR%.%MINOR%.%PATCH%

call pnpm update-version v%NEW_VERSION%
if errorlevel 1 exit /b %errorlevel%

call pnpm update-readme
if errorlevel 1 exit /b %errorlevel%

call pnpm tauri android init
if errorlevel 1 exit /b %errorlevel%

git add .
git commit -m "release"
if errorlevel 1 exit /b %errorlevel%

git tag v%NEW_VERSION%
if errorlevel 1 exit /b %errorlevel%

git push
git push origin v%NEW_VERSION%

echo Released v%NEW_VERSION%
endlocal
