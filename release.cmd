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

echo Formatting and organizing imports with Biome...
call pnpm biome check . --write --unsafe --diagnostic-level=error --max-diagnostics  100
call pnpm biome check ./src --write --unsafe --diagnostic-level=error --max-diagnostics  100

if errorlevel 1 (
  echo Biome check failed!
  exit /b %errorlevel%
)

call pnpm update-version v%NEW_VERSION%
if errorlevel 1 exit /b %errorlevel%

echo Running lint checks...

call pnpm tsc --noEmit
if errorlevel 1 (
  echo Lint checks failed!
  exit /b %errorlevel%
)

echo Running frontend tests with coverage...
call pnpm vitest run --coverage --teardownTimeout=10000 --pool=forks --reporter=verbose
if errorlevel 1 (
  echo Frontend tests failed!
  exit /b %errorlevel%
)

echo Running backend tests...
cd src-tauri
call cargo test --all-features --workspace
if errorlevel 1 (
  echo Backend tests failed!
  cd ..
  exit /b %errorlevel%
)

echo Running backend coverage analysis...
call cargo llvm-cov --all-features --workspace --lcov --output-path coverage-rust.lcov
if errorlevel 1 (
  echo Warning: Coverage analysis failed, continuing without coverage metrics...
)
cd ..

echo Updating README with coverage metrics...
call pnpm update-coverage
if errorlevel 1 exit /b %errorlevel%

call pnpm update-readme
if errorlevel 1 exit /b %errorlevel%

call pnpm tauri init
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
