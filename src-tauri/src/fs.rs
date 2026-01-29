use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;

use log::{info, warn};
use reqwest::{Client, Url};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;
use tokio::io::AsyncWriteExt;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use futures_util::StreamExt;

use crate::error::Error;

const MAX_DOWNLOAD_SIZE: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Clone, Type, serde::Serialize, Event)]
pub struct DownloadProgress {
    pub progress: f32,
    pub id: String,
    pub finished: bool,
}

fn total_size_f64_to_u64(total_size: Option<f64>) -> Option<u64> {
    total_size.and_then(|size| {
        if size.is_finite() && size >= 0.0 && size <= u64::MAX as f64 {
            Some(size as u64)
        } else {
            None
        }
    })
}

fn is_archive_url(url: &str) -> bool {
    url.ends_with(".zip") || url.ends_with(".tar") || url.ends_with(".tar.gz")
}

fn parse_and_validate_url(url: &str) -> Result<Url, Error> {
    let parsed_url =
        Url::parse(url).map_err(|e| Error::PackageManager(format!("Invalid URL: {}", e)))?;

    if parsed_url.scheme() != "https" && parsed_url.scheme() != "http" {
        return Err(Error::PackageManager(format!(
            "Only HTTP/HTTPS allowed, got: {}",
            parsed_url.scheme()
        )));
    }

    if let Some(host) = parsed_url.host_str() {
        if is_private_or_localhost(host) {
            return Err(Error::PackageManager(format!(
                "Cannot access private/local addresses: {}",
                host
            )));
        }
    }

    Ok(parsed_url)
}

fn emit_progress(app: &tauri::AppHandle, id: &str, progress: f32, finished: bool) -> Result<(), Error> {
    DownloadProgress {
        progress,
        id: id.to_string(),
        finished,
    }
    .emit(app)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn download_file(
    id: String,
    url: String,
    path: PathBuf,
    app: tauri::AppHandle,
    token: Option<String>,
    finalize: Option<bool>,
    total_size: Option<f64>,
) -> Result<(), Error> {
    let finalize = finalize.unwrap_or(true);

    // Convert f64 to u64 if total_size is provided
    let total_size_u64 = total_size_f64_to_u64(total_size);

    // Validate URL early
    let _parsed = parse_and_validate_url(&url)?;

    info!("Downloading file from {} to {}", url, path.display());

    validate_destination_path(&app, &path)?;

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10)) // Follow up to 10 redirects
        .build()?;

    let mut req = client.get(&url);

    // Add User-Agent to mimic a browser
    req = req.header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // Add Accept header for better compatibility
    req = req.header("Accept", "*/*");

    if let Some(ref token_val) = token {
        req = req.header("Authorization", format!("Bearer {}", token_val));
    }

    let res = req.send().await?;

    if !res.status().is_success() {
        let status = res.status();
        let error_msg = if status == 403 {
            format!("Download failed: Access denied (403). The server refused to authorize the request. URL: {}", url)
        } else if status == 404 {
            format!("Download failed: File not found (404). The file may have been moved or deleted. URL: {}", url)
        } else {
            format!("Download failed: {}. URL: {}", status, url)
        };

        return Err(Error::PackageManager(error_msg));
    }

    let content_length = total_size_u64.or_else(|| res.content_length());

    if let Some(size) = content_length {
        if size > MAX_DOWNLOAD_SIZE {
            return Err(Error::PackageManager(format!(
                "File too large: {} bytes (max {})",
                size, MAX_DOWNLOAD_SIZE
            )));
        }
    }

    if is_archive_url(&url) {
        download_and_extract(res, content_length, &path, &url, &id, &app, finalize).await?;
    } else {
        download_to_file(res, content_length, &path, &id, &app, finalize).await?;
    }

    Ok(())
}

fn sanitize_engine_filename(name: &str) -> String {
    // Keep it simple and predictable across platforms.
    // Windows forbids: < > : " / \ | ? * and control chars. We also guard against path separators.
    let trimmed = name.trim();
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        let is_invalid = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || ch.is_control();
        if is_invalid {
            out.push('_');
        } else {
            out.push(ch);
        }
    }

    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() {
        "engine".to_string()
    } else {
        out
    }
}

