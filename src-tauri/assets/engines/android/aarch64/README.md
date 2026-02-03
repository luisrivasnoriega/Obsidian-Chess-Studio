# Stockfish Engine for Android
# Stockfish Engine for Android

This directory should contain the Stockfish binary for Android ARM64 (aarch64).

## How to get the binary

1. Download the Stockfish 18 release from:
   https://github.com/official-stockfish/Stockfish/releases/tag/sf_18

2. Download the file: `stockfish-android-armv8.tar` (or `stockfish-android-armv8-dotprod.tar` for devices with dotprod support)

3. Extract the tar file:
   ```bash
   tar -xf stockfish-android-armv8.tar
   ```

4. Find the Stockfish binary in the extracted directory (for example `stockfish-android-armv8`)

5. Copy it to this directory and rename it to `stockfish`:
   ```bash
   cp <extracted_path>/stockfish-android-armv8 ./stockfish
   ```

6. Make sure the file is executable:
   ```bash
   chmod +x stockfish
   ```

## File structure

After setup, this directory should contain:
```
src-tauri/assets/engines/android/aarch64/
  - stockfish  (executable binary)
```

The build process will automatically copy this file to `gen/android/app/src/main/assets/engines/stockfish` during the Android build.
