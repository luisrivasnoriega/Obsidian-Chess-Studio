use log::info;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::error::Error;

#[derive(Debug, Type, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageManagerResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
#[specta::specta]
pub async fn check_package_manager_available(manager: String) -> Result<bool, Error> {
    let available = match manager.as_str() {
        "brew" => check_brew_available(),
        "apt" => check_apt_available(),
        "dnf" => check_dnf_available(),
        "pacman" => check_pacman_available(),
        _ => false,
    };
    Ok(available)
}

#[tauri::command]
#[specta::specta]
pub async fn install_package(
    manager: String,
    package_name: String,
) -> Result<PackageManagerResult, Error> {
    info!("Installing package {} using {}", package_name, manager);

    validate_package_name(&package_name)?;

    let result = match manager.as_str() {
        "brew" => install_brew_package(&package_name).await,
        "apt" => install_apt_package(&package_name).await,
        "dnf" => install_dnf_package(&package_name).await,
        "pacman" => install_pacman_package(&package_name).await,
        _ => {
            return Err(Error::PackageManager(
                "Unsupported package manager".to_string(),
            ))
        }
    };

    match result {
        Ok(output) => Ok(PackageManagerResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        }),
        Err(e) => Err(Error::PackageManager(format!(
            "Failed to install package: {}",
            e
        ))),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_package_installed(manager: String, package_name: String) -> Result<bool, Error> {
    validate_package_name(&package_name)?;
    let installed = match manager.as_str() {
        "brew" => check_brew_package_installed(&package_name).await,
        "apt" => check_apt_package_installed(&package_name).await,
        "dnf" => check_dnf_package_installed(&package_name).await,
        "pacman" => check_pacman_package_installed(&package_name).await,
        _ => {
            return Err(Error::PackageManager(
                "Unsupported package manager".to_string(),
            ))
        }
    };

    match installed {
        Ok(result) => Ok(result),
        Err(e) => {
            info!("Error checking package installation: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn find_executable_path(executable_name: String) -> Result<Option<String>, Error> {
    validate_executable_name(&executable_name)?;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("where");
        c.arg(&executable_name);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("which");
        c.arg(&executable_name);
        c
    };

    // NOTE: This is a best-effort helper used by the frontend to discover executables for
    // package-manager installs. On some platforms (notably Android), `which` may not exist.
    // In that case, treat it as "not found" instead of surfacing a hard error to the user.
    let output = match timeout(Duration::from_secs(3), cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(Error::PackageManager(format!("Executable lookup failed: {}", e)));
        }
        Err(_) => return Err(Error::PackageManager("Executable lookup timed out".to_string())),
    };

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

// ============================================================================
// Package-manager implementations
// ============================================================================

// Brew-specific functions
fn check_brew_available() -> bool {
    std::process::Command::new("brew")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn install_brew_package(package: &str) -> Result<std::process::Output, std::io::Error> {
    timeout(
        Duration::from_secs(60 * 10),
        Command::new("brew").args(["install", package]).output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "brew install timed out"))?
}

async fn check_brew_package_installed(package: &str) -> Result<bool, std::io::Error> {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("brew").args(["list", package]).output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "brew list timed out"))??;
    Ok(output.status.success())
}

// APT-specific functions (Debian/Ubuntu)
fn check_apt_available() -> bool {
    std::process::Command::new("apt")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn install_apt_package(package: &str) -> Result<std::process::Output, std::io::Error> {
    // `-n` fails fast if sudo password is required (prevents GUI hang).
    timeout(
        Duration::from_secs(60 * 10),
        Command::new("sudo")
            .args(["-n", "apt", "install", "-y", package])
            .output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "apt install timed out"))?
}

async fn check_apt_package_installed(package: &str) -> Result<bool, std::io::Error> {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("dpkg").args(["-l", package]).output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "dpkg query timed out"))??;
    Ok(output.status.success())
}

// DNF-specific functions (Fedora/RHEL)
fn check_dnf_available() -> bool {
    std::process::Command::new("dnf")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn install_dnf_package(package: &str) -> Result<std::process::Output, std::io::Error> {
    timeout(
        Duration::from_secs(60 * 10),
        Command::new("sudo")
            .args(["-n", "dnf", "install", "-y", package])
            .output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "dnf install timed out"))?
}

async fn check_dnf_package_installed(package: &str) -> Result<bool, std::io::Error> {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("dnf")
            .args(["list", "installed", package])
            .output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "dnf query timed out"))??;
    Ok(output.status.success())
}

// Pacman-specific functions (Arch Linux)
fn check_pacman_available() -> bool {
    std::process::Command::new("pacman")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn install_pacman_package(package: &str) -> Result<std::process::Output, std::io::Error> {
    timeout(
        Duration::from_secs(60 * 10),
        Command::new("sudo")
            .args(["-n", "pacman", "-S", "--noconfirm", package])
            .output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "pacman install timed out"))?
}