/// Download and install an engine into AppData/engines.
///
/// - Emits progress via `download-progress` under id `engine_{engine_id}`.
/// - For archives (.zip/.tar/.tar.gz), extracts into the engines dir.
/// - For direct binaries, downloads to a `.partial` file and renames on success.
/// - Returns the absolute path to the installed engine binary.
#[tauri::command]
#[specta::specta]
pub async fn download_engine(
    engine_id: i32,
    url: String,
    engine_rel_path: String,
    app: tauri::AppHandle,
) -> Result<String, Error> {
    use tauri::path::BaseDirectory;

    // Keep a copy for post-install tasks; `url` is moved into the download call below.
    let url_for_post_install = url.clone();
    let engine_rel_path_for_post_install = engine_rel_path.clone();

    let engines_dir = app
        .path()
        .resolve("engines", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve engines dir: {e}")))?;

    // Ensure directory exists.
    if let Some(parent) = engines_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(&engines_dir)?;

    let download_id = format!("engine_{}", engine_id);

    if is_archive_url(&url) {
        // Most engine archives include a root folder, and `engine_rel_path` points inside it.
        // Lc0's Windows archives currently extract files directly at the archive root (lc0.exe + DLLs),
        // so we extract them into a dedicated `engines/lc0/` folder to keep the engines dir tidy.
        let extract_dir = if looks_like_lc0(&engine_rel_path, &url) {
            let lc0_dir = engines_dir.join("lc0");
            std::fs::create_dir_all(&lc0_dir)?;
            #[cfg(target_os = "windows")]
            {
                let _ = migrate_lc0_root_files_to_subdir(&engines_dir, &lc0_dir);
            }
            lc0_dir
        } else {
            engines_dir.clone()
        };

        download_file(download_id, url, extract_dir, app.clone(), None, None, None).await?;
    } else {
        // Download file into engines_dir/<filename>.partial then rename.
        let file_name = url
            .split('/')
            .last()
            .map(sanitize_engine_filename)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "engine.bin".to_string());

        let final_path = engines_dir.join(&file_name);
        let tmp_path = engines_dir.join(format!("{file_name}.partial"));

        // Best-effort cleanup from previous interrupted attempts.
        let _ = std::fs::remove_file(&tmp_path);

        let download_res = download_file(
            download_id,
            url,
            tmp_path.clone(),
            app.clone(),
            None,
            None,
            None,
        )
        .await;

        if let Err(e) = download_res {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }

        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&tmp_path, &final_path)?;
    }

    // Resolve engine path from engines_dir + engine_rel_path (which uses "/" separators).
    let mut engine_path = engines_dir.clone();
    let rel = engine_rel_path.trim().trim_matches('/');
    if !rel.is_empty() {
        for part in rel.split('/') {
            if part.is_empty() {
                continue;
            }
            engine_path = engine_path.join(part);
        }
    } else {
        return Err(Error::InvalidInput(
            "engine_rel_path cannot be empty".to_string(),
        ));
    }

    if !engine_path.exists() {
        return Err(Error::PackageManager(format!(
            "Engine binary not found after download: {}",
            engine_path.display()
        )));
    }

    if engine_path.is_dir() {
        return Err(Error::PackageManager(format!(
            "Engine path points to a directory: {}",
            engine_path.display()
        )));
    }

    // Set executable on Unix (no-op on Windows).
    set_file_as_executable(engine_path.to_string_lossy().to_string()).await?;

    // After Lc0 is installed on Windows, automatically download recommended networks.
    // This runs in the background and does not block returning the engine path.
    maybe_spawn_lc0_network_downloads(app.clone(), &url_for_post_install, &engine_rel_path_for_post_install);

    Ok(engine_path.to_string_lossy().to_string())
}

