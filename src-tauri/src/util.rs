use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

pub type Json = serde_json::Value;

pub struct ConfirmRequest {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub ok_label: String,
}

pub type ConfirmFn =
    Arc<dyn Fn(ConfirmRequest) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Linux"
    }
}

pub fn is_mac() -> bool {
    cfg!(target_os = "macos")
}

pub fn is_windows() -> bool {
    cfg!(target_os = "windows")
}

pub fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

pub fn windows_powershell() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

pub fn windows_powercfg() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    format!("{root}\\System32\\powercfg.exe")
}

pub async fn run_raw(file: &str, args: &[&str], timeout_ms: u64) -> Result<Output, String> {
    let mut command = tokio::process::Command::new(file);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command.spawn().map_err(|error| error.to_string())?;
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|error| error.to_string())?;
    Ok(Output {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub async fn run(file: &str, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let output = run_raw(file, args, timeout_ms).await?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(format!("{file} exited with an error"))
    }
}

pub fn parse_json(text: &str) -> Option<Json> {
    serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()
}

pub fn open_https(url: &str) -> bool {
    if !url.starts_with("https://") {
        return false;
    }
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("/usr/bin/open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    result.is_ok()
}

pub fn config_dir() -> std::path::PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var("APPDATA").map(std::path::PathBuf::from).ok()
    } else if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|home| std::path::PathBuf::from(home).join("Library/Application Support"))
            .ok()
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|_| std::env::var("HOME").map(|home| std::path::PathBuf::from(home).join(".config")))
            .ok()
    };
    base.unwrap_or_else(std::env::temp_dir).join("Northstar Control")
}