async fn check_pacman_package_installed(package: &str) -> Result<bool, std::io::Error> {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("pacman").args(["-Q", package]).output(),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "pacman query timed out"))??;
    Ok(output.status.success())
}

// ============================================================================
// Validation helpers
// ============================================================================

fn validate_package_name(name: &str) -> Result<(), Error> {
    // Avoid passing weird characters into package managers.
    let ok = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'));
    if ok {
        Ok(())
    } else {
        Err(Error::PackageManager("Invalid package name".to_string()))
    }
}

fn validate_executable_name(name: &str) -> Result<(), Error> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(Error::PackageManager("Invalid executable name".to_string()))
    }
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_package_name_accepts_common_chars() {
        for s in ["git", "stockfish", "python3.12", "libstdc++", "foo_bar", "foo-bar", "foo+bar"] {
            validate_package_name(s).unwrap();
        }
    }

    #[test]
    fn validate_package_name_rejects_empty_too_long_or_weird_chars() {
        assert!(validate_package_name("").is_err());

        let long = "a".repeat(129);
        assert!(validate_package_name(&long).is_err());

        for s in ["../evil", "foo bar", "foo;rm", "foo|bar", "foo&bar", "foo@bar", "foo/bar"] {
            assert!(validate_package_name(s).is_err(), "should reject: {}", s);
        }
    }

    #[test]
    fn validate_executable_name_accepts_common_chars() {
        for s in ["git", "stockfish", "python3.12", "foo_bar", "foo-bar", "node"] {
            validate_executable_name(s).unwrap();
        }
    }

    #[test]
    fn validate_executable_name_rejects_plus_slash_spaces_and_empty() {
        assert!(validate_executable_name("").is_err());

        let long = "a".repeat(129);
        assert!(validate_executable_name(&long).is_err());

        // Note: plus is NOT allowed for executable_name in current policy.
        for s in ["foo+bar", "../evil", "foo bar", "foo;rm", "foo/bar"] {
            assert!(validate_executable_name(s).is_err(), "should reject: {}", s);
        }
    }

    #[test]
    fn find_executable_path_rejects_invalid_name_before_running() {
        // This should fail validation without invoking system commands.
        let res = tauri::async_runtime::block_on(find_executable_path("bad name".to_string()));
        assert!(res.is_err());

        match res.unwrap_err() {
            Error::PackageManager(msg) => assert!(msg.contains("Invalid executable name")),
            other => panic!("expected PackageManager error, got {:?}", other),
        }
    }

    #[test]
    fn check_package_manager_available_unknown_is_false() {
        let ok = tauri::async_runtime::block_on(check_package_manager_available(
            "unknown".to_string(),
        ))
        .unwrap();
        assert!(!ok);
    }

    #[test]
    fn check_package_installed_unknown_manager_errors() {
        let res = tauri::async_runtime::block_on(check_package_installed(
            "unknown".to_string(),
            "git".to_string(),
        ));
        assert!(res.is_err());
        match res.unwrap_err() {
            Error::PackageManager(msg) => assert!(msg.contains("Unsupported package manager")),
            other => panic!("expected PackageManager error, got {:?}", other),
        }
    }

    #[test]
    fn install_package_unknown_manager_errors() {
        let res =
            tauri::async_runtime::block_on(install_package("unknown".to_string(), "git".to_string()));
        assert!(res.is_err());
        match res.unwrap_err() {
            Error::PackageManager(msg) => assert!(msg.contains("Unsupported package manager")),
            other => panic!("expected PackageManager error, got {:?}", other),
        }
    }

    #[test]
    fn check_package_installed_invalid_package_name_errors() {
        let res = tauri::async_runtime::block_on(check_package_installed(
            "apt".to_string(),
            "bad name".to_string(),
        ));
        assert!(res.is_err());
        match res.unwrap_err() {
            Error::PackageManager(msg) => assert!(msg.contains("Invalid package name")),
            other => panic!("expected PackageManager error, got {:?}", other),
        }
    }

    #[test]
    fn install_package_invalid_package_name_errors() {
        let res =
            tauri::async_runtime::block_on(install_package("apt".to_string(), "bad name".to_string()));
        assert!(res.is_err());
        match res.unwrap_err() {
            Error::PackageManager(msg) => assert!(msg.contains("Invalid package name")),
            other => panic!("expected PackageManager error, got {:?}", other),
        }
    }

    #[test]
    fn find_executable_path_for_sure_missing_returns_none() {
        // Use a very unlikely executable name so the test is stable across environments.
        let name = format!("definitely_not_installed_{}_x", std::process::id());
        let res = tauri::async_runtime::block_on(find_executable_path(name)).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn check_package_manager_available_does_not_panic_for_known_managers() {
        // We don't assert true/false because CI environments vary.
        for m in ["brew", "apt", "dnf", "pacman"] {
            let _ = tauri::async_runtime::block_on(check_package_manager_available(m.to_string()))
                .unwrap();
        }
    }
}