fn maybe_spawn_lc0_network_downloads(app: tauri::AppHandle, url: &str, engine_rel_path: &str) {
    #[cfg(target_os = "windows")]
    {
        if !looks_like_lc0(engine_rel_path, url) {
            return;
        }

        tauri::async_runtime::spawn(async move {
            if let Err(e) = download_lc0_networks(app).await {
                warn!("Failed to download Lc0 networks: {}", e);
            }
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, url, engine_rel_path);
    }
}

fn looks_like_lc0(engine_rel_path: &str, url: &str) -> bool {
    let rel = engine_rel_path.to_ascii_lowercase();
    let u = url.to_ascii_lowercase();

    // Typical desktop installs: .../lc0.exe (from zip) and URLs containing lc0-v...
    rel.ends_with("lc0.exe") || rel.contains("/lc0") || u.contains("/lc0-") || u.contains("leelachesszero")
}

#[cfg(target_os = "windows")]
fn migrate_lc0_root_files_to_subdir(engines_dir: &Path, lc0_dir: &Path) -> Result<(), Error> {
    // Best-effort cleanup for older installs where Lc0 extracted into the engines root.
    // Only move files that are strongly associated with Lc0 bundles.
    let entries = std::fs::read_dir(engines_dir)?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(name_os) = path.file_name() else { continue };
        let name = name_os.to_string_lossy();
        let name_lc = name.to_ascii_lowercase();

        if name_lc == "engines.json" {
            continue;
        }

        let is_lc0_related =
            name_lc == "lc0.exe"
                || name_lc == "lc0-training-client.exe"
                || name_lc == "copying"
                || name_lc == "readme.txt"
                || name_lc == "cuda.txt"
                || name_lc.ends_with(".pb.gz")
                || name_lc.starts_with("cublas")
                || name_lc.starts_with("cudart")
                || name_lc.starts_with("cudnn")
                || name_lc.starts_with("onnxruntime")
                || name_lc.starts_with("mimalloc-");

        if !is_lc0_related {
            continue;
        }

        let dest = lc0_dir.join(name_os);
        if dest.exists() {
            continue;
        }

        let _ = std::fs::rename(&path, &dest);
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn download_lc0_networks(app: tauri::AppHandle) -> Result<(), Error> {
    use tauri::path::BaseDirectory;

    let networks_dir = app
        .path()
        .resolve("engines/lc0/networks", BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve Lc0 networks dir: {e}")))?;

    std::fs::create_dir_all(&networks_dir)?;

    let gpu_large = has_large_gpu_vram().unwrap_or(false);

    // Download order: one "big" net (if applicable) then Maia nets.
    let mut urls: Vec<&str> = Vec::new();
    if gpu_large {
        urls.push("https://storage.lczero.org/files/networks-contrib/BT4-1024x15x32h-swa-6147500-policytune-332.pb.gz");
    }

    urls.extend([
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1100.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1200.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1300.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1400.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1500.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1600.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1700.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1800.pb.gz",
        "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1900.pb.gz",
        "https://github.com/CallOn84/LeelaNets/raw/refs/heads/main/Nets/Maia%202200/maia-2200.pb.gz",
    ]);

    for url in urls {
        let file_name = url.split('/').last().unwrap_or("network.pb.gz");
        let dest = networks_dir.join(file_name);

        if dest.exists() {
            continue;
        }

        let id = format!("lc0_network_{}", file_name.replace(' ', "_"));

        // Best-effort: if one network fails, continue with the rest.
        if let Err(e) = download_file(id, url.to_string(), dest, app.clone(), None, None, None).await {
            warn!("Lc0 network download failed ({url}): {e}");
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn has_large_gpu_vram() -> Option<bool> {
    // "Large" == at least 4GB of dedicated VRAM, per request.
    let threshold: u64 = 4 * 1024 * 1024 * 1024;
    let max = get_max_adapter_ram_bytes()?;
    Some(max >= threshold)
}

#[cfg(target_os = "windows")]
fn get_max_adapter_ram_bytes() -> Option<u64> {
    // Prefer CIM via PowerShell. `AdapterRAM` is in bytes.
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM",
        ])
        .output()
        .ok()?;

    let mut max: u64 = 0;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(v) = line.trim().parse::<u64>() {
                max = max.max(v);
            }
        }
        if max > 0 {
            return Some(max);
        }
    }

    // Fallback: `wmic` is deprecated but still present on many systems.
    let output = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "AdapterRAM"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let t = line.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("AdapterRAM") {
            continue;
        }
        if let Ok(v) = t.parse::<u64>() {
            max = max.max(v);
        }
    }

    if max > 0 { Some(max) } else { None }
}

async fn download_to_file(
    res: reqwest::Response,
    content_length: Option<u64>,
    path: &Path,
    id: &str,
    app: &tauri::AppHandle,
    finalize: bool,
) -> Result<(), Error> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut file = tokio::fs::File::create(path).await?;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item?;

        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_DOWNLOAD_SIZE {
            return Err(Error::PackageManager("Download size limit exceeded".to_string()));
        }

        file.write_all(&chunk).await?;

        let progress = content_length
            .map(|total| ((downloaded as f64 / total as f64) * 100.0).min(100.0) as f32)
            .unwrap_or(-1.0);

        emit_progress(app, id, progress, false)?;
    }

    file.sync_all().await?;

    info!("Downloaded file to {}", path.display());

    if finalize {
        emit_progress(app, id, 100.0, true)?;
    }

    Ok(())
}

