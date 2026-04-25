use std::path::PathBuf;

use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::fs;

use crate::error::{Error, Result};

const TAB_STATE_DIR: &str = "tab_state";
const TAB_STATE_FILE_EXTENSION: &str = "json";
const TAB_STATE_MAX_BYTES: usize = 16 * 1024 * 1024;

fn validate_tab_id(tab_id: &str) -> Result<&str> {
    let trimmed = tab_id.trim();
    if trimmed.is_empty() {
        return Err(Error::InvalidInput("tab_id cannot be empty".to_string()));
    }

    if trimmed.len() > 128 {
        return Err(Error::InvalidInput(
            "tab_id is too long (max: 128 chars)".to_string(),
        ));
    }

    let is_valid = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if !is_valid {
        return Err(Error::InvalidInput(
            "tab_id contains invalid characters".to_string(),
        ));
    }

    Ok(trimmed)
}

fn resolve_tab_state_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .resolve(TAB_STATE_DIR, BaseDirectory::AppData)
        .map_err(|e| Error::PackageManager(format!("Failed to resolve tab_state directory: {}", e)))
}

fn resolve_tab_state_file(app: &AppHandle, tab_id: &str) -> Result<PathBuf> {
    let normalized = validate_tab_id(tab_id)?;
    let dir = resolve_tab_state_dir(app)?;
    Ok(dir.join(format!("{}.{}", normalized, TAB_STATE_FILE_EXTENSION)))
}

#[tauri::command]
#[specta::specta]
pub async fn tab_state_write(app: AppHandle, tab_id: String, value: String) -> Result<()> {
    if value.as_bytes().len() > TAB_STATE_MAX_BYTES {
        return Err(Error::InvalidInput(format!(
            "Tab state too large (max {} bytes)",
            TAB_STATE_MAX_BYTES
        )));
    }

    let dir = resolve_tab_state_dir(&app)?;
    fs::create_dir_all(&dir).await?;

    let file_path = resolve_tab_state_file(&app, &tab_id)?;
    let tmp_path = file_path.with_extension("tmp");

    fs::write(&tmp_path, value).await?;

    if file_path.exists() {
        match fs::remove_file(&file_path).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = fs::remove_file(&tmp_path).await;
                return Err(error.into());
            }
        }
    }

    if let Err(error) = fs::rename(&tmp_path, &file_path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(error.into());
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn tab_state_read(app: AppHandle, tab_id: String) -> Result<Option<String>> {
    let file_path = resolve_tab_state_file(&app, &tab_id)?;
    match fs::read_to_string(&file_path).await {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn tab_state_remove(app: AppHandle, tab_id: String) -> Result<()> {
    let file_path = resolve_tab_state_file(&app, &tab_id)?;
    match fs::remove_file(&file_path).await {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn tab_state_clear_all(app: AppHandle) -> Result<()> {
    let dir = resolve_tab_state_dir(&app)?;
    if !dir.exists() {
        return Ok(());
    }

    let mut entries = fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let is_tab_state_file = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case(TAB_STATE_FILE_EXTENSION))
            .unwrap_or(false);

        if !is_tab_state_file {
            continue;
        }

        match fs::remove_file(&path).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_tab_id_accepts_valid_values() {
        assert_eq!(validate_tab_id("abc123").unwrap(), "abc123");
        assert_eq!(validate_tab_id("A_B-C").unwrap(), "A_B-C");
    }

    #[test]
    fn validate_tab_id_rejects_invalid_values() {
        assert!(validate_tab_id("").is_err());
        assert!(validate_tab_id("   ").is_err());
        assert!(validate_tab_id("../bad").is_err());
        assert!(validate_tab_id("bad/name").is_err());
    }
}
