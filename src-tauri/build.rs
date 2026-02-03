fn main() {
    // Ensure rebuilds pick up icon/config changes (especially on Windows where the icon is embedded in the executable).
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    
    // Copy bundled engines to Android assets during build
    // Note: This runs during Rust build, but the actual Android build happens later.
    // The files need to be in gen/android/app/src/main/assets/engines/ before Gradle builds the APK.
    // Only attempt this if we're building for Android target
    if std::env::var("TARGET").map(|t| t.contains("android")).unwrap_or(false) {
        let android_assets_dir = std::path::PathBuf::from("gen/android/app/src/main/assets/engines");
        let source_dir = std::path::PathBuf::from("assets/engines/android/aarch64");
        let android_jni_libs_dir =
            std::path::PathBuf::from("gen/android/app/src/main/jniLibs/arm64-v8a");

        println!("cargo:warning=Checking for bundled engines in: {}", source_dir.display());
        
        if source_dir.exists() {
            println!("cargo:warning=Source directory exists: {}", source_dir.display());
            if let Err(e) = std::fs::create_dir_all(&android_assets_dir) {
                eprintln!("cargo:warning=Failed to create Android assets directory: {} (this is OK if gen/ doesn't exist yet)", e);
            } else {
                println!("cargo:warning=Android assets directory ready: {}", android_assets_dir.display());
                if let Ok(entries) = std::fs::read_dir(&source_dir) {
                    let mut copied_count = 0;
                    for entry in entries.flatten() {
                        if entry.path().is_file() {
                            let dest = android_assets_dir.join(entry.file_name());
                            if let Err(e) = std::fs::copy(entry.path(), &dest) {
                                eprintln!("cargo:warning=Failed to copy engine {}: {} (this is OK if gen/ doesn't exist yet)", entry.path().display(), e);
                            } else {
                                println!("cargo:warning=Copied bundled engine: {} -> {}", entry.path().display(), dest.display());
                                copied_count += 1;
                            }
                        }
                    }
                    if copied_count == 0 {
                        eprintln!("cargo:warning=No engine files found in {}", source_dir.display());
                    }
                } else {
                    eprintln!("cargo:warning=Failed to read source directory: {}", source_dir.display());
                }
            }

            // Also copy Stockfish into jniLibs so it ends up under nativeLibraryDir on device.
            // Some devices block executing files from app data even with chmod; nativeLibraryDir is executable.
            let stockfish_src = source_dir.join("stockfish");
            if stockfish_src.is_file() {
                if let Err(e) = std::fs::create_dir_all(&android_jni_libs_dir) {
                    eprintln!(
                        "cargo:warning=Failed to create Android jniLibs directory: {} (this is OK if gen/ doesn't exist yet)",
                        e
                    );
                } else {
                    let stockfish_dst = android_jni_libs_dir.join("libstockfish.so");
                    match std::fs::copy(&stockfish_src, &stockfish_dst) {
                        Ok(_) => println!(
                            "cargo:warning=Copied bundled Stockfish into jniLibs: {} -> {}",
                            stockfish_src.display(),
                            stockfish_dst.display()
                        ),
                        Err(e) => eprintln!(
                            "cargo:warning=Failed to copy Stockfish into jniLibs: {}",
                            e
                        ),
                    }
                }
            } else {
                eprintln!(
                    "cargo:warning=Bundled Stockfish binary not found at: {}",
                    stockfish_src.display()
                );
            }
        } else {
            eprintln!("cargo:warning=Bundled engines source directory does not exist: {}", source_dir.display());
            eprintln!("cargo:warning=Please ensure stockfish binary is placed at: {}", source_dir.display());
        }
    }
    
    tauri_build::build()
}