async fn download_and_extract(
    res: reqwest::Response,
    content_length: Option<u64>,
    path: &Path,
    url: &str,
    id: &str,
    app: &tauri::AppHandle,
    finalize: bool,
) -> Result<(), Error> {
    // Production-grade: never load the full archive into RAM.
    // Stream into a temp file, then extract on a blocking thread.
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    let (tmp_file, tmp_path) = tokio::task::spawn_blocking(|| {
        let tmp = tempfile::NamedTempFile::new()?;
        let (file, path) = tmp.keep().map_err(|e| e.error)?;
        Ok::<_, std::io::Error>((file, path))
    })
    .await
    .map_err(|e| Error::PackageManager(format!("Failed to create temp file: {}", e)))??;

    let mut tmp_file = tokio::fs::File::from_std(tmp_file);

    while let Some(item) = stream.next().await {
        let chunk = item?;

        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_DOWNLOAD_SIZE {
            return Err(Error::PackageManager("Download size limit exceeded".to_string()));
        }

        tmp_file.write_all(&chunk).await?;

        // UI behavior:
        // - Use 0..99 for download
        // - Switch to 100 (finished=false) for extraction so the UI can show `finalizing` label
        let progress = content_length
            .map(|total| ((downloaded as f64 / total as f64) * 99.0).min(99.0) as f32)
            .unwrap_or(-1.0);

        emit_progress(app, id, progress, false)?;
    }

    info!(
        "Downloaded {} bytes, starting extraction to {}",
        downloaded,
        path.display()
    );

    // Extraction phase: keep progress at 100 but `finished=false` so the UI shows the `finalizing` label.
    emit_progress(app, id, 100.0, false)?;

    tmp_file.sync_all().await?;
    drop(tmp_file);

    let dest = path.to_path_buf();
    let tmp_path_clone = tmp_path.clone();
    let url = url.to_string();

    tokio::task::spawn_blocking(move || -> Result<(), Error> {
        if url.ends_with(".zip") {
            unzip_file_from_path(&dest, &tmp_path_clone)?;
        } else if url.ends_with(".tar") || url.ends_with(".tar.gz") {
            extract_tar_file_from_path(&dest, &tmp_path_clone, url.ends_with(".tar.gz"))?;
        } else {
            std::fs::create_dir_all(dest.parent().unwrap_or(Path::new(".")))?;
            std::fs::copy(&tmp_path_clone, &dest)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| Error::PackageManager(format!("Extraction task failed: {}", e)))??;

    let _ = std::fs::remove_file(&tmp_path);

    info!("Extraction complete");

    if finalize {
        emit_progress(app, id, 100.0, true)?;
    }

    Ok(())
}

fn validate_destination_path(app: &tauri::AppHandle, path: &Path) -> Result<(), Error> {
    let allowed_roots = [
        app.path().app_data_dir(),
        app.path().app_cache_dir(),
        app.path().config_dir(),
    ];
    validate_destination_path_with_roots(path, &allowed_roots.into_iter().flatten().collect::<Vec<_>>())
}

fn validate_destination_path_with_roots(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), Error> {
    if !path.is_absolute() {
        return Err(Error::PackageManager(
            "Destination path must be absolute".to_string(),
        ));
    }

    // Reject any parent-dir traversal segments outright.
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::PackageManager(
            "Destination path contains '..'".to_string(),
        ));
    }

    // Only allow writes under app-specific directories.
    let allowed = allowed_roots.iter().any(|root| path.starts_with(root));
    if !allowed {
        return Err(Error::PackageManager(
            "Destination must be inside the app data/cache/config directories".to_string(),
        ));
    }

    Ok(())
}

fn is_private_or_localhost(host: &str) -> bool {
    use std::net::IpAddr;

    // `Url::host_str()` should return un-bracketed IPv6, but be defensive.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host_lc = host.to_ascii_lowercase();

    if host_lc == "localhost" || host == "::1" {
        return true;
    }

    // Try parsing as IP address
    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ipv4) => {
                let octets = ipv4.octets();
                // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 0.0.0.0/8
                octets[0] == 127
                    || octets[0] == 10
                    || octets[0] == 0
                    || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                    || (octets[0] == 192 && octets[1] == 168)
            }
            IpAddr::V6(ipv6) => ipv6.is_loopback() || ipv6.is_unspecified(),
        }
    } else {
        false
    }
}

