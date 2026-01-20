//! UCI protocol communication utilities for chess engines.
//!
//! This module provides the `UciCommunicator` struct for spawning and communicating with UCI engines
//! using async I/O. Handles stdin/stdout/stderr and line-based protocol.

use log::{error, info};
use std::path::PathBuf;
use std::process::Stdio;
use std::io::ErrorKind;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::error::Error;

#[cfg(unix)]
pub(crate) fn ensure_executable(path: &std::path::Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    if (mode & 0o111) == 0 {
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub(crate) fn validate_android_elf(path: &std::path::Path) -> Result<(), Error> {
    use std::io::Read;

    let mut f = std::fs::File::open(path)?;
    let mut hdr = [0u8; 64];
    let n = f.read(&mut hdr)?;
    if n < 20 {
        return Err(Error::PackageManager(format!(
            "Engine binary is too small to be a valid ELF: {}",
            path.display()
        )));
    }

    if &hdr[0..4] != b"\x7FELF" {
        return Err(Error::PackageManager(format!(
            "Engine binary is not an ELF executable: {}",
            path.display()
        )));
    }

    // EI_CLASS: 2 = 64-bit
    if hdr[4] != 2 {
        return Err(Error::PackageManager(format!(
            "Engine binary is not 64-bit ELF (EI_CLASS={}): {}",
            hdr[4],
            path.display()
        )));
    }

    // e_type at 0x10 (little endian): 2 = ET_EXEC, 3 = ET_DYN
    let e_type = u16::from_le_bytes([hdr[0x10], hdr[0x11]]);
    // e_machine at 0x12 (little endian): 183 = EM_AARCH64
    let e_machine = u16::from_le_bytes([hdr[0x12], hdr[0x13]]);

    if e_machine != 183 {
        return Err(Error::PackageManager(format!(
            "Engine binary architecture mismatch (e_machine={} expected 183/aarch64): {}",
            e_machine,
            path.display()
        )));
    }

    // Historically, Android required PIE for *dynamically linked* executables, but some projects ship
    // fully-static ET_EXEC binaries. Treat both ET_EXEC and ET_DYN as acceptable here and rely on
    // the actual spawn error if the device rejects a specific binary.
    if e_type != 2 && e_type != 3 {
        return Err(Error::PackageManager(format!(
            "Engine binary has an unsupported ELF type (e_type={} expected 2/ET_EXEC or 3/ET_DYN): {}",
            e_type,
            path.display()
        )));
    }

    Ok(())
}

/// Async communicator for a running UCI engine process.
pub struct UciCommunicator {
    #[allow(dead_code)]
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout_lines: Lines<BufReader<ChildStdout>>,
}

impl UciCommunicator {
    /// Spawn a new UCI engine process and set up async I/O.
    ///
    /// # Arguments
    /// * `path` - Path to the engine binary.
    ///
    /// # Returns
    /// `UciCommunicator` with stdin and stdout line reader.
    ///
    /// # Errors
    /// Returns `Error` if process or I/O setup fails.
    pub async fn spawn(path: PathBuf) -> Result<Self, Error> {
        if path.is_dir() {
            return Err(Error::PackageManager(format!(
                "Engine path points to a directory, not a binary: {}",
                path.display()
            )));
        }

        #[cfg(unix)]
        ensure_executable(&path)?;

        #[cfg(target_os = "android")]
        validate_android_elf(&path)?;

        let mut command = Command::new(&path);
        // FIXED: Safe parent path handling to prevent panic
        if let Some(parent) = path.parent() {
            command.current_dir(parent);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        command.creation_flags(super::process::CREATE_NO_WINDOW);

        let mut child = command.spawn().map_err(|e| {
            if e.kind() == ErrorKind::PermissionDenied {
                // Provide a high-signal error. This helps distinguish:
                // - missing +x on the binary
                // - missing +x on a parent directory
                // - true `noexec` mount / policy denial (chmod won't help)
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let file_mode = std::fs::metadata(&path)
                        .map(|m| m.permissions().mode() & 0o777)
                        .unwrap_or(0);
                    let parent_mode = path
                        .parent()
                        .and_then(|p| std::fs::metadata(p).ok().map(|m| m.permissions().mode() & 0o777));
                    return Error::PackageManager(format!(
                        "Failed to start engine (permission denied): {} (file_mode={:o}, parent_mode={}). If this persists after chmod, the device may block execution from this filesystem (noexec/policy).",
                        path.display(),
                        file_mode,
                        parent_mode.map(|m| format!("{:o}", m)).unwrap_or_else(|| "<unknown>".to_string())
                    ));
                }
                #[cfg(not(unix))]
                {
                    return Error::PackageManager(format!(
                        "Failed to start engine (permission denied): {}",
                        path.display()
                    ));
                }
            }
            Error::Io(e)
        })?;
        info!("Starting engine process: {:?}", &path);
        let stdin = child.stdin.take().ok_or(Error::NoStdin)?;
        let stdout = child.stdout.take().ok_or(Error::NoStdout)?;
        let stdout_lines = BufReader::new(stdout).lines();

        // Drain stderr to avoid deadlocks when buffer fills up
        let stderr = child.stderr.take();
        tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    error!("[engine-stderr] {}", line);
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_lines,
        })
    }

    /// Write a line to the engine's stdin (async).
    ///
    /// # Arguments
    /// * `line` - The command string to send (should end with `\n`).
    ///
    /// # Errors
    /// Returns `Error` if writing fails.
    pub async fn write_line(&mut self, line: &str) -> Result<(), Error> {
        // REMOVED: Excessive logging - called hundreds of times per second
        self.stdin.write_all(line.as_bytes()).await?;
        Ok(())
    }
}
