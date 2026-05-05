@echo off
if /I "%DEBUG_RELEASE%"=="1" echo on
setlocal enabledelayedexpansion

echo ========================================
echo OCS Release Script
echo ========================================
echo.

REM ----------------------------
REM Preflight checks
REM ----------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git is not installed or not in PATH
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo ERROR: pnpm is not installed or not in PATH
  exit /b 1
)

if exist "src-tauri\Cargo.toml" (
  where cargo >nul 2>&1
  if errorlevel 1 (
    echo ERROR: cargo is not installed or not in PATH
    exit /b 1
  )
)

REM ----------------------------
REM Extract current version from package.json
REM ----------------------------
echo Extracting current version from package.json...
for /f "usebackq tokens=*" %%v in (`
  powershell -NoProfile -Command ^
    "$pj = Get-Content -Raw 'package.json' | ConvertFrom-Json; $v=$pj.version; if (-not $v) { throw 'Missing version in package.json' }; $v"
`) do set "VERSION=%%v"

if "%VERSION%"=="" (
  echo ERROR: Failed to extract version from package.json
  exit /b 1
)

echo Current version: %VERSION%

for /f "tokens=1-3 delims=." %%a in ("%VERSION%") do (
  set "MAJOR=%%a"
  set "MINOR=%%b"
  set "PATCH=%%c"
)

if "%MAJOR%"=="" (
  echo ERROR: Failed to parse version: %VERSION%
  exit /b 1
)

REM ----------------------------
REM Determine next version
REM - Default is a MAJOR bump (e.g. 2.6.29 -> 3.0.0)
REM - Override with:
REM   - RELEASE_VERSION=2.1.0 (exact)
REM   - RELEASE_BUMP=patch|minor|major
REM ----------------------------
if "%RELEASE_BUMP%"=="" set "RELEASE_BUMP=major"

REM Normalize RELEASE_VERSION (allow "v2.1.0") and guard against stale overrides
if defined RELEASE_VERSION (
  if "!RELEASE_VERSION:~0,1!"=="v" set "RELEASE_VERSION=!RELEASE_VERSION:~1!"

  if "%RELEASE_VERSION%"=="%VERSION%" (
    echo WARNING: RELEASE_VERSION matches current version %VERSION%. Ignoring RELEASE_VERSION and using RELEASE_BUMP=%RELEASE_BUMP%.
    set "RELEASE_VERSION="
  ) else (
    echo Using RELEASE_VERSION=%RELEASE_VERSION%
  )
) else (
  echo Using RELEASE_BUMP=%RELEASE_BUMP%
)

if not "%RELEASE_VERSION%"=="" (
  set "NEW_VERSION=%RELEASE_VERSION%"
) else (
  if /I "%RELEASE_BUMP%"=="patch" (
    set /a PATCH=%PATCH%+1
  ) else if /I "%RELEASE_BUMP%"=="minor" (
    set /a MINOR=%MINOR%+1
    set "PATCH=0"
  ) else if /I "%RELEASE_BUMP%"=="major" (
    set /a MAJOR=%MAJOR%+1
    set "MINOR=0"
    set "PATCH=0"
  ) else (
    echo ERROR: Invalid RELEASE_BUMP="%RELEASE_BUMP%". Use patch^|minor^|major, or set RELEASE_VERSION.
    exit /b 1
  )

  set "NEW_VERSION=!MAJOR!.!MINOR!.!PATCH!"
)

echo New version will be: %NEW_VERSION%
echo.

REM Check if tag already exists (we will force-move it later if needed)
git rev-parse --verify "v%NEW_VERSION%" >nul 2>&1
if not errorlevel 1 (
  echo WARNING: Tag v%NEW_VERSION% already exists locally and will be updated.
)

REM ----------------------------
REM Tunables (safe defaults)
REM ----------------------------
if "%TEARDOWN_TIMEOUT_MS%"=="" set "TEARDOWN_TIMEOUT_MS=2000"
if "%VITEST_TEST_TIMEOUT_MS%"=="" set "VITEST_TEST_TIMEOUT_MS=30000"
if "%RUST_TEST_THREADS%"=="" set "RUST_TEST_THREADS=4"
set "RUST_BACKTRACE=1"

