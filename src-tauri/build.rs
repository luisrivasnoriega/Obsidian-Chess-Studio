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

        // Android Stockfish 18: keep the official release tarballs in the repo root,
        // and extract on build so we don't have to commit large binaries under `src-tauri/assets`.
        //
        // Expected files (repo root):
        // - stockfish-android-armv8.tar
        // - stockfish-android-armv8-dotprod.tar
        let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        let repo_root = manifest_dir.parent().map(|p| p.to_path_buf()).unwrap_or(manifest_dir.clone());
        let sf_armv8_tar = repo_root.join("stockfish-android-armv8.tar");
        let sf_armv8_dotprod_tar = repo_root.join("stockfish-android-armv8-dotprod.tar");

        println!("cargo:rerun-if-changed={}", sf_armv8_tar.display());
        println!("cargo:rerun-if-changed={}", sf_armv8_dotprod_tar.display());

        fn extract_tar_to_dir(tar_path: &std::path::Path, out_dir: &std::path::Path) -> std::io::Result<()> {
            std::fs::create_dir_all(out_dir)?;

            // Use system `tar` (available on modern Windows, macOS, and Linux).
            // If tar is missing, we warn and keep going; the build will fall back to any
            // pre-existing `assets/engines/android/aarch64/stockfish` file if present.
            let status = std::process::Command::new("tar")
                .arg("-xf")
                .arg(tar_path)
                .arg("-C")
                .arg(out_dir)
                .status();

            match status {
                Ok(s) if s.success() => Ok(()),
                Ok(s) => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("tar exited with status {s}"),
                )),
                Err(e) => Err(e),
            }
        }

        fn find_stockfish_binary(root: &std::path::Path) -> Option<std::path::PathBuf> {
            fn walk(dir: &std::path::Path) -> Option<std::path::PathBuf> {
                let entries = std::fs::read_dir(dir).ok()?;
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        if let Some(found) = walk(&p) {
                            return Some(found);
                        }
                        continue;
                    }
                    if p.is_file() {
                        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                            if name == "stockfish" {
                                return Some(p);
                            }
                        }
                    }
                }
                None
            }
            walk(root)
        }

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
                            // The Stockfish binary is sourced from the official tarballs (see below),
                            // so don't copy a stale `assets/.../stockfish` file if one exists.
                            let name = entry.file_name();
                            let name = name.to_string_lossy();
                            if name == "stockfish" || name == "stockfish-dotprod" {
                                continue;
                            }
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

            // Stockfish (Android): extract from official tarballs and copy into:
            // - assets/engines/stockfish (fallback executable extracted to filesDir)
            // - jniLibs/.../libstockfish*.so (preferred executable from nativeLibraryDir)
            //
            // We include BOTH baseline + dotprod builds. Runtime selection happens in Rust based on CPU features.
            let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap_or_else(|_| ".".to_string()));
            let sf_extract_base = out_dir.join("stockfish_android_armv8");
            let sf_extract_dotprod = out_dir.join("stockfish_android_armv8_dotprod");

            let mut extracted_any = false;
            let mut sf_armv8_bin: Option<std::path::PathBuf> = None;
            let mut sf_dotprod_bin: Option<std::path::PathBuf> = None;

            if sf_armv8_tar.is_file() {
                match extract_tar_to_dir(&sf_armv8_tar, &sf_extract_base) {
                    Ok(()) => {
                        sf_armv8_bin = find_stockfish_binary(&sf_extract_base);
                        extracted_any = true;
                    }
                    Err(e) => {
                        eprintln!("cargo:warning=Failed to extract {}: {e}", sf_armv8_tar.display());
                    }
                }
            } else {
                eprintln!("cargo:warning=Missing {}", sf_armv8_tar.display());
            }

            if sf_armv8_dotprod_tar.is_file() {
                match extract_tar_to_dir(&sf_armv8_dotprod_tar, &sf_extract_dotprod) {
                    Ok(()) => {
                        sf_dotprod_bin = find_stockfish_binary(&sf_extract_dotprod);
                        extracted_any = true;
                    }
                    Err(e) => {
                        eprintln!(
                            "cargo:warning=Failed to extract {}: {e}",
                            sf_armv8_dotprod_tar.display()
                        );
                    }
                }
            } else {
                eprintln!("cargo:warning=Missing {}", sf_armv8_dotprod_tar.display());
            }

            if extracted_any {
                // Ensure output dirs exist (best-effort: gen/ may not exist yet).
                let _ = std::fs::create_dir_all(&android_assets_dir);
                let _ = std::fs::create_dir_all(&android_jni_libs_dir);

                if let Some(src) = sf_armv8_bin {
                    let assets_dst = android_assets_dir.join("stockfish");
                    let jni_dst = android_jni_libs_dir.join("libstockfish.so");
                    if let Err(e) = std::fs::copy(&src, &assets_dst) {
                        eprintln!("cargo:warning=Failed to copy Stockfish (armv8) to assets: {e}");
                    } else {
                        println!(
                            "cargo:warning=Bundled Stockfish (armv8) to assets: {} -> {}",
                            src.display(),
                            assets_dst.display()
                        );
                    }
                    if let Err(e) = std::fs::copy(&src, &jni_dst) {
                        eprintln!("cargo:warning=Failed to copy Stockfish (armv8) to jniLibs: {e}");
                    } else {
                        println!(
                            "cargo:warning=Bundled Stockfish (armv8) to jniLibs: {} -> {}",
                            src.display(),
                            jni_dst.display()
                        );
                    }
                } else {
                    eprintln!("cargo:warning=Could not locate `stockfish` inside {}", sf_armv8_tar.display());
                }

                if let Some(src) = sf_dotprod_bin {
                    let assets_dst = android_assets_dir.join("stockfish-dotprod");
                    let jni_dst = android_jni_libs_dir.join("libstockfish_dotprod.so");
                    if let Err(e) = std::fs::copy(&src, &assets_dst) {
                        eprintln!("cargo:warning=Failed to copy Stockfish (dotprod) to assets: {e}");
                    } else {
                        println!(
                            "cargo:warning=Bundled Stockfish (dotprod) to assets: {} -> {}",
                            src.display(),
                            assets_dst.display()
                        );
                    }
                    if let Err(e) = std::fs::copy(&src, &jni_dst) {
                        eprintln!("cargo:warning=Failed to copy Stockfish (dotprod) to jniLibs: {e}");
                    } else {
                        println!(
                            "cargo:warning=Bundled Stockfish (dotprod) to jniLibs: {} -> {}",
                            src.display(),
                            jni_dst.display()
                        );
                    }
                } else {
                    eprintln!(
                        "cargo:warning=Could not locate `stockfish` inside {}",
                        sf_armv8_dotprod_tar.display()
                    );
                }
            } else {
                // Old behavior fallback: copy the pre-extracted file from assets if present.
                // Some CI setups may not have the tarballs available.
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
                            Err(e) => eprintln!("cargo:warning=Failed to copy Stockfish into jniLibs: {}", e),
                        }
                    }
                } else {
                    eprintln!(
                        "cargo:warning=Bundled Stockfish binary not found at: {}",
                        stockfish_src.display()
                    );
                }
            }
        } else {
            eprintln!("cargo:warning=Bundled engines source directory does not exist: {}", source_dir.display());
            eprintln!("cargo:warning=Please ensure stockfish binary is placed at: {}", source_dir.display());
        }
    }
    
    tauri_build::build()
}