fn unzip_file_from_path(dest_dir: &Path, archive_path: &Path) -> Result<(), Error> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    std::fs::create_dir_all(dest_dir)?;
    let base_path = dest_dir.canonicalize()?;
    let archive_len = archive.len();

    for i in 0..archive_len {
        let mut file = archive.by_index(i)?;
        let file_path = file.enclosed_name().ok_or_else(|| {
            Error::PackageManager(format!(
                "Invalid file path in archive at index {}: {:?}",
                i,
                file.name()
            ))
        })?;

        let outpath = base_path.join(file_path);
        if !outpath.starts_with(&base_path) {
            warn!(
                "Skipping potentially malicious file path: {:?}",
                file.name()
            );
            continue;
        }

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
            outfile.sync_all()?;

            #[cfg(unix)]
            {
                if let Some(mode) = file.unix_mode() {
                    use std::fs::Permissions;
                    std::fs::set_permissions(&outpath, Permissions::from_mode(mode))?;
                }
            }
        }
    }

    Ok(())
}

fn extract_tar_file_from_path(dest_dir: &Path, archive_path: &Path, is_gz: bool) -> Result<(), Error> {
    use flate2::read::GzDecoder;
    use std::io::{BufRead, BufReader, Read};

    fn ensure_dir_path(path: &Path) -> Result<(), Error> {
        // `create_dir_all` fails with EEXIST if any component is a file.
        // Remove conflicting files component-by-component, then create the directory.
        let mut cur = PathBuf::new();
        for comp in path.components() {
            cur.push(comp);
            if cur.exists() && cur.is_file() {
                let _ = std::fs::remove_file(&cur);
            }
        }
        std::fs::create_dir_all(path)?;
        Ok(())
    }

    std::fs::create_dir_all(dest_dir)?;
    let base_path = dest_dir.canonicalize()?;

    let file = std::fs::File::open(archive_path)?;
    let mut buf_reader = BufReader::new(file);
    let magic = buf_reader.fill_buf().unwrap_or(&[]);
    let looks_like_gz = magic.len() >= 2 && magic[0] == 0x1f && magic[1] == 0x8b;
    let reader: Box<dyn Read> = if is_gz || looks_like_gz {
        Box::new(GzDecoder::new(buf_reader))
    } else {
        Box::new(buf_reader)
    };

    let mut archive = tar::Archive::new(reader);
    archive.set_overwrite(true);
    archive.set_preserve_permissions(true);

    // Extract safely, handling Android edge cases where a previous install left
    // conflicting file/dir types (e.g. a file at `engines/stockfish` but the tar wants `stockfish/`).
    for (i, entry) in archive.entries()?.enumerate() {
        let mut entry = entry?;
        let entry_type = entry.header().entry_type();
        // Some archives can contain symlinks/hardlinks; these can fail on certain Android setups.
        // Skip them and rely on the real binary entry.
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            warn!("Skipping tar link entry at index {} during extraction", i);
            continue;
        }

        let rel = entry.path().map_err(|e| {
            Error::PackageManager(format!(
                "Failed to read tar entry path at index {}: {}",
                i, e
            ))
        })?;

        // Reject traversal / absolute paths.
        if rel.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            warn!(
                "Skipping potentially malicious tar entry path at index {}: {:?}",
                i, rel
            );
            continue;
        }

        let outpath = base_path.join(&rel);

        // Handle file/dir conflicts before unpacking.
        if entry_type.is_dir() {
            if outpath.exists() && outpath.is_file() {
                let _ = std::fs::remove_file(&outpath);
            }
            ensure_dir_path(&outpath).map_err(|e| {
                Error::PackageManager(format!(
                    "Failed to create directory for tar entry {:?} at index {} into {}: {}",
                    rel,
                    i,
                    base_path.display(),
                    e
                ))
            })?;
            continue;
        } else {
            if outpath.exists() && outpath.is_dir() {
                let _ = std::fs::remove_dir_all(&outpath);
            }
            if outpath.exists() && outpath.is_file() {
                let _ = std::fs::remove_file(&outpath);
            }
            if let Some(parent) = outpath.parent() {
                if parent.exists() && parent.is_file() {
                    let _ = std::fs::remove_file(parent);
                }
                ensure_dir_path(parent)?;
            }
        }

        entry.unpack(&outpath).map_err(|e| {
            let entry_path = entry
                .path()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "<unknown>".to_string());
            Error::PackageManager(format!(
                "Failed to unpack tar entry {} at index {} into {}: {}",
                entry_path,
                i,
                base_path.display(),
                e
            ))
        })?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_file_as_executable(path: String) -> Result<(), Error> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(Error::PackageManager(format!(
            "File does not exist: {}",
            path.display()
        )));
    }

    if !path.is_file() {
        return Err(Error::PackageManager(format!(
            "Not a file: {}",
            path.display()
        )));
    }

    #[cfg(unix)]
    {
        // Ensure the engine directory chain is traversable/executable.
        //
        // On Android/Linux, execution can fail with `Permission denied` even if the binary is +x,
        // when *any* parent directory lacks the execute bit.
        //
        // We chmod the binary's parent chain up to a safe boundary:
        // - On Android: stop once we hit the `.../files` directory (app-owned boundary)
        // - Elsewhere: chmod only the immediate parent (conservative)
        fn chmod_dir_755(dir: &Path) -> Result<(), Error> {
            if !dir.exists() || !dir.is_dir() {
                return Ok(());
            }
            let meta = std::fs::metadata(dir)?;
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(dir, perms)?;
            Ok(())
        }

        #[cfg(target_os = "android")]
        {
            let mut cur = path.parent();
            while let Some(dir) = cur {
                chmod_dir_755(dir)?;
                if dir.file_name().and_then(|n| n.to_str()) == Some("files") {
                    break;
                }
                cur = dir.parent();
            }
        }

        #[cfg(not(target_os = "android"))]
        {
            if let Some(parent) = path.parent() {
                chmod_dir_755(parent)?;
            }
        }

        let metadata = std::fs::metadata(path)?;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
        info!("Set file as executable: {}", path.display());
    }

    #[cfg(not(unix))]
    {
        warn!("set_file_as_executable called on Windows for: {}", path.display());
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn file_exists(path: String) -> Result<bool, Error> {
    Ok(Path::new(&path).exists())
}

#[derive(Debug, Type, serde::Serialize)]
pub struct FileMetadata {
    pub last_modified: u64,
    pub size: u64,
    pub is_dir: bool,
    pub is_readonly: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn get_file_metadata(path: String) -> Result<FileMetadata, Error> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(Error::PackageManager(format!(
            "File does not exist: {}",
            path.display()
        )));
    }

    let metadata = std::fs::metadata(path)?;
    let last_modified = metadata
        .modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?;

    Ok(FileMetadata {
        last_modified: last_modified.as_secs(),
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_readonly: metadata.permissions().readonly(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn save_welcome_card_image(
    source_path: String,
    app: tauri::AppHandle,
) -> Result<String, Error> {
    use std::fs;
    use tauri::path::BaseDirectory;

    let source = Path::new(&source_path);
    if !source.exists() {
        return Err(Error::PackageManager(format!(
            "Source file does not exist: {}",
            source.display()
        )));
    }

    // Get the file extension
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png");

    // Create destination path in AppData/welcome-card-image/
    let dest_dir = app
        .path()
        .resolve("welcome-card-image", BaseDirectory::AppData)
        .map_err(|e| {
            Error::PackageManager(format!("Failed to resolve app data directory: {}", e))
        })?;

    // Ensure directory exists
    fs::create_dir_all(&dest_dir).map_err(|e| {
        Error::PackageManager(format!("Failed to create directory: {}", e))
    })?;

    // Use a fixed filename: custom-image.{ext}
    let dest_path = dest_dir.join(format!("custom-image.{}", extension));

    // Copy the file
    fs::copy(source, &dest_path).map_err(|e| {
        Error::PackageManager(format!("Failed to copy file: {}", e))
    })?;

    // Return the relative path that can be used with BaseDirectory::AppData
    Ok(format!("welcome-card-image/custom-image.{}", extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ocs_test_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cleanup_dir(p: &Path) {
        let _ = std::fs::remove_dir_all(p);
    }

    #[test]
    fn total_size_f64_to_u64_converts_and_filters() {
        assert_eq!(total_size_f64_to_u64(Some(0.0)), Some(0));
        assert_eq!(total_size_f64_to_u64(Some(123.9)), Some(123));
        assert_eq!(total_size_f64_to_u64(Some(-1.0)), None);
        assert_eq!(total_size_f64_to_u64(Some(f64::NAN)), None);
        assert_eq!(total_size_f64_to_u64(Some(f64::INFINITY)), None);
    }

    #[test]
    fn is_archive_url_detects_extensions() {
        assert!(is_archive_url("https://x/y.zip"));
        assert!(is_archive_url("https://x/y.tar"));
        assert!(is_archive_url("https://x/y.tar.gz"));
        assert!(!is_archive_url("https://x/y.bin"));
    }

    #[test]
    fn parse_and_validate_url_rejects_non_http() {
        let err = parse_and_validate_url("file:///tmp/a").unwrap_err();
        match err {
            Error::PackageManager(msg) => assert!(msg.contains("Only HTTP/HTTPS allowed")),
            other => panic!("expected PackageManager, got {:?}", other),
        }
    }

    #[test]
    fn parse_and_validate_url_rejects_private_hosts() {
        for u in [
            "http://127.0.0.1/test",
            "http://localhost/test",
            "http://10.0.0.1/test",
            "http://192.168.1.1/test",
            "http://172.16.0.1/test",
            "http://0.0.0.0/test",
            "http://[::1]/test",
        ] {
            let err = parse_and_validate_url(u).unwrap_err();
            match err {
                Error::PackageManager(msg) => assert!(msg.contains("Cannot access private/local")),
                other => panic!("expected PackageManager, got {:?} for {}", other, u),
            }
        }
    }

    #[test]
    fn is_private_or_localhost_works_for_common_cases() {
        assert!(is_private_or_localhost("localhost"));
        assert!(is_private_or_localhost("::1"));
        assert!(is_private_or_localhost("127.0.0.1"));
        assert!(is_private_or_localhost("10.1.2.3"));
        assert!(is_private_or_localhost("192.168.0.10"));
        assert!(is_private_or_localhost("172.16.0.1"));
        assert!(is_private_or_localhost("172.31.255.255"));
        assert!(is_private_or_localhost("0.0.0.0"));

        assert!(!is_private_or_localhost("172.32.0.1"));
        assert!(!is_private_or_localhost("8.8.8.8"));
        assert!(!is_private_or_localhost("example.com"));
    }

    #[test]
    fn validate_destination_path_with_roots_rules() {
        let root = tmp_dir("validate_destination_path_with_roots_rules");
        let allowed = vec![root.clone()];

        // must be absolute
        let err = validate_destination_path_with_roots(Path::new("relative/path"), &allowed).unwrap_err();
        match err {
            Error::PackageManager(msg) => assert!(msg.contains("must be absolute")),
            other => panic!("expected PackageManager, got {:?}", other),
        }

        // reject ..
        let bad = root.join("a").join("..").join("b");
        let err = validate_destination_path_with_roots(&bad, &allowed).unwrap_err();
        match err {
            Error::PackageManager(msg) => assert!(msg.contains("contains '..'")),
            other => panic!("expected PackageManager, got {:?}", other),
        }

        // outside roots rejected
        let outside = std::env::temp_dir().join("outside_root_test.bin");
        let err = validate_destination_path_with_roots(&outside, &allowed).unwrap_err();
        match err {
            Error::PackageManager(msg) => assert!(msg.contains("inside the app data/cache/config")),
            other => panic!("expected PackageManager, got {:?}", other),
        }

        // inside root ok
        let ok = root.join("ok.bin");
        validate_destination_path_with_roots(&ok, &allowed).unwrap();

        cleanup_dir(&root);
    }

    #[test]
    fn file_exists_and_metadata_work_for_file_and_dir() {
        let dir = tmp_dir("file_exists_and_metadata_work_for_file_and_dir");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();

        // file_exists is trivial, but still useful to cover
        assert!(Path::new(&file).exists());

        let md = std::fs::metadata(&file).unwrap();
        assert!(md.is_file());
        assert_eq!(md.len(), 5);

        let md_dir = std::fs::metadata(&dir).unwrap();
        assert!(md_dir.is_dir());

        cleanup_dir(&dir);
    }

    #[test]
    fn unzip_file_extracts_normal_file() {
        let dir = tmp_dir("unzip_file_extracts_normal_file");
        let zip_path = dir.join("t.zip");
        let out_dir = dir.join("out");

        // Create zip with one file
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("ok.txt", opts).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }

        unzip_file_from_path(&out_dir, &zip_path).unwrap();
        let extracted = out_dir.join("ok.txt");
        assert!(extracted.exists());
        assert_eq!(std::fs::read(&extracted).unwrap(), b"hello");

        cleanup_dir(&dir);
    }

    #[test]
    fn unzip_file_rejects_traversal_entry() {
        let dir = tmp_dir("unzip_file_rejects_traversal_entry");
        let zip_path = dir.join("bad.zip");
        let out_dir = dir.join("out");

        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("../evil.txt", opts).unwrap();
            zip.write_all(b"nope").unwrap();
            zip.finish().unwrap();
        }

        let err = unzip_file_from_path(&out_dir, &zip_path).unwrap_err();
        match err {
            Error::PackageManager(msg) => assert!(msg.contains("Invalid file path in archive")),
            other => panic!("expected PackageManager, got {:?}", other),
        }

        cleanup_dir(&dir);
    }

    #[test]
    fn extract_tar_extracts_normal_file() {
        let dir = tmp_dir("extract_tar_extracts_normal_file");
        let tar_path = dir.join("t.tar");
        let out_dir = dir.join("out");

        // Create tar with one file
        {
            let f = std::fs::File::create(&tar_path).unwrap();
            let mut tar = tar::Builder::new(f);

            let mut header = tar::Header::new_gnu();
            header.set_path("ok.txt").unwrap();
            header.set_size(5);
            header.set_cksum();

            tar.append(&header, &b"hello"[..]).unwrap();
            tar.finish().unwrap();
        }

        extract_tar_file_from_path(&out_dir, &tar_path, false).unwrap();
        let extracted = out_dir.join("ok.txt");
        assert!(extracted.exists());
        assert_eq!(std::fs::read(&extracted).unwrap(), b"hello");

        cleanup_dir(&dir);
    }

    #[test]
    fn extract_tar_rejects_traversal_entry() {
        let dir = tmp_dir("extract_tar_rejects_traversal_entry");
        let tar_path = dir.join("bad.tar");
        let out_dir = dir.join("out");
        let outside = dir.join("evil.txt");
    
        // Craft a minimal tar file manually with a traversal entry: "../evil.txt"
        {
            fn write_octal(field: &mut [u8], value: u64) {
                let width = field.len().saturating_sub(1);
                let s = format!("{:0width$o}", value, width = width);
                field.fill(0);
                field[..width].copy_from_slice(s.as_bytes());
                field[width] = 0;
            }
    
            let mut header = [0u8; 512];
    
            // name (0..100)
            let name = b"../evil.txt";
            header[..name.len()].copy_from_slice(name);
    
            // mode (100..108), uid (108..116), gid (116..124)
            write_octal(&mut header[100..108], 0o644);
            write_octal(&mut header[108..116], 0);
            write_octal(&mut header[116..124], 0);
    
            // size (124..136), mtime (136..148)
            let payload = b"nope";
            write_octal(&mut header[124..136], payload.len() as u64);
            write_octal(&mut header[136..148], 0);
    
            // checksum field (148..156) must be spaces while computing checksum
            header[148..156].fill(b' ');
    
            // typeflag (156) = '0' for regular file
            header[156] = b'0';
    
            // magic/version for ustar
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
    
            // compute checksum
            let chksum: u32 = header.iter().map(|b| *b as u32).sum();
    
            // write checksum as 6 digits, NUL, space (tar convention)
            let chk = format!("{:06o}\0 ", chksum);
            header[148..156].copy_from_slice(chk.as_bytes());
    
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&header);
            bytes.extend_from_slice(payload);
    
            // pad file contents to 512 boundary
            bytes.resize(((bytes.len() + 511) / 512) * 512, 0);
    
            // two 512-byte zero blocks mark end of archive
            bytes.extend_from_slice(&[0u8; 1024]);
    
            std::fs::write(&tar_path, bytes).unwrap();
        }
    
        let res = extract_tar_file_from_path(&out_dir, &tar_path, false);
    
        assert!(
            !outside.exists(),
            "Path traversal detected: wrote outside destination: {}",
            outside.display()
        );
    
        if res.is_ok() {
            let inside = out_dir.join("evil.txt");
            let _ = inside;
        }
    
        cleanup_dir(&dir);
    }
    

    #[test]
    fn set_file_as_executable_errors_for_missing_and_dir() {
        tauri::async_runtime::block_on(async {
            let dir = tmp_dir("set_file_as_executable_errors_for_missing_and_dir");

            let missing = dir.join("missing.bin");
            let err = set_file_as_executable(missing.to_string_lossy().to_string())
                .await
                .unwrap_err();
            match err {
                Error::PackageManager(msg) => assert!(msg.contains("does not exist")),
                other => panic!("expected PackageManager, got {:?}", other),
            }

            let err = set_file_as_executable(dir.to_string_lossy().to_string())
                .await
                .unwrap_err();
            match err {
                Error::PackageManager(msg) => assert!(msg.contains("Not a file")),
                other => panic!("expected PackageManager, got {:?}", other),
            }

            cleanup_dir(&dir);
        });
    }

    #[test]
    fn set_file_as_executable_ok_for_file() {
        tauri::async_runtime::block_on(async {
            let dir = tmp_dir("set_file_as_executable_ok_for_file");
            let file = dir.join("x.bin");
            std::fs::write(&file, b"x").unwrap();

            set_file_as_executable(file.to_string_lossy().to_string())
                .await
                .unwrap();

            #[cfg(unix)]
            {
                let md = std::fs::metadata(&file).unwrap();
                let mode = md.permissions().mode() & 0o777;
                assert_eq!(mode, 0o755);
            }

            cleanup_dir(&dir);
        });
    }
}