echo Using TEARDOWN_TIMEOUT_MS=%TEARDOWN_TIMEOUT_MS%
echo Using VITEST_TEST_TIMEOUT_MS=%VITEST_TEST_TIMEOUT_MS%
echo Using RUST_TEST_THREADS=%RUST_TEST_THREADS%
echo.

echo ========================================
echo Step 1: Formatting code with Biome...
echo ========================================
call pnpm biome check . --write --unsafe --diagnostic-level=error --max-diagnostics 100
if errorlevel 1 (
  echo ERROR: Biome check failed!
  exit /b %errorlevel%
)

call pnpm biome check ./src --write --unsafe --diagnostic-level=error --max-diagnostics 100
if errorlevel 1 (
  echo ERROR: Biome check failed!
  exit /b %errorlevel%
)
echo [OK] Code formatted successfully
echo.

echo ========================================
echo Step 2: Running TypeScript type check...
echo ========================================
call pnpm tsc --noEmit
if errorlevel 1 (
  echo ERROR: TypeScript type check failed!
  exit /b %errorlevel%
)
echo [OK] TypeScript check passed
echo.

echo ========================================
echo Step 3: Running frontend tests...
echo ========================================
call pnpm vitest run --coverage --pool=forks --reporter=verbose --teardownTimeout=%TEARDOWN_TIMEOUT_MS% --testTimeout=%VITEST_TEST_TIMEOUT_MS%
if errorlevel 1 (
  echo ERROR: Frontend tests failed!
  exit /b %errorlevel%
)
echo [OK] Frontend tests passed
echo.

echo ========================================
echo Step 4: Running backend tests...
echo ========================================
if exist "src-tauri\Cargo.toml" (
  pushd src-tauri
  call cargo test --all-features --workspace -- --nocapture --test-threads %RUST_TEST_THREADS%
  if errorlevel 1 (
    echo ERROR: Backend tests failed!
    popd
    exit /b %errorlevel%
  )
  popd
)
echo [OK] Backend tests passed
echo.

echo ========================================
echo Step 5: Generating backend coverage...
echo ========================================
if exist "src-tauri\Cargo.toml" (
  pushd src-tauri
  call cargo llvm-cov --all-features --workspace --lcov --output-path coverage-rust.lcov
  if errorlevel 1 (
    echo WARNING: Coverage analysis failed, continuing without coverage metrics...
  )
  popd
)
echo [OK] Coverage analysis completed
echo.

echo ========================================
echo Step 6: Updating documentation...
echo ========================================
call pnpm update-coverage
if errorlevel 1 (
  echo ERROR: Failed to update coverage metrics!
  exit /b %errorlevel%
)

call pnpm update-readme
if errorlevel 1 (
  echo ERROR: Failed to update README!
  exit /b %errorlevel%
)
echo [OK] Documentation updated
echo.

echo ========================================
echo Step 7: Updating version...
echo ========================================
call pnpm update-version v%NEW_VERSION%
if errorlevel 1 (
  echo ERROR: Failed to update version!
  exit /b %errorlevel%
)
echo [OK] Version updated to v%NEW_VERSION%
echo.

echo ========================================
echo Step 8: Creating git commit and tag...
echo ========================================
git add .
if errorlevel 1 (
  echo ERROR: Failed to stage changes!
  exit /b %errorlevel%
)

git diff --cached --quiet
if not errorlevel 1 (
  echo ERROR: Nothing staged to commit. Aborting release.
  exit /b 1
)

git commit -m "Release %NEW_VERSION%"
if errorlevel 1 (
  echo ERROR: Failed to create commit!
  exit /b %errorlevel%
)
echo [OK] Commit created: "Release %NEW_VERSION%"

git tag -f v%NEW_VERSION%
if errorlevel 1 (
  echo ERROR: Failed to create tag!
  exit /b %errorlevel%
)
echo [OK] Tag created: v%NEW_VERSION%
echo.

echo ========================================
echo Step 9: Pushing to remote...
echo ========================================
echo NOTE: This script force-pushes rewritten history. Make sure you have coordinated with any collaborators.
git push --force-with-lease
if errorlevel 1 (
  echo ERROR: Failed to push commits!
  exit /b %errorlevel%
)

git push --force origin v%NEW_VERSION%
if errorlevel 1 (
  echo ERROR: Failed to push tag!
  exit /b %errorlevel%
)
echo [OK] Pushed to remote
echo.

echo ========================================
echo Release v%NEW_VERSION% completed successfully!
echo ========================================
endlocal
