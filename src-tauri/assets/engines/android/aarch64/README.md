# Stockfish Engine for Android
# Stockfish Engine for Android

This directory contains helper docs for bundling Stockfish on Android ARM64 (aarch64).

## How to get the binary

1. Download the Stockfish 18 release from:
   https://github.com/official-stockfish/Stockfish/releases/tag/sf_18

2. Download the files:
   - `stockfish-android-armv8.tar`
   - `stockfish-android-armv8-dotprod.tar`

3. Place both `.tar` files at the repo root (next to `package.json`).

4. Build for Android. The Rust build script extracts the `stockfish` binary from each tarball and bundles:
   - baseline build as `libstockfish.so` (nativeLibraryDir) and `assets/engines/stockfish`
   - dotprod build as `libstockfish_dotprod.so` (nativeLibraryDir) and `assets/engines/stockfish-dotprod`

## File structure

At build time, the engine files are written under `src-tauri/gen/android/...` for Gradle packaging.
