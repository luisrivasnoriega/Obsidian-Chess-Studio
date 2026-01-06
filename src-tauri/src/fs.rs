use std::path::{Path, PathBuf};

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

        // Progress for download phase (0-50%)
        let progress = content_length
            .map(|total| ((downloaded as f64 / total as f64) * 50.0).min(50.0) as f32)
            .unwrap_or(-1.0);

        emit_progress(app, id, progress, false)?;
    }

    info!(
        "Downloaded {} bytes, starting extraction to {}",
        downloaded,
        path.display()
    );

    emit_progress(app, id, 50.0, false)?;

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
    use std::io::Read;

    std::fs::create_dir_all(dest_dir)?;
    let base_path = dest_dir.canonicalize()?;

    let file = std::fs::File::open(archive_path)?;
    let reader: Box<dyn Read> = if is_gz {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };

    let mut archive = tar::Archive::new(reader);
    archive.set_overwrite(true);
    archive.set_preserve_permissions(true);

    // Extract safely: `Entry::unpack_in` prevents path traversal.
    for entry in archive.entries()? {
        let mut entry = entry?;
        entry.unpack_in(&base_path)?;
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
