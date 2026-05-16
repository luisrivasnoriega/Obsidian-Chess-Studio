/// Linux-specific platform initialization and configuration
#[cfg(target_os = "linux")]
pub fn init_linux_platform() -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}
