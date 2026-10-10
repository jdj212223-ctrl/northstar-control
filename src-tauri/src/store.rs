use crate::util::config_dir;
use std::path::PathBuf;

const SERVICE: &str = "io.github.jdj212223.northstar-control";

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|error| error.to_string())
}

pub fn get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|error| error.to_string())
}

pub fn delete(name: &str) {
    if let Ok(item) = entry(name) {
        let _ = item.delete_credential();
    }
}

// True when the OS credential store accepts a write and read-back.
pub fn available() -> bool {
    let probe = "availability-probe";
    if set(probe, "ok").is_err() {
        return false;
    }
    let ok = get(probe).as_deref() == Some("ok");
    delete(probe);
    ok
}

pub fn config_path(file: &str) -> PathBuf {
    config_dir().join(file)
}

pub fn read_config(file: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(config_path(file)).ok()?).ok()
}

pub fn write_config(file: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = config_path(file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, format!("{value}\n")).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
}
