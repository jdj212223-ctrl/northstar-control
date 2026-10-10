use crate::util::*;
use futures_util::StreamExt;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub const RELEASE_API: &str = "https://api.github.com/repos/jdj212223-ctrl/northstar-control/releases/latest";
pub const RELEASE_PREFIX: &str = "https://github.com/jdj212223-ctrl/northstar-control/releases/";
pub const DOWNLOAD_PREFIX: &str = "https://github.com/jdj212223-ctrl/northstar-control/releases/download/";
const MAX_BYTES: u64 = 600 * 1024 * 1024;

pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |text: &str| semver::Version::parse(text.trim().trim_start_matches('v')).ok();
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

pub fn parse_release(release: &Json, current: &str) -> Option<(String, String, Vec<Json>)> {
    if release["draft"] == true || release["prerelease"] == true {
        return None;
    }
    let version = release["tag_name"].as_str()?.trim_start_matches('v').to_string();
    if !is_newer(&version, current) {
        return None;
    }
    let url = release["html_url"].as_str()?.to_string();
    if !url.starts_with(RELEASE_PREFIX) {
        return None;
    }
    let assets = release["assets"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|asset| {
                    Some(json!({
                        "name": asset["name"].as_str()?,
                        "url": asset["browser_download_url"].as_str()?,
                        "digest": asset["digest"].as_str().unwrap_or(""),
                        "size": asset["size"].as_u64().unwrap_or(0)
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Some((version, url, assets))
}

pub type ChangeHook = Arc<dyn Fn(Json) + Send + Sync>;

pub struct Updater {
    state: Mutex<Json>,
    http: reqwest::Client,
    on_change: ChangeHook,
    installing: Mutex<bool>,
}

impl Updater {
    pub fn new(current_version: &str, on_change: ChangeHook) -> Arc<Self> {
        Arc::new(Updater {
            state: Mutex::new(json!({
                "available": false, "checking": false, "currentVersion": current_version,
                "version": null, "url": null, "assets": [], "error": null
            })),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("Northstar-Control")
                .build()
                .expect("http client"),
            on_change,
            installing: Mutex::new(false),
        })
    }

    pub async fn get_state(&self) -> Json {
        self.state.lock().await.clone()
    }

    pub async fn check(&self) -> Json {
        let current = {
            let mut state = self.state.lock().await;
            state["checking"] = json!(true);
            state["error"] = Json::Null;
            state["currentVersion"].as_str().unwrap_or("0.0.0").to_string()
        };
        let outcome = async {
            let response = self
                .http
                .get(RELEASE_API)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("GitHub returned {}", response.status().as_u16()));
            }
            response.json::<Json>().await.map_err(|error| error.to_string())
        }
        .await;
        let snapshot = {
            let mut state = self.state.lock().await;
            state["checking"] = json!(false);
            match outcome {
                Ok(release) => match parse_release(&release, &current) {
                    Some((version, url, assets)) => {
                        state["available"] = json!(true);
                        state["version"] = json!(version);
                        state["url"] = json!(url);
                        state["assets"] = Json::Array(assets);
                    }
                    None => {
                        state["available"] = json!(false);
                        state["version"] = Json::Null;
                        state["url"] = Json::Null;
                        state["assets"] = json!([]);
                    }
                },
                Err(message) => state["error"] = json!(message),
            }
            state.clone()
        };
        (self.on_change)(snapshot.clone());
        snapshot
    }

    pub async fn release_url(&self) -> Option<String> {
        self.state.lock().await["url"].as_str().filter(|url| url.starts_with(RELEASE_PREFIX)).map(str::to_string)
    }

    pub async fn install(&self, quit: Box<dyn FnOnce() + Send>) -> Json {
        let state = self.get_state().await;
        if state["available"] != true {
            return json!({"ok": false, "message": "No update to install."});
        }
        {
            let mut busy = self.installing.lock().await;
            if *busy {
                return json!({"ok": false, "message": "No update to install."});
            }
            *busy = true;
        }
        let assets = state["assets"].as_array().cloned().unwrap_or_default();
        let result = install_assets(&self.http, &assets, quit).await;
        let mut manual = false;
        let reply = match result {
            Ok(value) => {
                manual = value["manual"] == true;
                if value["ok"] != true {
                    *self.installing.lock().await = false;
                }
                value
            }
            Err(message) => {
                *self.installing.lock().await = false;
                json!({"ok": false, "message": message})
            }
        };
        if manual {
            if let Some(url) = self.release_url().await {
                open_https(&url);
            }
        }
        reply
    }
}

pub fn pick_asset(assets: &[Json], platform: &str, appimage: bool, arch: &str) -> Option<Json> {
    let candidates = assets.iter().filter(|asset| {
        asset["url"].as_str().map(|url| url.starts_with(DOWNLOAD_PREFIX)).unwrap_or(false)
    });
    let name = |asset: &&Json| asset["name"].as_str().unwrap_or("").to_string();
    match platform {
        "windows" => candidates
            .filter(|asset| {
                let n = name(asset);
                n.starts_with("Northstar.Control.Setup.") && n.ends_with(".exe")
            })
            .next()
            .cloned(),
        "macos" => candidates.filter(|asset| name(asset).ends_with("-universal-mac.zip")).next().cloned(),
        "linux" if appimage => {
            let list: Vec<&Json> = candidates.filter(|asset| name(asset).ends_with(".AppImage")).collect();
            let arm = |asset: &&Json| {
                let n = name(asset).to_lowercase();
                n.contains("arm64") || n.contains("aarch64")
            };
            let wants_arm = arch == "aarch64";
            list.iter().find(|asset| arm(asset) == wants_arm).or(list.first()).map(|asset| (*asset).clone())
        }
        _ => None,
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn download(client: &reqwest::Client, asset: &Json, destination: &Path) -> Result<(), String> {
    let digest = asset["digest"].as_str().unwrap_or("");
    let expected = digest
        .strip_prefix("sha256:")
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("The release has no SHA-256 checksum, so it will not be installed automatically.")?
        .to_lowercase();
    let url = asset["url"].as_str().unwrap_or("");
    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("Unexpected download location.".into());
    }
    let response = client
        .get(url)
        .timeout(Duration::from_secs(1800))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed ({}).", response.status().as_u16()));
    }
    let mut file = std::fs::File::create(destination).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut hasher = Sha256::new();
    let mut bytes: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        bytes += chunk.len() as u64;
        if bytes > MAX_BYTES {
            let _ = std::fs::remove_file(destination);
            return Err("Download is larger than expected.".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|error| error.to_string())?;
    }
    drop(file);
    if hex::encode(hasher.finalize()) != expected {
        let _ = std::fs::remove_file(destination);
        return Err("Downloaded update failed its checksum and was discarded.".into());
    }
    Ok(())
}

pub fn mac_app_path(exe: &str) -> Option<String> {
    let index = exe.find(".app/Contents/MacOS/")?;
    Some(exe[..index + 4].to_string())
}

fn launch_detached(program: &str, args: &[&str]) -> Result<(), String> {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn temp_update_dir() -> Result<PathBuf, String> {
    let mut suffix = [0_u8; 6];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut suffix);
    let dir = std::env::temp_dir().join(format!("northstar-update-{}", hex::encode(suffix)));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

async fn install_assets(client: &reqwest::Client, assets: &[Json], quit: Box<dyn FnOnce() + Send>) -> Result<Json, String> {
    let platform = if is_windows() { "windows" } else if is_mac() { "macos" } else { "linux" };
    let appimage = std::env::var("APPIMAGE").ok().filter(|path| Path::new(path).exists());
    let Some(asset) = pick_asset(assets, platform, appimage.is_some(), std::env::consts::ARCH) else {
        return Ok(json!({"ok": false, "manual": true, "message": "This install type can't update itself. Opening the release page instead."}));
    };
    let dir = temp_update_dir()?;
    let file = dir.join(asset["name"].as_str().unwrap_or("update"));
    download(client, &asset, &file).await?;
    let file_text = file.to_string_lossy().into_owned();

    if is_windows() {
        launch_detached(&file_text, &["/S", "--force-run"])?;
        quit();
        return Ok(json!({"ok": true, "message": "Installing…"}));
    }

    if is_mac() {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let Some(target) = mac_app_path(&exe.to_string_lossy()) else {
            return Ok(json!({"ok": false, "manual": true, "message": "Could not locate the installed app."}));
        };
        let parent = Path::new(&target).parent().map(Path::to_path_buf).unwrap_or_default();
        let probe = parent.join(".northstar-write-test");
        if std::fs::write(&probe, b"").is_err() {
            return Ok(json!({"ok": false, "manual": true, "message": "The app folder isn't writable, so it can't update itself."}));
        }
        let _ = std::fs::remove_file(&probe);
        let extracted = dir.join("extracted");
        std::fs::create_dir_all(&extracted).map_err(|error| error.to_string())?;
        let unzip = run_raw("/usr/bin/ditto", &["-x", "-k", &file_text, &extracted.to_string_lossy()], 120_000).await?;
        if !unzip.success {
            return Err("The update package could not be unpacked.".into());
        }
        let bundle = std::fs::read_dir(&extracted)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.ends_with(".app"))
            .ok_or("The update package did not contain an app.")?;
        let staged = extracted.join(bundle).to_string_lossy().into_owned();
        let script = dir.join("install.sh");
        let backup = format!("{target}.old");
        let lines = [
            "#!/bin/sh".to_string(),
            format!("while kill -0 {} 2>/dev/null; do sleep 0.3; done", std::process::id()),
            format!("BACKUP={}", shell_quote(&backup)),
            "rm -rf \"$BACKUP\"".to_string(),
            format!("mv {} \"$BACKUP\" || exit 1", shell_quote(&target)),
            format!("if /usr/bin/ditto {} {}; then", shell_quote(&staged), shell_quote(&target)),
            format!("  /usr/bin/xattr -cr {}", shell_quote(&target)),
            "  rm -rf \"$BACKUP\"".to_string(),
            "else".to_string(),
            format!("  rm -rf {}; mv \"$BACKUP\" {}", shell_quote(&target), shell_quote(&target)),
            "fi".to_string(),
            format!("/usr/bin/open {}", shell_quote(&target)),
            format!("rm -rf {}", shell_quote(&dir.to_string_lossy())),
        ];
        std::fs::write(&script, lines.join("\n")).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700));
        }
        launch_detached("/bin/sh", &[&script.to_string_lossy()])?;
        quit();
        return Ok(json!({"ok": true, "message": "Installing…"}));
    }

    // Linux AppImage: replace the file in place, then start it.
    let target = appimage.ok_or("Not running from an AppImage.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755));
    }
    let backup = format!("{target}.old");
    std::fs::rename(&target, &backup).map_err(|error| error.to_string())?;
    let copied = std::fs::copy(&file, &target).map(|_| ());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    if let Err(error) = copied {
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::rename(&backup, &target);
        return Err(error.to_string());
    }
    let _ = std::fs::remove_file(&backup);
    launch_detached(&target, &[])?;
    quit();
    Ok(json!({"ok": true, "message": "Installing…"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("2.1.0", "2.0.0"));
        assert!(is_newer("v2.10.0", "2.9.9"));
        assert!(!is_newer("2.0.0", "2.0.0"));
        assert!(!is_newer("garbage", "2.0.0"));
    }

    #[test]
    fn ignores_foreign_release_pages_and_prereleases() {
        let release = json!({"tag_name": "v3.0.0", "html_url": "https://evil.example/x", "assets": []});
        assert!(parse_release(&release, "2.0.0").is_none());
        let pre = json!({"tag_name": "v3.0.0", "prerelease": true, "html_url": format!("{RELEASE_PREFIX}tag/v3.0.0")});
        assert!(parse_release(&pre, "2.0.0").is_none());
    }

    #[test]
    fn picks_only_project_assets() {
        let good = format!("{DOWNLOAD_PREFIX}v2.1.0/Northstar-Control-2.1.0-universal-mac.zip");
        let assets = vec![
            json!({"name": "Northstar-Control-2.1.0-universal-mac.zip", "url": "https://evil.example/a-universal-mac.zip"}),
            json!({"name": "Northstar-Control-2.1.0-universal-mac.zip", "url": good}),
        ];
        assert_eq!(pick_asset(&assets, "macos", false, "aarch64").unwrap()["url"], good);
        assert!(pick_asset(&assets, "linux", false, "x86_64").is_none());
    }

    #[test]
    fn finds_the_app_bundle() {
        assert_eq!(mac_app_path("/Applications/Northstar Control.app/Contents/MacOS/northstar").as_deref(), Some("/Applications/Northstar Control.app"));
        assert!(mac_app_path("/usr/bin/northstar").is_none());
    }
}
